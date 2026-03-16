/**
 * Historical data fetcher for backtesting.
 * Source: Drift Data API.
 */

const DRIFT_DATA_API = "https://data.api.drift.trade";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundingRate {
  timestamp: number;
  rate: number;
  annualized: number;
}

/**
 * Fetch candles from Drift. Supports hourly (60) and daily (D).
 * Paginates automatically (API max 1000 per request).
 */
export async function fetchCandles(
  market: string = "SOL-PERP",
  resolution: string | number = "D",
  limit: number = 1000
): Promise<Candle[]> {
  console.log(`Fetching ${market} ${resolution} candles (up to ${limit})...`);

  const allCandles: Candle[] = [];
  const pageSize = 1000;
  let remaining = limit;
  let endTs: number | undefined;

  while (remaining > 0) {
    const fetchLimit = Math.min(remaining, pageSize);
    let url = `${DRIFT_DATA_API}/market/${market}/candles/${resolution}?limit=${fetchLimit}`;
    if (endTs) url += `&endTs=${endTs}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch candles: ${res.status}`);

    const body = (await res.json()) as {
      success: boolean;
      records: Array<{
        ts: number;
        oracleOpen: number;
        oracleHigh: number;
        oracleLow: number;
        oracleClose: number;
        quoteVolume?: number;
        baseVolume?: number;
      }>;
    };

    if (!body.success || !body.records || body.records.length === 0) break;

    const candles = body.records.map((r) => ({
      timestamp: r.ts,
      open: r.oracleOpen,
      high: r.oracleHigh,
      low: r.oracleLow,
      close: r.oracleClose,
      volume: r.quoteVolume ?? r.baseVolume ?? 0,
    }));

    allCandles.push(...candles);
    remaining -= candles.length;

    const oldest = Math.min(...candles.map((c) => c.timestamp));
    endTs = oldest - 1;

    console.log(`  Fetched ${candles.length} (total: ${allCandles.length})`);
    if (candles.length < fetchLimit) break;
  }

  return allCandles.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Compute Parkinson realized vol from daily candles (annualized bps).
 */
export function computeRollingVol(
  candles: Candle[],
  windowSize: number = 30 // 30-day window for daily candles
): Array<{ timestamp: number; volBps: number }> {
  const results: Array<{ timestamp: number; volBps: number }> = [];
  const ln2x4 = 4 * Math.LN2;

  for (let i = windowSize; i < candles.length; i++) {
    const window = candles.slice(i - windowSize, i);
    let sum = 0, valid = 0;

    for (const c of window) {
      if (c.high <= 0 || c.low <= 0 || c.high < c.low) continue;
      const l = Math.log(c.high / c.low);
      sum += l * l;
      valid++;
    }

    if (valid === 0) {
      results.push({ timestamp: candles[i].timestamp, volBps: 3000 });
      continue;
    }

    // Parkinson with daily candles → annualize by sqrt(252)
    const variance = sum / (ln2x4 * valid);
    const annualizedVol = Math.sqrt(variance * 252);
    results.push({
      timestamp: candles[i].timestamp,
      volBps: Math.round(annualizedVol * 10000),
    });
  }

  return results;
}

export function classifyVolRegime(volBps: number): string {
  if (volBps < 2000) return "veryLow";
  if (volBps < 3500) return "low";
  if (volBps < 5000) return "normal";
  if (volBps < 7500) return "high";
  return "extreme";
}

/**
 * Estimate signal severity from daily candle data.
 */
export function estimateSignalSeverity(
  candles: Candle[],
  idx: number,
  windowSize: number = 10
): number {
  if (idx < windowSize) return 0;

  const recent = candles.slice(idx - windowSize, idx);
  const current = candles[idx];

  const avgClose = recent.reduce((s, c) => s + c.close, 0) / recent.length;
  const priceMovePct = Math.abs((current.close - avgClose) / avgClose) * 100;

  const avgVolume = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const volumeSpike = avgVolume > 0 ? current.volume / avgVolume : 1;

  const rangePct = current.high > 0 ? ((current.high - current.low) / current.high) * 100 : 0;

  if (priceMovePct > 10 || volumeSpike > 3 || rangePct > 10) return 3;
  if (priceMovePct > 5 || volumeSpike > 2 || rangePct > 7) return 2;
  if (priceMovePct > 3 || volumeSpike > 1.5 || rangePct > 4) return 1;
  return 0;
}
