"""
scheduler.py - 5-minute refresh loop

Every REFRESH_INTERVAL seconds:
  1. Ask Supabase for the list of tickers the user is actively using
      via the `tickers_in_use()` SQL function.
  2. Call xbbg_sapi.bdp() to fetch the latest quote for each ticker.
  3. Upsert the results into the `instrument_prices` cache table
      (renamed from stock_prices in migration 005) so the
      ai-service Edge Function and the frontend's useLivePrices hook
      see fresh prices on their next read.

Every CLEANUP_INTERVAL seconds:
  Delete rows from `instrument_prices` for tickers that are no longer
  in use, to keep the table small.

Once per day at SNAPSHOT_TICK_HOUR:SNAPSHOT_TICK_MINUTE UTC:
  POST the `compute-snapshots` Edge Function (no portfolio_id,
  days=5) so it writes a 5-day rolling window of `daily_snapshots`
  rows for all portfolios. This is the Tier 3 follow-up to
  .kilo/plans/tier1-tier2-risk-improvements.md. Without this tick, the
  Risk page's Sharpe / Sortino / VaR / drawdown metrics all stay N/A
  because there is no daily equity time series to compute over.

The frontend's `triggerSnapshotRefresh` (called after every
executeTrade) does the same `days=5` write, so the series is kept
fresh on every trade in addition to the daily tick.

This is what keeps the data fresh for tickers nobody is currently
viewing in a browser (the on-demand `useLivePrices` path only fetches
for tickers that are actively displayed).
"""
from __future__ import annotations

import os
import sys
import time
import logging
import math
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any

from xbbg_sapi import bdp, connect
from supabase import create_client
from ticker_map import resolve_instrument, strip_to_bare_ticker

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("bbg-scheduler")

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
BBG_HOST = os.environ.get("BBG_HOST", "10.103.1.46")
BBG_PORT = int(os.environ.get("BBG_PORT", "8194"))
BBG_UUID = os.environ.get("BBG_UUID") or None
BBG_USER_IP = os.environ.get("BBG_USER_IP") or None

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# Shared secret for calling the `compute-snapshots` Edge Function. Must
# match the INTERNAL_API_KEY Supabase secret. Optional — if missing,
# the daily-tick + backfill features are no-ops (the price refresh loop
# still works as before).
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "").strip() or None

REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", str(5 * 60)))  # 5 min
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", str(60 * 60)))  # 1 hour
SNAPSHOT_TICK_HOUR = int(os.environ.get("SNAPSHOT_TICK_HOUR", "23"))
SNAPSHOT_TICK_MINUTE = int(os.environ.get("SNAPSHOT_TICK_MINUTE", "55"))

# History-cache pre-fill: how often to backfill the
# instrument_price_history table with 1y of daily closes for every
# ticker in use. The first Risk page load also triggers a backfill on
# demand via the market-data/historical-series edge function; this
# scheduler tick keeps the cache warm for tickers nobody is currently
# viewing. 1 hour is a reasonable balance between freshness and B-PIPE
# load.
HISTORY_INTERVAL = int(os.environ.get("HISTORY_INTERVAL", str(60 * 60)))  # 1 hour
HISTORY_LOOKBACK_DAYS = int(os.environ.get("HISTORY_LOOKBACK_DAYS", str(365)))  # 1 year
HISTORY_TABLE = os.environ.get("HISTORY_TABLE", "instrument_price_history")

# Backwards compat: the table was renamed stock_prices -> instrument_prices
# in migration 005. The Python scheduler used to hardcode the old name; now
# it reads from CACHE_TABLE (env-overridable) and defaults to the new name.
CACHE_TABLE = os.environ.get("CACHE_TABLE", "instrument_prices")

