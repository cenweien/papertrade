"""
app.py - Bloomberg Relay Service

FastAPI HTTP wrapper around the `xbbg_sapi` package. The Supabase
`market-data` Edge Function (Deno) calls this service instead of hitting
Finnhub directly, so the frontend sees the same JSON contract and zero
frontend code changes are required.

Endpoints
---------
GET  /quote?ticker=AAPL&asset_class=EQUITY   -> current quote
GET  /quotes?tickers=AAPL,TSLA                -> batched quotes
POST /refresh?ticker=AAPL                     -> force-refresh a ticker
GET  /search?q=apple                          -> ticker search (uses bds)
GET  /historical?ticker=AAPL&date=2026-06-09  -> historical close
GET  /history-series?tickers=AAPL,MSFT&start=2025-06-22&end=2026-06-22
                                          -> multi-day, multi-ticker history
GET  /resolve?ticker=ES1                      -> asset-class + bbg symbol
GET  /healthz                                 -> liveness check (no Bloomberg call)

Auth
----
All endpoints except /healthz require the X-API-Key header to match the
RELAY_API_KEY env var. The Supabase Edge Function is configured with the
same value via `supabase secrets set BLOOMBERG_RELAY_KEY=...`.
"""
from __future__ import annotations

# Load .env BEFORE any other import reads os.environ, so RELAY_API_KEY
# etc. are available at module import time (the safety check below
# runs at import time, not inside a function).
from dotenv import load_dotenv
load_dotenv()

import os
import logging
import re
import threading
from datetime import date as date_type, datetime, timedelta, timezone
from typing import Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Header, Depends
from pydantic import BaseModel

from xbbg_sapi import bdp, bdh, connect
from ticker_map import (
    resolve_instrument,
    strip_to_bare_ticker,
    InstrumentRef,
)

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("bloomberg-relay")

# -----------------------------------------------------------------------------
# Bloomberg session lock
# -----------------------------------------------------------------------------
# `xbbg_sapi` wraps blpapi's synchronous session, which is a process-global
# singleton. The wheel's `bdp()` flushes pending events before sending and
# then drains the response synchronously. If two HTTP requests hit
# `bdp()` concurrently from FastAPI's threadpool, thread B's flush
# drains thread A's pending events, and both responses come back
# incomplete (manifesting as "Empty quote for X" 404s even though
# Bloomberg has the data). Serialise every Bloomberg call through this
# lock. There is no real concurrency to lose: the underlying SAPI session
# is single-threaded and a `bdp()` call takes ~400ms anyway.
_BBG_LOCK = threading.Lock()


def _bdp(tickers, flds, **kwargs):
    """Thread-safe wrapper around xbbg_sapi.bdp()."""
    with _BBG_LOCK:
        return bdp(tickers, flds, **kwargs)


def _bdh(tickers, flds, start, end, **kwargs):
    """Thread-safe wrapper around xbbg_sapi.bdh()."""
    with _BBG_LOCK:
        return bdh(tickers, flds, start, end, **kwargs)

# -----------------------------------------------------------------------------
# Config from env (override the hardcoded defaults in xbbg_sapi)
# -----------------------------------------------------------------------------
BBG_HOST = os.environ.get("BBG_HOST", "10.103.1.46")
BBG_PORT = int(os.environ.get("BBG_PORT", "8194"))
BBG_UUID = os.environ.get("BBG_UUID") or None
BBG_USER_IP = os.environ.get("BBG_USER_IP") or None

RELAY_API_KEY = os.environ.get("RELAY_API_KEY", "")
# If RELAY_API_KEY is empty, the service starts in "no auth" mode (LAN-only).
# This is a footgun: the service is reached via a Cloudflare tunnel which is
# public by default. Set `AUTH_DISABLED=true` to opt in to no-auth mode
# explicitly; otherwise we hard-fail at startup so a misconfigured deploy
# doesn't silently expose the Bloomberg SAPI relay to the internet.
AUTH_DISABLED = os.environ.get("AUTH_DISABLED", "").lower() in ("1", "true", "yes")
if not RELAY_API_KEY and not AUTH_DISABLED:
    raise RuntimeError(
        "RELAY_API_KEY is empty and AUTH_DISABLED is not set. "
        "The bloomberg-service is reached via a public Cloudflare tunnel — "
        "running it without auth would expose the Bloomberg SAPI relay to "
        "the internet. Set RELAY_API_KEY (recommended) or AUTH_DISABLED=true "
        "(only if the service is behind a firewall that blocks public traffic)."
    )

