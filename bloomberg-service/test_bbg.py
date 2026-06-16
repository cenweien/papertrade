"""
test_bbg.py - minimal: can we pull a stock quote from xbbg_sapi?

This is the smallest possible program that exercises the wheel end-to-end.
If it prints a price, Bloomberg is working. If it raises, the traceback
tells you exactly what's missing.
"""
from xbbg_sapi import bdp, connect

# Open a B-PIPE session. Uses the wheel's defaults:
#   host=10.103.1.46, port=8194, the 14 hardcoded (UUID, IP) pairs
connect()

# Pull AAPL's last price
print(bdp(["AAPL US Equity"], ["PX_LAST"]))

# Try a few more fields just to confirm the field mapping is right
print()
print(bdp(
    ["AAPL US Equity"],
    ["PX_LAST", "CHG_PCT_1D", "PX_PREVIOUS_CLOSE", "PX_OPEN", "PX_HIGH", "PX_LOW", "VOLUME"],
))
