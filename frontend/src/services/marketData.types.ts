// Shared types for the market-data services (Supabase Edge Function and
// direct-relay paths both expose the same shapes). Defined here so
// marketData.ts, marketHistory.ts, and marketData.direct.ts don't each
// redeclare them with subtle drift.

export interface StockQuote {
  ticker: string;
  current_price: number;
  previous_close: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  day_open: number | null;
  volume: number | null;
  company_name: string | null;
  sector: string | null;
  asset_class?: string | null;
  bbg_symbol?: string | null;
  contract_size?: number | null;
  currency?: string | null;
  expiry_date?: string | null;
  last_updated: string;
  from_cache?: boolean;
  _stale?: boolean;
}

export interface HistoryPoint {
  trade_date: string;
  close: number;
}

export interface HistorySeries {
  ticker: string;
  asset_class?: string | null;
  points: HistoryPoint[];
}