# Per-asset-class field maps. Equities use the standard set; futures
# and FX pull a couple of extra fields (contract size, base ccy).
FIELDS_BY_CLASS = {
    "EQUITY":  ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "LONG_COMP_NAME", "GICS_SECTOR_NAME"],
    "ETF":     ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "LONG_COMP_NAME"],
    "FUTURE":  ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D", "FUT_CONT_SIZE", "FUT_CUR_GENERIC", "FUT_NOTICE_FIRST"],
    "FX":      ["PX_LAST", "PX_BID", "PX_ASK", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "BOND":    ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "OPTION":  ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "VOLUME", "CHG_PCT_1D"],
    "INDEX":   ["PX_LAST", "PX_OPEN", "PX_HIGH", "PX_LOW", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "CRYPTO":  ["PX_LAST", "PX_BID", "PX_ASK", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
    "MUTUAL_FUND": ["PX_LAST", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"],
}
FIELDS_BASIC = ["PX_LAST", "PX_PREVIOUS_CLOSE", "CHG_PCT_1D"]
FIELDS_FULL_DEFAULT = FIELDS_BY_CLASS["EQUITY"]

# -----------------------------------------------------------------------------
# Response models (mirror the CachedPrice shape in market-data)
# -----------------------------------------------------------------------------
class Quote(BaseModel):
    ticker: str
    current_price: float
    previous_close: Optional[float] = None
    change_pct: Optional[float] = None
    day_high: Optional[float] = None
    day_low: Optional[float] = None
    day_open: Optional[float] = None
    volume: Optional[int] = None
    company_name: Optional[str] = None
    sector: Optional[str] = None
    asset_class: Optional[str] = None
    bbg_symbol: Optional[str] = None
    contract_size: Optional[float] = None
    currency: Optional[str] = None
    expiry_date: Optional[str] = None
    last_updated: str

class HistoricalQuote(BaseModel):
    ticker: str
    date: str
    close_price: float
    company_name: Optional[str] = None

class HistoryPoint(BaseModel):
    date: str
    close: float

class HistorySeries(BaseModel):
    ticker: str
    asset_class: Optional[str] = None
    points: list[HistoryPoint]

class SearchResult(BaseModel):
    ticker: str
    description: str
    asset_class: Optional[str] = None


# -----------------------------------------------------------------------------
# Auth dependency
# -----------------------------------------------------------------------------
def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """Reject requests that don't have the correct X-API-Key header.

    If RELAY_API_KEY is unset and AUTH_DISABLED is set, the service
    accepts every request (no header check). This is only safe if the
    host is firewalled — the startup check above prevents the default
    no-auth configuration from going live.
    """
    if AUTH_DISABLED:
        return
    if x_api_key != RELAY_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


# -----------------------------------------------------------------------------
# Field-name handling
# -----------------------------------------------------------------------------
# `xbbg_sapi` (like its cousin `xbbg`) lowercases the field names in the
# DataFrame it returns, so a request for `PX_LAST` comes back with a column
# called `px_last`. To stay robust against the wheel's casing convention
# (and any future wheel that doesn't lowercase), look up fields by trying
# the requested name plus its common variants.
def _get_field(row, name: str):
    if name in row.index:
        return row[name]
    for candidate in (name.lower(), name.upper(), name.title()):
        if candidate in row.index:
            return row[candidate]
    return None


def _get_column(df: pd.DataFrame, name: str):
    """Same case-insensitive lookup as _get_field, but for DataFrame columns.

    bdh() returns a DataFrame whose columns are typically lowercase ('px_last'),
    but we accept any casing so the endpoint survives future wheel versions.

    Note: xbbg_sapi's bdh() may return a MultiIndex column
    (('TICKER', 'PX_LAST')) when called with a single ticker, instead
    of a flat index. The flat lookups below handle both cases.
    """
    if name in df.columns:
        return name
    for candidate in (name.lower(), name.upper(), name.title()):
        if candidate in df.columns:
            return candidate
    # MultiIndex columns: xbbg_sapi returns columns as a tuple of
    # (ticker, field) when given a single ticker. The field is the
    # second element of each tuple. Try every level-1 value against
    # the requested name and its case variants.
    if isinstance(df.columns, pd.MultiIndex):
        for candidate in (name, name.lower(), name.upper(), name.title()):
            matches = [col for col in df.columns
                       if isinstance(col, tuple) and len(col) >= 2
                       and col[-1] == candidate]
            if matches:
                return matches[0]
    return None


# -----------------------------------------------------------------------------
# Startup: connect to Bloomberg exactly once
# -----------------------------------------------------------------------------
app = FastAPI(title="Bloomberg Relay", version="1.0.0")


@app.on_event("startup")
def startup() -> None:
    log.info("Connecting to Bloomberg SAPI at %s:%d ...", BBG_HOST, BBG_PORT)
    try:
        connect(host=BBG_HOST, port=BBG_PORT, uuid=BBG_UUID, userIP=BBG_USER_IP)
        log.info("Bloomberg session ready.")
    except Exception as exc:
        log.error("Bloomberg connect() failed at startup: %s", exc)


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------
@app.get("/healthz")
def healthz() -> dict:
    """Liveness probe. Does not touch Bloomberg."""
    return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat()}


def _row_to_quote(
    bare_ticker: str,
    bbg_sym: str,
    row: pd.Series,
    asset_class: str = "EQUITY",
    contract_size: Optional[float] = None,
    currency: Optional[str] = None,
    expiry_date: Optional[str] = None,
) -> Quote:
    def _f(v) -> Optional[float]:
        try:
            f = float(v)
            if pd.isna(f):
                return None
            return f
        except (TypeError, ValueError):
            return None

    def _i(v) -> Optional[int]:
        try:
            f = float(v)
            if pd.isna(f):
                return None
            return int(f)
        except (TypeError, ValueError):
            return None

    return Quote(
        ticker=bare_ticker,
        current_price=_f(_get_field(row, "PX_LAST")) or 0.0,
        previous_close=_f(_get_field(row, "PX_PREVIOUS_CLOSE")),
        change_pct=_f(_get_field(row, "CHG_PCT_1D")),
        day_high=_f(_get_field(row, "PX_HIGH")),
        day_low=_f(_get_field(row, "PX_LOW")),
        day_open=_f(_get_field(row, "PX_OPEN")),
        volume=_i(_get_field(row, "VOLUME")),
        company_name=(
            str(_get_field(row, "LONG_COMP_NAME")).strip()
            if _get_field(row, "LONG_COMP_NAME") is not None and not pd.isna(_get_field(row, "LONG_COMP_NAME"))
            else None
        ),
        sector=(
            str(_get_field(row, "GICS_SECTOR_NAME")).strip()
            if _get_field(row, "GICS_SECTOR_NAME") is not None and not pd.isna(_get_field(row, "GICS_SECTOR_NAME"))
            else None
        ),
        asset_class=asset_class,
        bbg_symbol=bbg_sym,
        contract_size=contract_size,
        currency=currency,
        expiry_date=expiry_date,
        last_updated=datetime.now(timezone.utc).isoformat(),
    )


def _fields_for(asset_class: str) -> list[str]:
    return FIELDS_BY_CLASS.get(asset_class.upper(), FIELDS_FULL_DEFAULT)


@app.get("/resolve", dependencies=[Depends(require_api_key)])
def resolve(ticker: str = Query(..., min_length=1, max_length=20)) -> dict:
    """Resolve a user-facing ticker to a Bloomberg symbol + asset class.
    No Bloomberg call — pure shape-based classification. Used by the
    market-data Edge Function to know which fields to request."""
    ref: InstrumentRef = resolve_instrument(ticker)
    return {
        "success": True,
        "data": {
            "ticker": strip_to_bare_ticker(ref.bbg_symbol),
            "bbg_symbol": ref.bbg_symbol,
            "asset_class": ref.asset_class,
            "contract_size": ref.contract_size,
            "currency": ref.currency,
            "expiry_date": ref.expiry_date,
        },
    }


@app.get("/quote", response_model=Quote, dependencies=[Depends(require_api_key)])
def quote(
    ticker: str = Query(..., min_length=1, max_length=20),
    asset_class: Optional[str] = Query(None, description="Optional asset class hint (EQUITY/FUTURE/FX/...)"),
) -> Quote:
    ref: InstrumentRef = resolve_instrument(ticker, asset_class=asset_class)
    bbg = ref.bbg_symbol
    bare = strip_to_bare_ticker(bbg)
    fields = _fields_for(ref.asset_class)
    try:
        df = _bdp([bbg], fields)
    except Exception as exc:
        log.exception("bdp failed for %s", bbg)
        raise HTTPException(status_code=502, detail=f"Bloomberg error: {exc}")

    if df is None or df.empty or bbg not in df.index:
        raise HTTPException(status_code=404, detail=f"No data for {bbg}")

    row = df.loc[bbg]
    last_px = _get_field(row, "PX_LAST")
    if last_px is None or pd.isna(last_px) or float(last_px) == 0:
        raise HTTPException(status_code=404, detail=f"Empty quote for {bbg}")

    # For futures, pull the contract size from the FUT_CONT_SIZE field
    # if the shape-detector didn't already set one.
    contract_size = ref.contract_size
    if ref.asset_class == "FUTURE" and contract_size is None:
        cs = _get_field(row, "FUT_CONT_SIZE")
        if cs is not None and not pd.isna(cs):
            try:
                contract_size = float(cs)
            except (TypeError, ValueError):
                pass

    # Expiry date (futures/options). Bloomberg returns the first notice
    # date as YYYYMMDD int. Skip if not parseable.
    expiry_date: Optional[str] = None
    if ref.asset_class in ("FUTURE", "OPTION"):
        nd = _get_field(row, "FUT_NOTICE_FIRST")
        if nd is not None and not pd.isna(nd):
            try:
                expiry_date = pd.to_datetime(str(int(nd)), format="%Y%m%d").strftime("%Y-%m-%d")
            except Exception:
                pass

    return _row_to_quote(
        bare,
        bbg,
        row,
        asset_class=ref.asset_class,
        contract_size=contract_size,
        currency=ref.currency,
        expiry_date=expiry_date,
    )


@app.get("/quotes", dependencies=[Depends(require_api_key)])
def quotes(
    tickers: str = Query(..., description="Comma-separated tickers"),
    asset_class: Optional[str] = Query(None, description="Optional class hint applied to all tickers"),
) -> dict:
    raw = [t.strip() for t in tickers.split(",") if t.strip()]
    if not raw:
        raise HTTPException(status_code=400, detail="No tickers provided")
    if len(raw) > 50:
        raise HTTPException(status_code=400, detail="Max 50 tickers per request")

    # Resolve each ticker individually so we can use the right field
    # map per asset class.
    resolved = [resolve_instrument(t, asset_class=asset_class) for t in raw]
    bbg_syms = [r.bbg_symbol for r in resolved]

    # Group by asset class so we can make one bdp() call per class
    # (avoids mixing FUT_CONT_SIZE etc. into equity calls).
    by_class: dict[str, list[tuple[int, str]]] = {}
    for i, r in enumerate(resolved):
        by_class.setdefault(r.asset_class, []).append((i, r.bbg_symbol))

    results_by_bbg: dict[str, pd.Series] = {}
    for cls, items in by_class.items():
        bbg_list = [b for _, b in items]
        try:
            df = _bdp(bbg_list, _fields_for(cls))
        except Exception as exc:
            log.exception("bdp failed for %s", bbg_list)
            df = None
        if df is not None and not df.empty:
            for b in bbg_list:
                if b in df.index:
                    results_by_bbg[b] = df.loc[b]

    out: dict[str, Optional[dict]] = {}
    for r in resolved:
        bbg = r.bbg_symbol
        bare = strip_to_bare_ticker(bbg)
        row = results_by_bbg.get(bbg)
        if row is None:
            out[bare] = None
            continue
        try:
            contract_size = r.contract_size
            if r.asset_class == "FUTURE" and contract_size is None:
                cs = _get_field(row, "FUT_CONT_SIZE")
                if cs is not None and not pd.isna(cs):
                    try:
                        contract_size = float(cs)
                    except (TypeError, ValueError):
                        pass
            expiry_date: Optional[str] = None
            if r.asset_class in ("FUTURE", "OPTION"):
                nd = _get_field(row, "FUT_NOTICE_FIRST")
                if nd is not None and not pd.isna(nd):
                    try:
                        expiry_date = pd.to_datetime(str(int(nd)), format="%Y%m%d").strftime("%Y-%m-%d")
                    except Exception:
                        pass
            out[bare] = _row_to_quote(
                bare,
                bbg,
                row,
                asset_class=r.asset_class,
                contract_size=contract_size,
                currency=r.currency,
                expiry_date=expiry_date,
            ).model_dump()
        except Exception:
            log.exception("Failed to convert row for %s", bbg)
            out[bare] = None
    return out


@app.post("/refresh", response_model=Quote, dependencies=[Depends(require_api_key)])
def refresh(
    ticker: str = Query(..., min_length=1, max_length=20),
    asset_class: Optional[str] = Query(None),
) -> Quote:
    """Force-refresh a single ticker. Same shape as GET /quote."""
    return quote(ticker=ticker, asset_class=asset_class)


@app.get("/search", dependencies=[Depends(require_api_key)])
def search(q: str = Query(..., min_length=1, max_length=50)) -> list[dict]:
    """
    Lightweight ticker search. Tries Bloomberg's bds() against the
    COMPANY / SEARCH security domain. Returns a list of {ticker, description}
    matches. If the firm's xbbg_sapi build doesn't support bds(), returns
    501 — callers should fall back to the static COMPANY_TO_TICKER map
    on the ai-service side.
    """
    try:
        from xbbg_sapi import bds
    except Exception as exc:
        raise HTTPException(status_code=501, detail=f"bds not exposed by this xbbg_sapi build: {exc}")

    try:
        # Standard Bloomberg company-name search syntax. The exact
        # overload depends on the wheel version; we use the most common.
        df = bds("COMPANY", "SEARCH", override=[q])
    except TypeError:
        # Some wheel builds take the query as the first positional arg.
        try:
            df = bds(q, "SEARCH")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"bds() failed: {exc}")
    except Exception as exc:
        log.exception("search failed for %r", q)
        raise HTTPException(status_code=502, detail=f"Bloomberg error: {exc}")

    if df is None or df.empty:
        return []

    # Normalize the result into a list of {ticker, description} dicts.
    # The actual column names depend on the wheel — try a few common
    # spellings.
    out: list[dict] = []
    for _, row in df.iterrows():
        ticker = None
        for col in ("Ticker", "TICKER", "ticker"):
            if col in df.columns and not pd.isna(row.get(col)):
                ticker = str(row[col]).strip()
                break
        if not ticker:
            continue
        desc = None
        for col in ("Long Company Name", "LONG_COMP_NAME", "Name", "Short Name", "Description"):
            if col in df.columns and not pd.isna(row.get(col)):
                desc = str(row[col]).strip()
                break
        out.append({
            "ticker": ticker,
            "description": desc or "",
            "asset_class": None,  # Could be enriched via a second bdp() call; left null for v1.
        })
    return out


