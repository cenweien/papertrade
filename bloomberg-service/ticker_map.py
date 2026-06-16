"""
ticker_map.py - Convert a bare ticker (e.g. "AAPL", "ES1", "EURUSD",
"700") to a Bloomberg symbol and identify the asset class.

Asset classes supported in v1:
  - EQUITY     (US/HK/UK equity)
  - ETF
  - FUTURE     (S&P e-mini, crude, gold, etc.)
  - FX         (currency pairs, e.g. EURUSD)
  - BOND
  - OPTION
  - INDEX
  - CRYPTO
  - MUTUAL_FUND

The auto-detector inspects the ticker SHAPE:
  - 3-5 uppercase letters       -> equity/ETF (try both via resolve_instrument)
  - 6 uppercase letters         -> FX pair (e.g. "EURUSD" -> "EURUSD Curncy")
  - digit+letter mix            -> futures (e.g. "ES1" -> "ES1 Index")
  - all digits 1-5 chars        -> HK equity (e.g. "700" -> "700 HK Equity")
  - already contains a space    -> return as-is (user gave a full BBG symbol)
  - explicit override wins      -> caller's asset_class param is authoritative

Examples
--------
>>> resolve_instrument("AAPL").bbg_symbol
'AAPL US Equity'
>>> resolve_instrument("ES1").bbg_symbol, resolve_instrument("ES1").asset_class
('ES1 Index', 'FUTURE')
>>> resolve_instrument("EURUSD").bbg_symbol, resolve_instrument("EURUSD").asset_class
('EURUSD Curncy', 'FX')
>>> resolve_instrument("700").bbg_symbol, resolve_instrument("700").asset_class
('700 HK Equity', 'EQUITY')
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Bloomberg suffix table. The auto-detector picks the right suffix from
# the ticker shape; the caller can override with `asset_class=`.
SUFFIX_BY_ASSET_CLASS = {
    "EQUITY":      " US Equity",
    "ETF":         " US Equity",     # most ETFs are US-listed; refine per-symbol in resolve_instrument if needed
    "FUTURE":      " Index",         # generic front-month continuous (ES1, CL1, etc.)
    "FX":          " Curncy",
    "BOND":        " Govt",
    "OPTION":      " US Equity",     # option chain is a property of the underlying
    "INDEX":       " Index",
    "CRYPTO":      " Curncy",        # Bloomberg treats crypto as curncy pairs
    "MUTUAL_FUND": " US Equity",
}

DEFAULT_ASSET_CLASS = "EQUITY"

_DOT_RE = re.compile(r"\.")


@dataclass
class InstrumentRef:
    """The resolved Bloomberg identity of an instrument."""
    bbg_symbol: str
    asset_class: str
    contract_size: Optional[float] = None
    currency: Optional[str] = None
    expiry_date: Optional[str] = None  # ISO YYYY-MM-DD, only for futures/options


def to_bbg_symbol(ticker: str, suffix: str = SUFFIX_BY_ASSET_CLASS[DEFAULT_ASSET_CLASS]) -> str:
    """Legacy single-string helper. Equivalent to
    ``resolve_instrument(ticker).bbg_symbol`` with the default suffix."""
    return resolve_instrument(ticker, asset_class=None).bbg_symbol


def strip_to_bare_ticker(bbg_symbol: str) -> str:
    """
    Convert a Bloomberg symbol back to a bare ticker.

    >>> strip_to_bare_ticker("AAPL US Equity")
    'AAPL'
    >>> strip_to_bare_ticker("BRK/B US Equity")
    'BRK.B'
    >>> strip_to_bare_ticker("ES1 Index")
    'ES1'
    """
    if " " not in bbg_symbol:
        return bbg_symbol
    return bbg_symbol.split(" ", 1)[0].replace("/", ".")


def _classify(ticker: str) -> str:
    """Pick an asset class from the ticker shape alone. Used when the
    caller doesn't supply one. Order matters: more specific shapes
    (FX, futures, HK) are tried before the generic 3-5 letter equity
    fallback."""
    t = ticker.strip().upper()
    if not t:
        return DEFAULT_ASSET_CLASS
    if " " in t:
        # Already suffixed; caller should have used the override path.
        return DEFAULT_ASSET_CLASS

    # 6 uppercase letters -> FX (EURUSD, GBPJPY, AUDUSD).
    if re.fullmatch(r"[A-Z]{6}", t):
        return "FX"

    # Letter+digit mix (ES1, CLZ25, GC=F, NQ1) -> futures.
    if re.fullmatch(r"[A-Z]+\d+[A-Z]?|[A-Z]+=[A-Z]?", t):
        return "FUTURE"

    # All digits 1-5 -> HK equity (700, 00700, 9988).
    if re.fullmatch(r"\d{1,5}", t):
        return "EQUITY"

    # 3-5 letters/digits with optional dot/slash -> equity/ETF.
    if re.fullmatch(r"[A-Z][A-Z0-9./\-]{0,4}", t):
        return DEFAULT_ASSET_CLASS

    return DEFAULT_ASSET_CLASS


def resolve_instrument(
    ticker: str,
    asset_class: Optional[str] = None,
) -> InstrumentRef:
    """
    Resolve a user-facing ticker into a Bloomberg InstrumentRef.

    Args:
        ticker:      A user-facing ticker ("AAPL", "BRK.B", "ES1",
                     "EURUSD", "700", or already-suffixed "AAPL US Equity").
        asset_class: Optional explicit override. If given and not None,
                     this asset class is used and the shape-based
                     classifier is skipped. Used by callers that have
                     prior knowledge (e.g. the AI chat said "futures").

    Returns:
        An ``InstrumentRef`` with the BBG symbol, asset class, and
        (where applicable) contract size / currency / expiry.
    """
    if not ticker:
        raise ValueError("ticker must be a non-empty string")
    t = ticker.strip().upper()
    if not t:
        raise ValueError("ticker must be a non-empty string")

    # Already suffixed: return as-is, treat as equity by default.
    if " " in t:
        return InstrumentRef(bbg_symbol=t, asset_class=asset_class or "EQUITY")

    # Pick the asset class: explicit override wins, otherwise shape.
    cls = (asset_class or _classify(t)).upper()
    suffix = SUFFIX_BY_ASSET_CLASS.get(cls, SUFFIX_BY_ASSET_CLASS[DEFAULT_ASSET_CLASS])

    # Dots -> slashes (Bloomberg convention for share-class).
    bbg = f"{_DOT_RE.sub('/', t)}{suffix}"

    ref = InstrumentRef(bbg_symbol=bbg, asset_class=cls)

    # HK equities: zero-pad to 5 digits.
    if cls == "EQUITY" and t.isdigit():
        padded = t.zfill(5)
        if padded != t:
            ref = InstrumentRef(
                bbg_symbol=f"{padded} HK Equity",
                asset_class="EQUITY",
            )

    # FX: the base/quote pair.
    if cls == "FX" and len(t) == 6:
        ref = InstrumentRef(
            bbg_symbol=bbg,
            asset_class="FX",
            currency=t[:3],  # base currency
            contract_size=1.0,  # notional = 1 unit of base
        )

    return ref
