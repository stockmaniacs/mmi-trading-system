/**
 * fetchMMI.js
 * Fetches the current Market Mood Index from TickerTape with a 10-second timeout.
 *
 * Expected API response shape (api.tickertape.in/mmi/now):
 * {
 *   "data": {
 *     "currentvalue": 62.3,
 *     "indicator":    "Greed",
 *     "raw":          { ... },      // sub-indicator raw values
 *     "vix":      12.4,
 *     "fii":      0.45,
 *     "skew":    -0.12,
 *     "momentum": 0.67,
 *     "trin":     0.98,
 *     "extrema":  0.30,
 *     "fma":      62.1,
 *     "sma":      61.8,
 *     "lastday":   { "date": "2026-08-06", "indicator": 60.1 },
 *     "lastweek":  { "date": "2026-07-31", "indicator": 58.4 },
 *     "lastmonth": { "date": "2026-07-07", "indicator": 55.0 }
 *   }
 * }
 *
 * Throws "MMI_FETCH_FAILED: <reason>" on any error.
 */

const MMI_URL    = "https://api.tickertape.in/mmi/now";
const TIMEOUT_MS = 10_000;

/**
 * Fetch and return the current MMI reading with historical comparisons.
 *
 * @returns {Promise<{
 *   date: string,
 *   mmi: number,
 *   indicator: string,
 *   raw: object,
 *   vix: number,
 *   fii: number,
 *   skew: number,
 *   momentum: number,
 *   trin: number,
 *   extrema: number,
 *   fma: number,
 *   sma: number,
 *   lastday:   { date: string, mmi: number },
 *   lastweek:  { date: string, mmi: number },
 *   lastmonth: { date: string, mmi: number },
 * }>}
 */
export async function fetchMMI() {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(MMI_URL, {
      headers: { Accept: "application/json" },
      signal:  controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    // TickerTape wraps in { data: {...} } but the shape may vary
    const d = json?.data ?? json ?? {};

    // currentValue / currentvalue — accept either casing
    const mmiValue = d.currentValue ?? d.currentvalue;
    if (typeof mmiValue !== "number") {
      throw new Error(
        `Unexpected response shape — no numeric currentValue/currentvalue. ` +
        `Keys found: ${Object.keys(d).join(", ")}`
      );
    }

    // lastDay / lastday / lastWeek / lastweek — accept either casing
    const lastDay   = d.lastDay   ?? d.lastday   ?? {};
    const lastWeek  = d.lastWeek  ?? d.lastweek  ?? {};
    const lastMonth = d.lastMonth ?? d.lastmonth ?? {};

    // Historical MMI value may be under "indicator" or "mmi"
    const histMmi = (obj) => obj?.indicator ?? obj?.mmi ?? obj?.currentValue ?? null;

    // Today's date in IST
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    return {
      date:      today,
      mmi:       mmiValue,
      indicator: d.indicator,
      raw:       d.raw ?? {},
      vix:       d.vix,
      fii:       d.fii,
      skew:      d.skew,
      momentum:  d.momentum,
      trin:      d.trin,
      extrema:   d.extrema,
      fma:       d.fma,
      sma:       d.sma,
      lastday:   { date: lastDay.date,   mmi: histMmi(lastDay)   },
      lastweek:  { date: lastWeek.date,  mmi: histMmi(lastWeek)  },
      lastmonth: { date: lastMonth.date, mmi: histMmi(lastMonth) },
    };

  } catch (err) {
    // Re-throw with a stable prefix so callers can match it
    throw new Error(`MMI_FETCH_FAILED: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
