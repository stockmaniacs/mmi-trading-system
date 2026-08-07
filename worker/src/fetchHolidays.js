/**
 * fetchHolidays.js
 * Fetches NSE equity trading holidays from the Upstox API and caches them
 * in Cloudflare KV with a 30-day TTL.
 *
 * Upstox response shape:
 * {
 *   "status": "success",
 *   "data": [
 *     { "date": "15-Jan-2026", "description": "...", "open": "NSE_EQ", "closed": "NSE_EQ,BSE_EQ" },
 *     ...
 *   ]
 * }
 *
 * Only dates where "NSE_EQ" appears in the `closed` field are kept.
 */

const UPSTOX_HOLIDAY_URL = "https://api.upstox.com/v2/market/holidays";
const KV_TTL = 2592000; // 30 days in seconds

/** Map 3-letter month abbreviations → zero-padded month numbers */
const MONTH_MAP = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Return NSE equity holiday dates for the current IST year.
 * Reads from KV first; falls back to Upstox API on cache miss.
 * On API failure, logs the error and returns [] so the Worker can still run
 * using the weekend-only check.
 *
 * @param {object} env - Cloudflare Worker env (needs MMI_KV, UPSTOX_ACCESS_TOKEN)
 * @returns {Promise<string[]>}  array of "YYYY-MM-DD" strings
 */
export async function getHolidays(env) {
  const year   = currentISTYear();
  const kvKey  = `holidays:${year}`;

  // --- Cache hit ---
  const cached = await env.MMI_KV.get(kvKey);
  if (cached) {
    console.log(`[fetchHolidays] KV cache hit for ${kvKey}`);
    return JSON.parse(cached);
  }

  // --- Cache miss: fetch from Upstox ---
  console.log(`[fetchHolidays] KV cache miss — fetching Upstox holidays for ${year}`);
  try {
    const res = await fetch(UPSTOX_HOLIDAY_URL, {
      headers: {
        Accept:           "application/json",
        Authorization:    `Bearer ${env.UPSTOX_ACCESS_TOKEN}`,
        "Api-Version":    "2.0",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const json    = await res.json();
    const rawList = Array.isArray(json?.data) ? json.data : [];

    // Keep only NSE equity closures and normalise date strings
    const holidays = rawList
      .filter((h) => {
        const closedStr = String(h.closed ?? "");
        return closedStr.split(",").map((s) => s.trim()).includes("NSE_EQ");
      })
      .map((h) => parseUpstoxDate(h.date))
      .filter(Boolean)
      .sort();

    const deduped = [...new Set(holidays)];

    await env.MMI_KV.put(kvKey, JSON.stringify(deduped), {
      expirationTtl: KV_TTL,
    });

    console.log(
      `[fetchHolidays] Cached ${deduped.length} NSE equity holidays for ${year}: ` +
      deduped.slice(0, 3).join(", ") + (deduped.length > 3 ? " …" : "")
    );
    return deduped;

  } catch (err) {
    console.error(`[fetchHolidays] Upstox API failed — ${err.message}. Using empty holiday list.`);
    return [];
  }
}

/**
 * Returns true if dateStr ("YYYY-MM-DD") is a known NSE equity holiday.
 * @param {string}   dateStr  - "YYYY-MM-DD"
 * @param {string[]} holidays - result of getHolidays()
 */
export function isMarketHoliday(dateStr, holidays) {
  return holidays.includes(dateStr);
}

/**
 * Returns true if dateStr falls on Saturday (6) or Sunday (0) in UTC.
 * Dates are passed as "YYYY-MM-DD"; appending "T00:00:00Z" avoids TZ drift.
 * @param {string} dateStr - "YYYY-MM-DD"
 */
export function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns true only when the date is neither a weekend nor a holiday.
 * @param {string}   dateStr  - "YYYY-MM-DD"
 * @param {string[]} holidays - result of getHolidays()
 */
export function isMarketOpen(dateStr, holidays) {
  return !isWeekend(dateStr) && !isMarketHoliday(dateStr, holidays);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse Upstox date "15-Jan-2026" → "2026-01-15".
 * Returns null on unrecognised format.
 * @param {string|undefined} raw
 * @returns {string|null}
 */
function parseUpstoxDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Primary format: "15-Jan-2026"
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const month = MONTH_MAP[m[2]];
    if (!month) return null;
    return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
  }

  // Fallback: already "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  console.warn(`[fetchHolidays] Unrecognised date format: "${s}"`);
  return null;
}

/**
 * Returns the current year in IST (UTC+5:30).
 * @returns {number}
 */
function currentISTYear() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear();
}
