/**
 * signalEngine.js
 * Maps an MMI value to a trading zone, signal, and action recommendation.
 * Also decides whether a signal change warrants an email alert.
 */

/**
 * Zone definitions in ascending MMI order.
 * Each band is [min, max] inclusive.
 */
const ZONES = [
  {
    min: 0,
    max: 30,
    zone: "extreme_fear",
    label: "Extreme Fear",
    signal: "STRONG BUY",
    action:
      "Deploy aggressively. Extreme Fear — rare buying opportunity.",
    color: "#16a34a", // dark green
  },
  {
    min: 31,
    max: 50,
    zone: "fear",
    label: "Fear",
    signal: "BUY",
    action:
      "Accumulate. Fear zone — good entry for SIP and lump sum.",
    color: "#65a30d", // lime
  },
  {
    min: 51,
    max: 69,
    zone: "greed",
    label: "Greed",
    signal: "HOLD",
    action:
      "Stay invested. No fresh positions. Greed is building.",
    color: "#ca8a04", // amber
  },
  {
    min: 70,
    max: 80,
    zone: "extreme_greed",
    label: "Extreme Greed",
    signal: "REDUCE",
    action:
      "Book partial profits. Market is overheated.",
    color: "#ea580c", // orange
  },
  {
    min: 81,
    max: 100,
    zone: "high_extreme_greed",
    label: "High Extreme Greed",
    signal: "AVOID",
    action:
      "Avoid new positions. Sit on cash. Correction likely.",
    color: "#dc2626", // red
  },
];

/**
 * Derive zone metadata for an MMI value.
 *
 * @param {number} mmi  - e.g. 34.5
 * @returns {{ zone: string, label: string, signal: string, action: string, color: string }}
 */
export function classify(mmi) {
  const band = ZONES.find((z) => mmi >= z.min && mmi <= z.max);
  if (!band) {
    // Clamp to nearest band for out-of-range values
    return mmi < 0 ? ZONES[0] : ZONES[ZONES.length - 1];
  }
  const { zone, label, signal, action, color } = band;
  return { zone, label, signal, action, color };
}

/**
 * Build a complete data record for today's MMI reading.
 *
 * @param {object} params
 * @param {string} params.date           - "YYYY-MM-DD"
 * @param {number} params.mmi
 * @param {string} params.interpretation - label from TickerTape
 * @param {number} params.nifty50
 * @param {number} params.niftyNext50
 * @returns {object}
 */
export function buildRecord({ date, mmi, interpretation, nifty50, niftyNext50 }) {
  const { zone, label, signal, action, color } = classify(mmi);
  return {
    date,
    mmi,
    interpretation: interpretation ?? label,
    nifty50,
    niftyNext50,
    zone,
    signal,
    action,
    color,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Decide whether to send an alert for the new record.
 * Alerts fire when:
 *  1. The signal changes from the previous day.
 *  2. The zone changes (zone crossing is always noteworthy).
 *  3. MMI enters or exits extreme_fear / high_extreme_greed.
 *
 * @param {object|null} previousRecord  - last persisted record (may be null)
 * @param {object}      newRecord
 * @returns {{ shouldAlert: boolean, reason: string|null }}
 */
export function shouldSendAlert(previousRecord, newRecord) {
  if (!previousRecord) {
    return { shouldAlert: true, reason: "First record — baseline established." };
  }

  if (previousRecord.signal !== newRecord.signal) {
    return {
      shouldAlert: true,
      reason: `Signal changed: ${previousRecord.signal} → ${newRecord.signal}`,
    };
  }

  if (previousRecord.zone !== newRecord.zone) {
    return {
      shouldAlert: true,
      reason: `Zone crossed: ${previousRecord.zone} → ${newRecord.zone}`,
    };
  }

  const extremeZones = new Set(["extreme_fear", "high_extreme_greed"]);
  if (extremeZones.has(newRecord.zone)) {
    return {
      shouldAlert: true,
      reason: `Staying in extreme zone (${newRecord.zone}) — daily reminder.`,
    };
  }

  return { shouldAlert: false, reason: null };
}

/**
 * Exported zone definitions (useful for frontend gauge rendering).
 */
export { ZONES };
