/**
 * fetchHolidays.js
 * Fetches NSE trading holidays from the Upstox API and caches them
 * in Cloudflare KV with a 30-day TTL.
 *
 * KV key: "holidays:<YYYY>"  →  JSON array of "YYYY-MM-DD" strings
 */

const UPSTOX_HOLIDAY_URL =
  "https://api.upstox.com/v2/market/holidays";
const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Returns a Set of holiday date strings ("YYYY-MM-DD") for the given year.
 * Reads from KV first; falls back to Upstox API on cache miss.
 *
 * @param {KVNamespace} kv         - Cloudflare KV binding (MMI_KV)
 * @param {string}      accessToken - Upstox OAuth access token
 * @param {number}      [year]      - defaults to current IST year
 * @returns {Promise<Set<string>>}
 */
export async function getHolidays(kv, accessToken, year) {
  const y = year ?? currentISTYear();
  const kvKey = `holidays:${y}`;

  // --- KV cache hit ---
  const cached = await kv.get(kvKey);
  if (cached) {
    return new Set(JSON.parse(cached));
  }

  // --- Cache miss: fetch from Upstox ---
  const holidays = await fetchFromUpstox(accessToken, y);
  await kv.put(kvKey, JSON.stringify(holidays), { expirationTtl: KV_TTL_SECONDS });
  return new Set(holidays);
}

/**
 * Returns true when `dateStr` ("YYYY-MM-DD") is a trading holiday.
 *
 * @param {KVNamespace} kv
 * @param {string}      accessToken
 * @param {string}      dateStr
 * @returns {Promise<boolean>}
 */
export async function isHoliday(kv, accessToken, dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const holidays = await getHolidays(kv, accessToken, year);
  return holidays.has(dateStr);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch holiday list from Upstox and normalise to "YYYY-MM-DD" strings.
 * Upstox returns holidays for both NSE and BSE; we de-duplicate by date.
 *
 * @param {string} accessToken
 * @param {number} year
 * @returns {Promise<string[]>}
 */
async function fetchFromUpstox(accessToken, year) {
  // Upstox v2 endpoint accepts optional ?year= param
  const url = `${UPSTOX_HOLIDAY_URL}?year=${year}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Api-Version": "2.0",
    },
  });

  if (!res.ok) {
    throw new Error(`Upstox holidays API returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();

  // Upstox shape: { status: "success", data: [ { date: "2024-01-26", ... }, ... ] }
  const raw = json?.data ?? [];
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected Upstox holidays shape: ${JSON.stringify(json)}`);
  }

  // Normalise: keep only NSE segment holidays, extract date strings
  const dates = raw
    .filter((h) => {
      // Some responses have a "closed_exchanges" array; keep if NSE is listed
      if (Array.isArray(h.closed_exchanges)) {
        return h.closed_exchanges.includes("NSE");
      }
      return true; // include all if no exchange filter present
    })
    .map((h) => normaliseDate(h.date ?? h.holiday_date))
    .filter(Boolean);

  // De-duplicate
  return [...new Set(dates)].sort();
}

/**
 * Normalise various date formats to "YYYY-MM-DD".
 * Handles ISO strings, "DD-MM-YYYY", and "DD/MM/YYYY".
 *
 * @param {string|undefined} raw
 * @returns {string|null}
 */
function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Already ISO: "2024-01-26" or "2024-01-26T..."
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // "26-01-2024" or "26/01/2024"
  const match = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;

  return null;
}

/**
 * Current year in IST (UTC+5:30).
 * @returns {number}
 */
function currentISTYear() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear();
}
