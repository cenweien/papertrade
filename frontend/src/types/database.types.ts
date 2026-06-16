// Type definitions matching the SQL schema in supabase/migrations/001_initial_schema.sql

export interface Database {
  public: {
    Tables: {
      portfolios: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          description: string | null;
          initial_capital: number;
          current_capital: number;
          created_at: string;
          updated_at: string;
          is_archived: boolean;
          metadata: Record<string, any>;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string | null;
          initial_capital?: number;
          current_capital?: number;
          created_at?: string;
          updated_at?: string;
          is_archived?: boolean;
          metadata?: Record<string, any>;
        };
        Update: Partial<{
          name: string;
          description: string | null;
          initial_capital: number;
          current_capital: number;
          is_archived: boolean;
          metadata: Record<string, any>;
        }>;
      };
      trades: {
        Row: {
          id: string;
          portfolio_id: string;
          ticker: string;
          side: 'BUY' | 'SELL';
          direction: 'LONG' | 'SHORT';
          qty: number;
          price: number;
          total_value: number;
          trade_timestamp: string;
          stop_price: number | null;
          status: 'OPEN' | 'CLOSED' | 'CANCELLED';
          pnl: number | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['trades']['Row'], 'id' | 'total_value' | 'created_at' | 'direction'> & {
          direction?: 'LONG' | 'SHORT';
        };
        Update: Partial<Database['public']['Tables']['trades']['Row']>;
      };
      positions: {
        Row: {
          id: string;
          portfolio_id: string;
          ticker: string;
          qty: number;
          avg_price: number;
          current_price: number | null;
          sector: string | null;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['positions']['Row'], 'id' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['positions']['Row']>;
      };
      daily_snapshots: {
        Row: {
          id: string;
          portfolio_id: string;
          snapshot_date: string;
          equity: number;
          exposure: number;
          cash: number;
          daily_return: number | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['daily_snapshots']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['daily_snapshots']['Row']>;
      };
      ai_chat_history: {
        Row: {
          id: string;
          user_id: string;
          portfolio_id: string | null;
          role: 'user' | 'assistant';
          content: string;
          parsed_command: any;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['ai_chat_history']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['ai_chat_history']['Row']>;
      };
    };
  };
}

// Convenience type aliases
export type Portfolio = Database['public']['Tables']['portfolios']['Row'];
export type Trade = Database['public']['Tables']['trades']['Row'];
export type Position = Database['public']['Tables']['positions']['Row'];
export type DailySnapshot = Database['public']['Tables']['daily_snapshots']['Row'];

// instrument_prices table (renamed from stock_prices in migration
// 005_instrument_universe.sql). The shape is backwards-compatible —
// every existing field is still present — with new optional metadata
// for non-equity asset classes.
export interface InstrumentPrice {
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
  asset_class: 'EQUITY' | 'ETF' | 'FUTURE' | 'FX' | 'BOND' | 'OPTION' | 'INDEX' | 'CRYPTO' | 'MUTUAL_FUND';
  bbg_symbol: string | null;
  contract_size: number | null;
  currency: string | null;
  expiry_date: string | null;
  last_updated: string;
}

// Backwards-compat alias: older imports used StockPrice.
export type StockPrice = InstrumentPrice;
