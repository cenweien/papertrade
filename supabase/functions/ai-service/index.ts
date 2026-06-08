// AI Service Edge Function - Parses natural language trade commands using MiniMax
// This is the ONLY Edge Function needed - used to protect the MiniMax API key.
// All CRUD is done directly from the frontend using Supabase client.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS headers (inlined so the function deploys as a single file in the Supabase dashboard)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// Secrets — set these in Supabase Edge Function config:
//   MINIMAX_API_KEY  (required) — your MiniMax API key
//   SUPABASE_URL     (auto-provided by Supabase, do not set manually)
//   SERVICE_KEY      (required) — a Secret Key from Settings → API → Secret keys
//                                 (the SUPABASE_ prefix is reserved by Supabase)
const MINIMAX_API_KEY = Deno.env.get('MINIMAX_API_KEY');
const MINIMAX_MODEL = 'MiniMax-2-7-highspeed'; // lightweight, fast
const MINIMAX_API_URL = 'https://api.MiniMax.chat/v1/chat/completions';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Supabase auto-injects SUPABASE_URL. We use a Secret Key (new system) for
    // privileged access — create one in Settings → API → Secret keys and add it
    // as an env var in the function's secrets. NOTE: Supabase reserves the
    // SUPABASE_ prefix for its own auto-injected vars, so we use SERVICE_KEY.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SERVICE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // POST /ai-service/parse - Parse natural language into a trade command
    if (req.method === 'POST' && pathParts[2] === 'parse') {
      const body = await req.json();
      const { command } = body;

      if (!command) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Command is required'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Get user's portfolios for context
      const { data: portfolios } = await supabase
        .from('portfolios')
        .select('id, name')
        .eq('user_id', user.id)
        .eq('is_archived', false);

      const portfolioList = (portfolios || []).map((p: any) => `${p.name} (${p.id})`).join(', ') || 'None';

      const parsed = await parseCommand(command, portfolioList, MINIMAX_API_KEY);

      // Save to chat history
      await supabase.from('ai_chat_history').insert({
        user_id: user.id,
        portfolio_id: parsed.portfolio_id,
        role: 'user',
        content: command,
        parsed_command: parsed,
      });

      return new Response(JSON.stringify({
        success: true,
        data: parsed
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // GET /ai-service/history - Get chat history
    if (req.method === 'GET' && pathParts[2] === 'history') {
      const portfolioId = url.searchParams.get('portfolio_id');
      const limit = parseInt(url.searchParams.get('limit') || '20');

      let query = supabase
        .from('ai_chat_history')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (portfolioId) {
        query = query.eq('portfolio_id', portfolioId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return new Response(JSON.stringify({ success: true, data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(
      JSON.stringify({ error: 'Invalid endpoint' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('AI service error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

interface ParsedCommand {
  portfolio_id: string | null;
  portfolio_name: string | null;
  action: 'BUY' | 'SELL' | 'CLOSE';
  ticker: string | null;
  qty: number | string | null;
  price_type: 'MARKET' | 'LIMIT' | 'STOP';
  limit_price: number | null;
  stop_loss_pct: number | null;
  confidence: number;
  needs_confirmation: boolean;
  explanation: string;
  original_command: string;
}

async function parseCommand(
  command: string,
  portfolioList: string,
  apiKey: string | undefined
): Promise<ParsedCommand> {
  // Fallback simple parser
  const simple = simpleParse(command, portfolioList);

  if (!apiKey) {
    return simple;
  }

  // Use MiniMax for better parsing
  const systemPrompt = `You are a trading assistant for a paper trading platform. Parse natural language trade commands and extract structured information.

Available portfolios: ${portfolioList}

Rules:
1. If no portfolio specified, set portfolio_id to null and the frontend will use the active one
2. "at market" means MARKET order type
3. "half" or "percentage" refers to existing position size
4. "close" or "exit" means sell the entire position
5. Always extract ticker symbols in uppercase
6. Provide a brief explanation of what the command does

Respond ONLY with valid JSON in this exact format:
{
  "portfolio_id": "uuid or null",
  "portfolio_name": "string or null",
  "action": "BUY|SELL|CLOSE",
  "ticker": "SYMBOL or null",
  "qty": number or "ALL" or "HALF" or null,
  "price_type": "MARKET|LIMIT|STOP",
  "limit_price": number or null,
  "stop_loss_pct": number or null,
  "confidence": 0.0-1.0,
  "needs_confirmation": boolean,
  "explanation": "brief explanation"
}`;

  try {
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: command }
        ],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`MiniMax API error: ${response.status} ${errText}`);
      return simple;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (content) {
      const parsed = JSON.parse(content) as ParsedCommand;
      parsed.original_command = command;
      return parsed;
    }
  } catch (error) {
    console.error('MiniMax error:', error);
  }

  return simple;
}

function simpleParse(command: string, portfolioList: string): ParsedCommand {
  const lower = command.toLowerCase();

  // Detect action
  let action: 'BUY' | 'SELL' | 'CLOSE' = 'BUY';
  if (lower.includes('close') || lower.includes('exit') || lower.includes('sell all')) {
    action = lower.includes('close') || lower.includes('exit') ? 'CLOSE' : 'SELL';
  } else if (lower.includes('sell') || lower.includes('short')) {
    action = 'SELL';
  }

  // Extract ticker - look for 1-5 letter uppercase words
  const tickerMatch = command.match(/\b([A-Z]{1,5})\b/);
  const ticker = tickerMatch ? tickerMatch[1] : null;

  // Extract quantity
  let qty: number | string | null = 100;
  const qtyMatch = command.match(/(\d+)\s*(?:shares?|stocks?|units?)?/i);
  if (qtyMatch) {
    qty = parseInt(qtyMatch[1]);
  } else if (lower.includes('half')) {
    qty = 'HALF';
  } else if (lower.includes('all') || lower.includes('entire')) {
    qty = 'ALL';
  }

  // Extract stop loss percentage
  let stopLossPct: number | null = null;
  const stopMatch = lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:stop|stop loss|sl)/);
  if (stopMatch) {
    stopLossPct = parseFloat(stopMatch[1]);
  }

  // Extract portfolio from "in [name]" pattern
  let portfolioId: string | null = null;
  let portfolioName: string | null = null;
  const inMatch = command.match(/in\s+([A-Za-z][A-Za-z\s]*?)(?:,|\s+(?:buy|sell|close))/i);
  if (inMatch) {
    portfolioName = inMatch[1].trim();
  }

  return {
    portfolio_id: portfolioId,
    portfolio_name: portfolioName,
    action,
    ticker,
    qty,
    price_type: lower.includes('limit') ? 'LIMIT' : 'MARKET',
    limit_price: null,
    stop_loss_pct: stopLossPct,
    confidence: 0.7,
    needs_confirmation: !ticker || qty === null,
    explanation: `${action} ${qty} ${ticker || '???'} at ${lower.includes('limit') ? 'limit' : 'market'} price${stopLossPct ? ` with ${stopLossPct}% stop loss` : ''}`,
    original_command: command,
  };
}
