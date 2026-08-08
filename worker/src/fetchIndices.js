/**
 * fetchIndices.js
 * Fetches Nifty 50 and Nifty Next 50 closing prices via Yahoo Finance v8.
 *
 * Endpoints:
 *   Nifty 50:      https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1d
 *   Nifty Next 50: https://query1.finance.yahoo.com/v8/finance/chart/NIFTY_NEXT_50.NS?interval=1d&range=1d
 *
 * Response shape (relevant excerpt):
 * {
 *   "chart": {
 *     "result": [{
 *       "meta": {
 *         "symbol":             "^NSEI",
 *         "regularMarketPrice": 24850.5,
 *         ...
 *       }
 *     }]
 *   }
 * }
 *
 * If either fetch fails, null is returned for that index — the cron job continues.
 */

const YAHOO_BASE  = "https://query1.finance.yahoo.com/v8/finance/chart";
const INDICES = [
  {
    key:    "nifty50",
    url:    `${YAHOO_BASE}/%5ENSEI?interval=1d&range=1d`,
    symbol: "^NSEI",
  },
  {
    key:    "niftyNext50",
    url:    `${YAHOO_BASE}/NIFTY_NEXT_50.NS?interval=1d&range=1d`,
    symbol: "NIFTY_NEXT_50.NS",
  },
];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept:       "application/json",
};

/**
 * Fetch Nifty 50 and Nifty Next 50 closing prices.
 *
 * @returns {Promise<{
 *   nifty50:    { close: number, symbol: string } | null,
 *   niftyNext50:{ close: number, symbol: string } | null,
 * }>}
 */
export async function fetchIndices() {
  const results = await Promise.all(
    INDICES.map(({ key, url, symbol }) => fetchSingleIndex(url, symbol, key))
  );

  return {
    nifty50:     results[0],
    niftyNext50: results[1],
  };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Fetch a single Yahoo Finance chart and extract regularMarketPrice.
 * Returns null on any error (non-throwing by design).
 *
 * @param {string} url
 * @param {string} fallbackSymbol  - used in logs / returned object when meta.symbol absent
 * @param {string} logKey          - label for console messages
 * @returns {Promise<{ close: number, symbol: string }|null>}
 */
async function fetchSingleIndex(url, fallbackSymbol, logKey) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json  = await res.json();
    const error = json?.chart?.error;
    if (error) {
      throw new Error(`Yahoo error: ${JSON.stringify(error)}`);
    }

    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) {
      throw new Error("chart.result[0].meta missing from response");
    }

    const close = meta.regularMarketPrice;
    if (typeof close !== "number") {
      throw new Error(`regularMarketPrice is not a number: ${close}`);
    }

    const symbol = meta.symbol ?? fallbackSymbol;
    console.log(`[fetchIndices] ${logKey} (${symbol}): ${close}`);
    return { close, symbol };

  } catch (err) {
    console.error(`[fetchIndices] Failed to fetch ${logKey} (${fallbackSymbol}): ${err.message}`);
    return null;
  }
}
