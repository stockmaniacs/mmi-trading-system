/**
 * fetchMMI.js
 * Fetches the current Market Mood Index from TickerTape.
 */

const MMI_API_URL = "https://api.tickertape.in/mmi/now";

/**
 * @returns {{ mmi: number, interpretation: string }}
 */
export async function fetchMMI() {
  const res = await fetch(MMI_API_URL, {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!res.ok) {
    throw new Error(`MMI API returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();

  // TickerTape shape: { data: { mmi: number, label: string, ... } }
  const mmi = json?.data?.mmi ?? json?.mmi;
  const interpretation = json?.data?.label ?? json?.label ?? deriveLabel(mmi);

  if (typeof mmi !== "number") {
    throw new Error(`Unexpected MMI response shape: ${JSON.stringify(json)}`);
  }

  return { mmi: Math.round(mmi * 100) / 100, interpretation };
}

/**
 * Fallback label derivation when the API doesn't return one.
 * @param {number} mmi
 * @returns {string}
 */
function deriveLabel(mmi) {
  if (mmi <= 30) return "Extreme Fear";
  if (mmi <= 50) return "Fear";
  if (mmi <= 69) return "Greed";
  if (mmi <= 80) return "Extreme Greed";
  return "High Extreme Greed";
}