@app.get("/historical", dependencies=[Depends(require_api_key)])
def historical(
    ticker: str = Query(..., min_length=1, max_length=20),
    date: str = Query(..., description="Target date in YYYY-MM-DD"),
    asset_class: Optional[str] = Query(None),
) -> dict:
    """Historical close price for a single ticker on the latest trading day
    on or before the requested date.

    Fetches a 7-day window (start = date - 7 days, end = date) to handle
    weekends and market holidays, then returns the latest non-null PX_LAST
    in that window.
    """
    # 1. Validate date format and that it's a real calendar date.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    try:
        target_date = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {exc}")

    # 2. Convert to Bloomberg symbol.
    ref = resolve_instrument(ticker, asset_class=asset_class)
    bbg = ref.bbg_symbol
    bare = strip_to_bare_ticker(bbg)

    # 3. 7-day window to absorb weekends/holidays.
    start = (target_date - timedelta(days=7)).strftime("%Y-%m-%d")
    end = target_date.strftime("%Y-%m-%d")

    try:
        df = _bdh(bbg, ["PX_LAST"], start, end)
    except Exception as exc:
        log.exception("bdh failed for %s [%s..%s]", bbg, start, end)
        raise HTTPException(status_code=502, detail=f"Bloomberg error: {exc}")

    if df is None or df.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No historical data for {bbg} in [{start}..{end}]",
        )

    # 4. Resolve the price column (wheel may lowercase the name).
    col = _get_column(df, "PX_LAST")
    if col is None:
        raise HTTPException(
            status_code=404,
            detail=f"PX_LAST not returned for {bbg} in [{start}..{end}]",
        )

    # 5. Latest non-null value in the window.
    valid = df[col].dropna()
    if valid.empty:
        raise HTTPException(
            status_code=404,
            detail=f"All PX_LAST values null for {bbg} in [{start}..{end}]",
        )
    latest_ts = valid.index.max()
    latest_value = float(valid.loc[latest_ts])
    if latest_value == 0:
        raise HTTPException(
            status_code=404,
            detail=f"PX_LAST is zero for {bbg} on {latest_ts}",
        )

    # 6. Optional company name via bdp() (best-effort, separate call).
    company_name: Optional[str] = None
    try:
        name_df = _bdp([bbg], ["LONG_COMP_NAME"])
        if name_df is not None and not name_df.empty and bbg in name_df.index:
            name_col = _get_field(name_df.loc[bbg], "LONG_COMP_NAME")
            if name_col is not None and not pd.isna(name_col):
                company_name = str(name_col).strip() or None
    except Exception as exc:
        log.warning("bdp(LONG_COMP_NAME) failed for %s: %s", bbg, exc)

    # 7. Normalize the index to a YYYY-MM-DD string (handles Timestamp / date).
    if hasattr(latest_ts, "strftime"):
        date_str = latest_ts.strftime("%Y-%m-%d")
    else:
        date_str = str(latest_ts)[:10]

    payload = HistoricalQuote(
        ticker=bare,
        date=date_str,
        close_price=latest_value,
        company_name=company_name,
    )
    return {"success": True, "data": payload.model_dump()}


