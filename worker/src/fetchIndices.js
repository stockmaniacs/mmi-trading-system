/**
 * fetchIndices.js
 * Fetches Nifty 50 and Nifty Next 50 closing prices via the NSE India JSON API.
 * Uses Cloudflare's cache to avoid hammering NSE on repeated invocations.
 */

const NSE_API_BASE = "https://www.nseindia.com/api";
const INDEX_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.nseindia.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/**
 * @returns {{ nifty50: number, niftyNext50: number }}
 */
export async function fetchIndices() {
  const [nifty50, niftyNext50] = await Promise.all([
    fetchIndexClose("NIFTY 50"),
    fetchIndexClose("NIFTY NEXT 50"),
  ]);
  return { nifty50, niftyNext50 };
}

/**
 * Fetch the last closing price for a named NSE index.
 * @param {string} indexName  e.g. "NIFTY 50"
 * @returns {Promise<number>}
 */
async function fetchIndexClose(indexName) {
  const url = `${NSE_API_BASE}/allIndices`;
  const res = await fetch(url, {
    headers: INDEX_HEADERS,
    cf: { cacheTtl: 600, cacheEverything: true },
  });

  if (!res.ok) {
    throw new Error(`NSE indices API returned ${res.status}`);
  }

  const json = await res.json();
  const list = json?.data ?? [];
  const entry = list.find((i) => i.indexSymbol === indexName || i.index === indexName);

  if (!entry) {
    throw new Error(`Index "${indexName}" not found in NSE response`);
  }

  // last = last traded price; previousClose as fallback
  const price = entry.last ?? entry.previousClose;
  if (typeof price !== "number") {
    throw new Error(`No numeric price for ${indexName}: ${JSON.stringify(entry)}`);
  }

  return Math.round(price * 100) / 100;
}
