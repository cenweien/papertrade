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

REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", str(5 * 60)))  # 5 min
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", str(60 * 60)))  # 1 hour

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
# Main loop
# -----------------------------------------------------------------------------
def main() -> None:
    log.info(
        "Starting scheduler (refresh=%ds, cleanup=%ds, table=%s)",
        REFRESH_INTERVAL, CLEANUP_INTERVAL, CACHE_TABLE,
    )
    last_cleanup = time.time()
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