@app.get("/history-series", dependencies=[Depends(require_api_key)])
def history_series(
    tickers: str = Query(..., description="Comma-separated tickers, e.g. 'AAPL,MSFT,GOOGL'"),
    start: str = Query(..., description="Start date (YYYY-MM-DD), inclusive"),
    end: str = Query(..., description="End date (YYYY-MM-DD), inclusive"),
) -> dict:
    """Multi-day, multi-ticker close-price history.

    Powers the Risk page's market-derived Sharpe / VaR / CVaR / Sortino
    metrics. For each requested ticker we ask Bloomberg for the daily
    PX_LAST over [start..end] and return one normalised series.

    The Supabase `instrument_price_history` cache front-ends this so the
    Risk page only hits the relay for the rows that aren't already
    cached — see `market-data/historical-series` edge function.

    The response is `{"success": true, "data": [HistorySeries, ...]}`
    matching the rest of the relay. Tickers that Bloomberg has no data
    for are returned with an empty `points` array and logged at WARNING
    so the caller can decide whether to fail or proceed.
    """
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
        raise HTTPException(status_code=400, detail="start/end must be YYYY-MM-DD")
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d").date()
        end_d = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date: {exc}")
    if end_d < start_d:
        raise HTTPException(status_code=400, detail="end must be >= start")

    # Parse + de-duplicate tickers while preserving order.
    raw_tickers = [t.strip() for t in tickers.split(",") if t.strip()]
    if not raw_tickers:
        raise HTTPException(status_code=400, detail="No tickers provided")
    if len(raw_tickers) > 50:
        raise HTTPException(status_code=400, detail="Too many tickers (max 50)")

    # Resolve each ticker to its BBG symbol once (cheap; cached internally).
    resolved: list[tuple[str, str, Optional[str]]] = []
    for t in raw_tickers:
        try:
            ref = resolve_instrument(t)
            resolved.append((strip_to_bare_ticker(ref.bbg_symbol), ref.bbg_symbol, ref.asset_class))
        except HTTPException:
            log.warning("history-series: cannot resolve ticker '%s'", t)
            resolved.append((t.upper(), None, None))

    # Group by BBG symbol so a single bdh() returns multiple tickers in one
    # B-PIPE request — same rate-limiter friendliness rationale as the
    # batched /quotes endpoint (see fetchBloombergQuotes in market-data).
    bbg_to_bare: dict[str, list[str]] = {}
    bbg_to_class: dict[str, Optional[str]] = {}
    for bare, bbg, cls in resolved:
        if not bbg:
            continue
        bbg_to_bare.setdefault(bbg, []).append(bare)
        bbg_to_class[bbg] = cls

    # Result keyed by bare ticker (always uppercase).
    out: dict[str, HistorySeries] = {
        bare: HistorySeries(ticker=bare, asset_class=cls, points=[])
        for bare, _, cls in resolved
    }

    if bbg_to_bare:
        try:
            df = _bdh(list(bbg_to_bare.keys()), ["PX_LAST"], start, end)
        except Exception as exc:
            log.exception("history-series bdh failed for %d tickers", len(bbg_to_bare))
            raise HTTPException(status_code=502, detail=f"Bloomberg error: {exc}")

        if df is not None and not df.empty:
            # bdh() column shape varies by wheel version (flat, multiindex,
            # ticker-suffixed). For each BBG symbol we need the PX_LAST
            # column for any of its bare-ticker aliases.
            col_name = _get_column(df, "PX_LAST")
            for bbg, bares in bbg_to_bare.items():
                series_for_bbg = _extract_bbg_series(df, bbg, col_name)
                for bare in bares:
                    pts = out[bare]
                    for ts, val in series_for_bbg:
                        if val is None or pd.isna(val):
                            continue
                        date_str = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
                        pts.points.append(HistoryPoint(date=date_str, close=float(val)))
        for bare, series in out.items():
            if not series.points:
                log.warning("history-series: no PX_LAST for %s in [%s..%s]", bare, start, end)

    return {"success": True, "data": [s.model_dump() for s in out.values()]}