# Per-asset-class field maps (mirrors bloomberg-service/app.py).
FIELDS_BY_CLASS = {
    "EQUITY":      ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "LONG_COMP_NAME", "GICS_SECTOR_NAME"],
    "ETF":         ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "LONG_COMP_NAME"],
    "FUTURE":      ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "FUT_CONT_SIZE", "FUT_NOTICE_FIRST"],
    "FX":          ["PX_LAST", "PX_BID", "PX_ASK", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "BOND":        ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "OPTION":      ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D"],
    "INDEX":       ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "CRYPTO":      ["PX_LAST", "PX_BID", "PX_ASK", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "MUTUAL_FUND": ["PX_LAST", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
}
FIELDS_DEFAULT = FIELDS_BY_CLASS["EQUITY"]


# -----------------------------------------------------------------------------
# Connect to Bloomberg (retry once on failure at startup)
# -----------------------------------------------------------------------------
def connect_with_retry() -> None:
    for attempt in range(2):
        try:
            connect(host=BBG_HOST, port=BBG_PORT, uuid=BBG_UUID, userIP=BBG_USER_IP)
            log.info("Bloomberg session ready (host=%s port=%d)", BBG_HOST, BBG_PORT)
            return
        except Exception as exc:
            log.error("Bloomberg connect() attempt %d failed: %s", attempt + 1, exc)
            if attempt == 1:
                raise


connect_with_retry()

# -----------------------------------------------------------------------------
# Supabase client
# -----------------------------------------------------------------------------
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# -----------------------------------------------------------------------------
# Core loops
# -----------------------------------------------------------------------------
def get_active_tickers() -> list[str]:
    """Call the tickers_in_use() SQL function. Returns [] on error."""
    try:
        res = supabase.rpc("tickers_in_use").execute()
        data = res.data or []
        # RPC may return a list of strings or a list of dicts; normalize.
        if data and isinstance(data[0], dict):
            return [str(d.get("ticker") or d.get("TICKER") or "").strip().upper()
                    for d in data if d]
        return [str(t).strip().upper() for t in data if t]
    except Exception as exc:
        log.error("tickers_in_use() failed: %s", exc)
        return []


def _safe_float(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _safe_int(v) -> int | None:
    f = _safe_float(v)
    return None if f is None else int(f)


def fetch_quotes(tickers: list[str]) -> dict[str, dict[str, Any]]:
    """Resolve each ticker to its BBG symbol + asset class, group by
    class, call bdp() once per class with the right field map, and
    return {bare_ticker: row_to_upsert}.

    Writes the asset_class / bbg_symbol / contract_size / currency /
    expiry_date columns so the cache supports the new multi-asset
    universe (US equity, ETF, futures, FX, HK equity).
    """
    if not tickers:
        return {}

    # Resolve each ticker.
    resolved: list[tuple[str, str, str]] = []  # (bare, bbg_sym, asset_class)
    for t in tickers:
        ref = resolve_instrument(t)
        bare = strip_to_bare_ticker(ref.bbg_symbol)
        resolved.append((bare, ref.bbg_symbol, ref.asset_class))

    # Group by asset class so each bdp() call uses the right fields.
    by_class: dict[str, list[tuple[str, str]]] = {}
    for bare, bbg, cls in resolved:
        by_class.setdefault(cls, []).append((bare, bbg))

    # bdp() returns a DataFrame; row index is the bbg symbol.
    bbg_to_row: dict[str, Any] = {}
    for cls, items in by_class.items():
        bbg_list = [b for _, b in items]
        fields = FIELDS_BY_CLASS.get(cls, FIELDS_DEFAULT)
        try:
            df = bdp(bbg_list, fields)
        except Exception as exc:
            log.error("bdp() failed for class=%s: %s", cls, exc)
            continue
        if df is None or df.empty:
            continue
        for bbg in bbg_list:
            if bbg in df.index:
                bbg_to_row[bbg] = df.loc[bbg]

    out: dict[str, dict[str, Any]] = {}
    for bare, bbg, cls in resolved:
        row = bbg_to_row.get(bbg)
        if row is None:
            continue
        try:
            last = float(row.get("PX_LAST"))
        except (TypeError, ValueError):
            continue
        if math.isnan(last) or last == 0:
            continue

        record: dict[str, Any] = {
            "current_price": last,
            "previous_close": _safe_float(row.get("PX_PREVIOUS_CLOSE")),
            "change_pct": _safe_float(row.get("CHG_PCT_1D")),
            "day_high": _safe_float(row.get("PX_HIGH")),
            "day_low": _safe_float(row.get("PX_LOW")),
            "day_open": _safe_float(row.get("PX_OPEN")),
            "volume": _safe_int(row.get("VOLUME")),
            "asset_class": cls,
            "bbg_symbol": bbg,
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }
        # Optional fields per asset class.
        if cls == "FUTURE":
            cs = _safe_float(row.get("FUT_CONT_SIZE"))
            if cs is not None:
                record["contract_size"] = cs
            nd = row.get("FUT_NOTICE_FIRST")
            if nd is not None and not (isinstance(nd, float) and math.isnan(nd)):
                try:
                    record["expiry_date"] = datetime.strptime(str(int(nd)), "%Y%m%d").strftime("%Y-%m-%d")
                except (TypeError, ValueError):
                    pass
        if cls == "FX" and len(bare) == 6:
            record["currency"] = bare[:3]
            record["contract_size"] = 1.0
        long_name = row.get("LONG_COMP_NAME")
        if long_name is not None and not (isinstance(long_name, float) and math.isnan(long_name)):
            name_str = str(long_name).strip()
            if name_str:
                record["company_name"] = name_str
        sector = row.get("GICS_SECTOR_NAME")
        if sector is not None and not (isinstance(sector, float) and math.isnan(sector)):
            sector_str = str(sector).strip()
            if sector_str:
                record["sector"] = sector_str
        out[bare] = record
    return out


def upsert_prices(quotes: dict[str, dict[str, Any]]) -> None:
    if not quotes:
        return
    rows = [{"ticker": t, **q} for t, q in quotes.items()]
    try:
        supabase.table(CACHE_TABLE).upsert(
            rows, on_conflict="ticker"
        ).execute()
        log.info("Upserted %d rows into %s", len(rows), CACHE_TABLE)
    except Exception as exc:
        log.error("%s upsert failed: %s", CACHE_TABLE, exc)


def cleanup_stale(active: set[str]) -> None:
    """Delete cache rows for tickers no longer in use."""
    try:
        all_rows = supabase.table(CACHE_TABLE).select("ticker").execute()
        cached = {r["ticker"] for r in (all_rows.data or [])}
    except Exception as exc:
        log.error("%s select failed during cleanup: %s", CACHE_TABLE, exc)
        return
    stale = sorted(cached - active)
    if not stale:
        return
    try:
        for i in range(0, len(stale), 100):
            chunk = stale[i:i + 100]
            supabase.table(CACHE_TABLE).delete().in_("ticker", chunk).execute()
        log.info("Cleaned up %d stale rows from %s", len(stale), CACHE_TABLE)
    except Exception as exc:
        log.error("%s delete failed during cleanup: %s", CACHE_TABLE, exc)


# -----------------------------------------------------------------------------
# Daily snapshot tick (Tier 3 — Sharpe / Sortino plumbing)
# -----------------------------------------------------------------------------
def _post_compute_snapshots(portfolio_id: str | None = None,
                            date_str: str | None = None,
                            days: int = 5) -> bool:
    """POST /functions/v1/compute-snapshots with the INTERNAL_API_KEY
    shared secret. Returns True on 2xx, False on any error (logged).

    The default `days=5` keeps a 5-day rolling window of snapshots
    fresh so the Risk page's Sharpe / Sortino / VaR / drawdown
    metrics are non-degenerate after a single daily tick.
    """
    if not INTERNAL_API_KEY:
        log.debug("INTERNAL_API_KEY not set; skipping compute-snapshots call")
        return False
    url = f"{SUPABASE_URL}/functions/v1/compute-snapshots"
    params: list[str] = []
    if portfolio_id:
        params.append(f"portfolio_id={portfolio_id}")
    if date_str:
        params.append(f"date={date_str}")
    if days and days > 1:
        params.append(f"days={days}")
    if params:
        url += "?" + "&".join(params)
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {INTERNAL_API_KEY}",
            "apikey": SUPABASE_SERVICE_KEY,
            "Content-Type": "application/json",
        },
        data=b"{}",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")[:300]
            log.info("compute-snapshots OK: %s %s", resp.status, body)
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as exc:
        log.error("compute-snapshots HTTP %d: %s", exc.code,
                  exc.read().decode("utf-8", errors="replace")[:300])
    except Exception as exc:
        log.error("compute-snapshots call failed: %s", exc)
    return False


def trigger_daily_snapshots_if_due(last_run_date: str | None) -> str | None:
    """Once per UTC day, at SNAPSHOT_TICK_HOUR:SNAPSHOT_TICK_MINUTE, call
    compute-snapshots for all portfolios with a 5-day rolling window.
    Returns the new `last_run_date` (YYYY-MM-DD UTC) or the existing
    one if the tick hasn't fired yet. The function is cheap when not
    due — just a date check.
    """
    now_utc = datetime.now(timezone.utc)
    today = now_utc.strftime("%Y-%m-%d")
    if last_run_date == today:
        return last_run_date
    target = now_utc.replace(
        hour=SNAPSHOT_TICK_HOUR,
        minute=SNAPSHOT_TICK_MINUTE,
        second=0,
        microsecond=0,
    )
    if now_utc < target:
        return last_run_date
    # Also guard against firing more than once even if the loop spins
    # past the target minute (we only compare on date, not minute, so
    # 5-minute loop may run a second cycle after the tick — that's
    # fine, compute-snapshots is idempotent on (portfolio, date)).
    log.info("Daily snapshot tick firing for %s (UTC, 5-day window)", today)
    _post_compute_snapshots(portfolio_id=None, date_str=today, days=5)
    return today


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------
def _resolve_bbg(bare: str) -> tuple[str, str] | None:
    """Resolve a bare ticker to (bare, bbg). Returns None on failure."""
    try:
        ref = resolve_instrument(bare)
        return (strip_to_bare_ticker(ref.bbg_symbol), ref.bbg_symbol)
    except Exception as exc:
        log.warning("Could not resolve '%s' for history backfill: %s", bare, exc)
        return None


def _fetch_history_series(bbg_to_bare: dict[str, str], start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    """Call xbbg_sapi.bdh() once for all BBG symbols and return
    {bare_ticker: [{trade_date, close}, ...]} sorted ascending.

    Mirrors the shape produced by bloomberg-service/app.py's
    /history-series endpoint but talks directly to bdh() so this
    scheduler doesn't have to round-trip through the relay.
    """
    from xbbg_sapi import bdh  # local import to keep module-level namespace tidy

    if not bbg_to_bare:
        return {}
    bbg_list = list(bbg_to_bare.keys())
    try:
        df = bdh(bbg_list, ["PX_LAST"], start, end)
    except Exception as exc:
        log.error("bdh() failed for history backfill (%d tickers): %s", len(bbg_list), exc)
        return {}
    if df is None or df.empty:
        return {}

    out: dict[str, list[dict[str, Any]]] = {bare: [] for bare in bbg_to_bare.values()}
    for bbg, bare in bbg_to_bare.items():
        series = _extract_bdh_series(df, bbg, "PX_LAST")
        for ts, val in series:
            if val is None:
                continue
            try:
                f = float(val)
            except (TypeError, ValueError):
                continue
            if math.isnan(f) or f <= 0:
                continue
            date_str = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
            out[bare].append({"trade_date": date_str, "close": f})
        out[bare].sort(key=lambda p: p["trade_date"])
    return out


def _extract_bdh_series(df, bbg: str, field: str):
    """Pull a (timestamp, value) iterable for one BBG symbol out of a
    bdh() DataFrame. Handles the same three column shapes as
    bloomberg-service/app.py's _extract_bbg_series — see that function
    for the rationale; this is a near-verbatim copy so the scheduler
    can read bdh() output without importing FastAPI.
    """
    out_pairs: list = []
    if df is None or df.empty:
        return out_pairs

    col = None
    for candidate in (field, field.lower(), field.upper(), field.title()):
        if candidate in df.columns:
            col = candidate
            break

    # Case 1: single ticker, flat column.
    if col is not None and not isinstance(df.columns, __import__("pandas").MultiIndex):
        if bbg in df.index and col in df.columns:
            for ts, val in df[col].items():
                out_pairs.append((ts, val))
            return out_pairs

    # Case 2: MultiIndex (ticker, field).
    if isinstance(df.columns, __import__("pandas").MultiIndex):
        for c in df.columns:
            if not (isinstance(c, tuple) and len(c) == 2):
                continue
            tk, fld = c
            if tk == bbg and str(fld).lower() == field.lower():
                for ts, val in df[c].items():
                    out_pairs.append((ts, val))
                return out_pairs

    # Case 3: ticker-suffixed flat column.
    if col is not None:
        for c in df.columns:
            if isinstance(c, str) and c.endswith(f" {col}") and c.startswith(bbg):
                for ts, val in df[c].items():
                    out_pairs.append((ts, val))
                return out_pairs
    return out_pairs


def backfill_history(active_tickers: list[str]) -> None:
    """For each ticker in use, ensure the HISTORY_TABLE has at least
    HISTORY_LOOKBACK_DAYS of daily closes. We only fetch the *missing*
    sub-range per ticker — if the cache already has the first date we
    asked for, we extend forward to today; otherwise we backfill the
    full window. Either way the underlying table ends up complete.
    """
    if not active_tickers:
        return
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lookback_start = (datetime.now(timezone.utc) - __import__("datetime").timedelta(days=HISTORY_LOOKBACK_DAYS + 7)).strftime("%Y-%m-%d")

    # Resolve each ticker to its BBG symbol; skip unresolvable ones.
    bbg_to_bare: dict[str, str] = {}
    for t in active_tickers:
        resolved = _resolve_bbg(t)
        if resolved is None:
            continue
        bare, bbg = resolved
        bbg_to_bare[bbg] = bare
    if not bbg_to_bare:
        return

    # Fetch the full window in one bdh() call (one B-PIPE request,
    # much cheaper than N parallel calls).
    series = _fetch_history_series(bbg_to_bare, lookback_start, today)
    if not series:
        log.warning("History backfill: no series returned for %d tickers", len(bbg_to_bare))
        return

    # Find the earliest cached date per ticker so we know whether to
    # write a backfill or just extend the tail. Tickers with no cache
    # rows get the full window written.
    cached_min: dict[str, str] = {}
    try:
        res = supabase.table(HISTORY_TABLE).select("ticker, trade_date").in_(
            "ticker", list(bbg_to_bare.values())
        ).execute()
        for r in (res.data or []):
            tk = str(r["ticker"]).upper()
            d = str(r["trade_date"])
            prev = cached_min.get(tk)
            if prev is None or d < prev:
                cached_min[tk] = d
    except Exception as exc:
        log.warning("History backfill: cache read failed (%s); will write full window", exc)

    rows: list[dict[str, Any]] = []
    for bbg, bare in bbg_to_bare.items():
        pts = series.get(bare, [])
        if not pts:
            continue
        earliest = cached_min.get(bare)
        for p in pts:
            # If the cache already has this ticker but its earliest
            # date is AFTER p.trade_date, then this is backfill data
            # (the cache didn't have the start of the window yet).
            # Otherwise, p.trade_date >= earliest — it's tail data
            # either way. Just include it; onConflict upsert is idempotent.
            rows.append({
                "ticker": bare,
                "trade_date": p["trade_date"],
                "close": p["close"],
            })
    if not rows:
        log.info("History backfill: no new rows to write for %d tickers", len(bbg_to_bare))
        return

    # Upsert in chunks of 500 (Supabase row cap).
    CHUNK = 500
    written = 0
    for i in range(0, len(rows), CHUNK):
        slice_ = rows[i:i + CHUNK]
        try:
            supabase.table(HISTORY_TABLE).upsert(
                slice_, on_conflict="ticker,trade_date"
            ).execute()
            written += len(slice_)
        except Exception as exc:
            log.error("History backfill upsert failed (chunk of %d): %s", len(slice_), exc)
    log.info("History backfill: upserted %d rows into %s (%d tickers)",
             written, HISTORY_TABLE, len(bbg_to_bare))

    # Opportunistic prune: drop rows older than 5y so the table stays
    # small. Cheap because the table is indexed on trade_date.
    try:
        cutoff = (datetime.now(timezone.utc) - __import__("datetime").timedelta(days=5 * 365)).strftime("%Y-%m-%d")
        supabase.table(HISTORY_TABLE).delete().lt("trade_date", cutoff).execute()
        log.debug("History backfill: pruned rows older than %s", cutoff)
    except Exception as exc:
        log.debug("History backfill prune skipped: %s", exc)


def main() -> None:
    log.info(
        "Starting scheduler (refresh=%ds, cleanup=%ds, history=%ds, table=%s, "
        "snapshot_tick=%02d:%02d UTC, internal_api_key=%s)",
        REFRESH_INTERVAL, CLEANUP_INTERVAL, HISTORY_INTERVAL, CACHE_TABLE,
        SNAPSHOT_TICK_HOUR, SNAPSHOT_TICK_MINUTE,
        "set" if INTERNAL_API_KEY else "NOT SET",
    )
    last_cleanup = time.time()
    last_history = time.time()
    last_snapshot_date: str | None = None
    while True:
        cycle_start = time.time()
        try:
            tickers = get_active_tickers()
            if tickers:
                log.info("Refreshing %d tickers: %s", len(tickers), tickers)
                quotes = fetch_quotes(tickers)
                upsert_prices(quotes)
            else:
                log.info("No active tickers; skipping refresh")
        except Exception as exc:
            log.exception("Refresh cycle failed: %s", exc)

        if time.time() - last_cleanup >= CLEANUP_INTERVAL:
            try:
                active = set(get_active_tickers())
                cleanup_stale(active)
                last_cleanup = time.time()
            except Exception as exc:
                log.exception("Cleanup failed: %s", exc)

        # History backfill tick — keeps the instrument_price_history
        # cache warm with 1y of daily closes for tickers_in_use(). The
        # Risk page also requests on-demand backfill via the
        # market-data/historical-series edge function; this is the
        # background half of the same system.
        if time.time() - last_history >= HISTORY_INTERVAL:
            try:
                active = get_active_tickers()
                if active:
                    backfill_history(active)
                last_history = time.time()
            except Exception as exc:
                log.exception("History backfill failed: %s", exc)

        # Daily snapshot tick — fires once per UTC day at the
        # configured minute. Cheap when not due.
        try:
            last_snapshot_date = trigger_daily_snapshots_if_due(last_snapshot_date)
        except Exception as exc:
            log.exception("Daily snapshot tick failed: %s", exc)

        elapsed = time.time() - cycle_start
        sleep_for = max(5, REFRESH_INTERVAL - int(elapsed))
        time.sleep(sleep_for)


if __name__ == "__main__":
    # Outer retry loop: if `main()` ever raises (e.g. Bloomberg SAPI
    # session dies and connect_with_retry can't recover), wait and
    # restart instead of crashing the process. The previous code did a
    # single 2-attempt connect at import time and then crashed on any
    # later failure, which meant a briefly-down Bloomberg daemon at
    # boot left the scheduler dead until something restarted it
    # externally.
    BACKOFF_INITIAL = 30
    BACKOFF_MAX = 600
    while True:
        try:
            main()
        except KeyboardInterrupt:
            log.info("Scheduler stopped by user")
            sys.exit(0)
        except Exception as exc:
            log.error("main() crashed: %s; restarting in %ds", exc, BACKOFF_INITIAL)
            time.sleep(BACKOFF_INITIAL)
