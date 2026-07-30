"""Check exactly what df.index looks like for each ticker."""
from xbbg_sapi import bdp, connect
from ticker_map import resolve_instrument

connect()

for t in ["AAPL", "TSLA", "NVDA", "SPY", "ES1", "EURUSD", "700"]:
    ref = resolve_instrument(t)
    sym = ref.bbg_symbol
    df = bdp([sym], ["PX_LAST"])
    idx_list = list(df.index)
    print(f"{t:8} -> bbg_symbol={sym!r:30} df.index={idx_list!r}")
    print(f"          bbg in index? {sym in df.index}")
    if sym in df.index:
        row = df.loc[sym]
        print(f"          row: {row.to_dict()}")
        print(f"          PX_LAST={row.get('PX_LAST')!r}  ({type(row.get('PX_LAST')).__name__})")
        v = row.get("PX_LAST")
        try:
            f = float(v)
            print(f"          float(v)={f}  pd.isna={__import__('pandas').isna(v)}  ==0? {f==0}")
        except Exception as e:
            print(f"          float(v) raised: {e}")
    print()
