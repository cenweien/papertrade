from xbbg_sapi import bdp, connect

# Opens a B-PIPE session using the wheel's 14 hardcoded (UUID, IP) pairs
# and the default host=10.103.1.46, port=8194
connect()

# xbbg_sapi uses LISTS for tickers and fields (not single strings like public xbbg)
# Returns a pandas DataFrame, so print() works directly
last = bdp(['AAPL US Equity'], ['PX_LAST'])
print(last)