def _extract_bbg_series(df: pd.DataFrame, bbg: str, col_name: Optional[str]):
    """Pull a (timestamp, value) iterable out of a bdh() DataFrame for one BBG symbol.

    Handles three shapes seen across wheel versions:
      1. Flat columns: ['PX_LAST']                              (single ticker)
      2. MultiIndex columns: [(ticker, field)]                  (multi ticker)
      3. Ticker-suffixed columns: ['AAPL US Equity PX_LAST']    (multi ticker, flat)

    Returns list[(ts, value | None)]. Callers filter out None / NaN.
    """
    out_pairs: list = []
    if df is None or df.empty:
        return out_pairs

    # Case 1: single ticker, flat column.
    if col_name is not None and not isinstance(df.columns, pd.MultiIndex):
        if bbg in df.index and col_name in df.columns:
            for ts, val in df[col_name].items():
                out_pairs.append((ts, val))
            return out_pairs

    # Case 2: MultiIndex (ticker, field).
    if isinstance(df.columns, pd.MultiIndex):
        for col in df.columns:
            if not (isinstance(col, tuple) and len(col) == 2):
                continue
            tk, fld = col
            if tk == bbg and fld.lower() == "px_last":
                for ts, val in df[col].items():
                    out_pairs.append((ts, val))
                return out_pairs

    # Case 3: ticker-suffixed flat column.
    if col_name is not None:
        for c in df.columns:
            if isinstance(c, str) and c.endswith(f" {col_name}") and c.startswith(bbg):
                for ts, val in df[c].items():
                    out_pairs.append((ts, val))
                return out_pairs

    return out_pairs
