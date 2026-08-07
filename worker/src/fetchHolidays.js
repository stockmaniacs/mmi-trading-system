/**
 * fetchHolidays.js
 * Returns NSE equity trading holiday dates for the current IST year.
 *
 * Strategy (cascading):
 *   1. KV cache hit → return immediately (30-day TTL)
 *   2. UPSTOX_ACCESS_TOKEN set → fetch live from Upstox API, cache, return
 *   3. No token → use bundled STATIC_HOLIDAYS for 2025 and 2026, cache, return
 *   4. Any error → log and return [] (weekend-only check still guards the cron)
 *
 * Static holidays cover all NSE equity closures for 2025–2026 as published
 * in official NSE circulars. Update STATIC_HOLIDAYS when NSE publishes 2027.
 */

const UPSTOX_HOLIDAY_URL = "https://api.upstox.com/v2/market/holidays";
const KV_TTL = 2592000; // 30 days in seconds

/** Map 3-letter month abbreviations → zero-padded month numbers */
const MONTH_MAP = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/**
 * Bundled NSE equity trading holidays — used when UPSTOX_ACCESS_TOKEN is absent.
 * Source: NSE India official circulars (NSE/COMP/latest).
 * Dates are "YYYY-MM-DD", only weekday closures listed (weekends handled separately).
 */
const STATIC_HOLIDAYS = {
  2025: [
    "2025-02-19", // Chhatrapati Shivaji Maharaj Jayanti
    "2025-02-26", // Mahashivratri
    "2025-03-14", // Holi
    "2025-03-31", // Id-Ul-Fitr (Ramzan Eid)
    "2025-04-10", // Shree Ram Navami
    "2025-04-14", // Dr. Baba Saheb Ambedkar Jayanti
    "2025-04-18", // Good Friday
    "2025-05-01", // Maharashtra Day
    "2025-08-15", // Independence Day
    "2025-10-02", // Mahatma Gandhi Jayanti / Dussehra
    "2025-10-21", // Diwali Laxmi Puja (Muhurat Trading — exchange open for muhurat only, treated as holiday for regular session)
    "2025-10-22", // Diwali Balipratipada
    "2025-11-05", // Gurunanak Jayanti
    "2025-12-25", // Christmas Day
  ],
  2026: [
    "2026-01-26", // Republic Day
    "2026-03-18", // Holi (Dhuleti)
    "2026-04-02", // Gudi Padwa / Ram Navami
    "2026-04-10", // Good Friday
    "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-08-15", // Independence Day
    "2026-10-02", // Mahatma Gandhi Jayanti
    "2026-10-22", // Dussehra
    "2026-11-10", // Diwali Laxmi Puja
    "2026-11-11", // Diwali Balipratipada
    "2026-11-30", // Gurunanak Jayanti
    "2026-12-25", // Christmas Day
  ],
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Return NSE equity holiday dates for the current IST year.
 * Reads from KV first; falls back to Upstox API or static list on cache miss.
 * On any failure, returns [] so the Worker can still run with weekend-only check.
 *
 * @param {object} env - Cloudflare Worker env (needs MMI_KV; UPSTOX_ACCESS_TOKEN optional)
 * @returns {Promise<string[]>}  array of "YYYY-MM-DD" strings
 */
export async function getHolidays(env) {
  const year  = currentISTYear();
  const kvKey = `holidays:${year}`;

  // ── 1. KV cache hit ───────────────────────────────────────────────────────
  const cached = await env.MMI_KV.get(kvKey);
  if (cached) {
    console.log(`[fetchHolidays] KV cache hit for ${kvKey}`);
    return JSON.parse(cached);
  }

  // ── 2. Upstox API (only when token is configured) ─────────────────────────
  if (env.UPSTOX_ACCESS_TOKEN) {
    console.log(`[fetchHolidays] KV miss — fetching Upstox holidays for ${year}`);
    try {
      const res = await fetch(UPSTOX_HOLIDAY_URL, {
        headers: {
          Accept:        "application/json",
          Authorization: `Bearer ${env.UPSTOX_ACCESS_TOKEN}`,
          "Api-Version": "2.0",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

      const json    = await res.json();
      const rawList = Array.isArray(json?.data) ? json.data : [];

      const holidays = rawList
        .filter((h) => {
          const closedStr = String(h.closed ?? "");
          return closedStr.split(",").map((s) => s.trim()).includes("NSE_EQ");
        })
        .map((h) => parseUpstoxDate(h.date))
        .filter(Boolean)
        .sort();

      const deduped = [...new Set(holidays)];

      await env.MMI_KV.put(kvKey, JSON.stringify(deduped), { expirationTtl: KV_TTL });
      console.log(
        `[fetchHolidays] Upstox: cached ${deduped.length} holidays for ${year}: ` +
        deduped.slice(0, 3).join(", ") + (deduped.length > 3 ? " …" : "")
      );
      return deduped;

    } catch (err) {
      console.error(`[fetchHolidays] Upstox API failed — ${err.message}. Falling back to static list.`);
      // fall through to static list below
    }
  } else {
    console.log("[fetchHolidays] UPSTOX_ACCESS_TOKEN not set — using bundled static holiday list.");
  }

  // ── 3. Static bundled list ─────────────────────────────────────────────────
  const staticList = STATIC_HOLIDAYS[year] ?? [];

  if (staticList.length > 0) {
    await env.MMI_KV.put(kvKey, JSON.stringify(staticList), { expirationTtl: KV_TTL });
    console.log(
      `[fetchHolidays] Static: cached ${staticList.length} holidays for ${year}: ` +
      staticList.slice(0, 3).join(", ") + " …"
    );
  } else {
    console.warn(`[fetchHolidays] No static holidays found for ${year} — update STATIC_HOLIDAYS.`);
  }

  return staticList;
}

/**
 * Returns true if dateStr ("YYYY-MM-DD") is a known NSE equity holiday.
 */
export function isMarketHoliday(dateStr, holidays) {
  return holidays.includes(dateStr);
}

/**
 * Returns true if dateStr falls on Saturday (6) or Sunday (0) in UTC.
 */
export function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns true only when the date is neither a weekend nor a known NSE holiday.
 */
export function isMarketOpen(dateStr, holidays) {
  return !isWeekend(dateStr) && !isMarketHoliday(dateStr, holidays);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse Upstox date "15-Jan-2026" → "2026-01-15".
 */
function parseUpstoxDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const month = MONTH_MAP[m[2]];
    if (!month) return null;
    return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  console.warn(`[fetchHolidays] Unrecognised date format: "${s}"`);
  return null;
}

/**
 * Returns the current year in IST (UTC+5:30).
 */
function currentISTYear() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCFullYear();
}
