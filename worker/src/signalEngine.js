/**
 * signalEngine.js
 * Maps MMI data + index data into a fully-annotated trading signal.
 *
 * Export: computeSignal(mmiData, indicesData, previousMMI)
 */

// ---------------------------------------------------------------------------
// Zone table
// ---------------------------------------------------------------------------

// Continuous float-safe ranges: < 30, < 50, < 70, < 80, else
// (integer-gap approach caused 30.5, 50.5, 69.5 etc. to fall through as high_extreme_greed)
const ZONES = [
  {
    zone: "extreme_fear",
    signal: "STRONG BUY", color: "#06b6d4", emoji: "🔵",
    action: "Deploy capital aggressively in tranches. Extreme Fear marks rare, historically reliable buying opportunities.",
  },
  {
    zone: "fear",
    signal: "BUY",        color: "#22c55e", emoji: "🟩",
    action: "Accumulate quality stocks and index funds. Extreme Fear zone offers good entries for SIP top-ups and lump-sum deployment.",
  },
  {
    zone: "greed",
    signal: "HOLD",       color: "#f59e0b", emoji: "🟡",
    action: "Stay invested in existing holdings. Avoid chasing new positions. Market is in neutral territory — maintain discipline.",
  },
  {
    zone: "extreme_greed",
    signal: "REDUCE",     color: "#f97316", emoji: "🟠",
    action: "Book partial profits, especially in high-beta and overvalued stocks. Reduce allocation to aggressive positions.",
  },
  {
    zone: "high_extreme_greed",
    signal: "AVOID",      color: "#dc2626", emoji: "🔴",
    action: "Avoid all new positions. Sit on cash. Market is significantly overbought — a correction is likely.",
  },
];

// ---------------------------------------------------------------------------
// Momentum thresholds
// ---------------------------------------------------------------------------

const MOMENTUM = {
  RISING_FAST:  { key: "rising_fast",  minDelta:  3 },
  RISING:       { key: "rising",       minDelta:  1 },
  NEUTRAL:      { key: "neutral",      minDelta: -1 },  // -1 < delta <= 1
  FALLING:      { key: "falling",      minDelta: -3 },
  FALLING_FAST: { key: "falling_fast", minDelta: -Infinity },
};

// ---------------------------------------------------------------------------
// Analysis templates  (12 strings — zone × momentum combinations)
// ---------------------------------------------------------------------------

/**
 * Returns a contextual analysis string for the given computed signal.
 * Variables used: {mmi}, {delta}, {deltaWeek}, {vix}, {zone}
 *
 * @param {object} s  - partial signal object (mmi, zone, momentum, mmiDelta, mmiDeltaWeek, subIndicators)
 * @returns {string}
 */
function buildAnalysis(s) {
  const mmi       = s.mmi.toFixed(1);
  const delta     = s.mmiDelta  >= 0 ? `+${s.mmiDelta.toFixed(1)}` : s.mmiDelta.toFixed(1);
  const deltaWeek = s.mmiDeltaWeek >= 0 ? `+${s.mmiDeltaWeek.toFixed(1)}` : s.mmiDeltaWeek.toFixed(1);
  const vix       = s.subIndicators?.vix != null ? s.subIndicators.vix.toFixed(1) : "N/A";
  const { zone, momentum } = s;

  // ── HIGH EXTREME GREED ────────────────────────────────────────────────────
  if (zone === "high_extreme_greed") {
    if (momentum === "rising_fast") {
      return (
        `MMI has surged to ${mmi}, entering rare High Extreme Greed territory with strong upward ` +
        `momentum (${delta} pts today). Markets are significantly overbought. VIX at ${vix} suggests ` +
        `complacency. History shows corrections follow such readings. Avoid all new positions and ` +
        `consider booking profits in weaker holdings.`
      );
    }
    if (momentum === "rising") {
      return (
        `MMI climbed to ${mmi}, firmly in High Extreme Greed with positive momentum (${delta} pts). ` +
        `Euphoria is spreading across market participants. This is typically the late stage of a bull ` +
        `run. Reduce exposure to high-beta stocks, tighten stop-losses, and build cash reserves ` +
        `for the inevitable correction.`
      );
    }
    // neutral / falling / falling_fast
    return (
      `MMI stands at ${mmi} in High Extreme Greed, though momentum is cooling (${delta} pts today). ` +
      `A potential topping pattern may be forming. Avoid adding new positions. Trail existing ` +
      `stop-losses upward and watch for follow-through selling over the next few sessions.`
    );
  }

  // ── EXTREME GREED ─────────────────────────────────────────────────────────
  if (zone === "extreme_greed") {
    if (momentum === "rising_fast") {
      return (
        `MMI has jumped sharply to ${mmi} (${delta} pts today), pushing deeper into Extreme Greed. ` +
        `VIX at ${vix}. Markets are running hot across most sectors. Consider partial profit-booking ` +
        `in overvalued names and avoid aggressive new entries. Risk-reward is skewed to the downside.`
      );
    }
    if (momentum === "rising" || momentum === "neutral") {
      return (
        `MMI is at ${mmi} in Extreme Greed territory (${delta} pts today, ${deltaWeek} pts this week). ` +
        `The rally may extend short-term, but risk-reward no longer favours fresh positions. ` +
        `Trail stop-losses on existing holdings, reduce allocation in speculative bets, ` +
        `and have a profit-booking plan ready.`
      );
    }
    // falling / falling_fast
    return (
      `MMI has eased to ${mmi} within Extreme Greed (${delta} pts today). Momentum is slowing — ` +
      `an early sign that the rally may be losing steam. Book partial profits, especially in ` +
      `recent outperformers. A move toward the Greed zone would confirm the reversal trend.`
    );
  }

  // ── GREED ─────────────────────────────────────────────────────────────────
  if (zone === "greed") {
    if (momentum === "rising_fast" || momentum === "rising") {
      return (
        `MMI has risen to ${mmi}, moving deeper into Greed territory (${delta} pts today). ` +
        `Broad market optimism is increasing. Stay invested in quality holdings but resist the ` +
        `temptation to chase momentum. New positions at this level carry above-average risk. ` +
        `Monitor breadth and sector rotation for early warning signals.`
      );
    }
    if (momentum === "neutral") {
      return (
        `MMI holds at ${mmi} in the Greed zone with neutral momentum (${delta} pts). ` +
        `No action required. Existing holdings can be retained with defined stop-losses in place. ` +
        `Avoid aggressive new buys. Watch for a directional break — toward Extreme Greed ` +
        `(profit-take) or toward Fear (accumulate).`
      );
    }
    // falling / falling_fast
    return (
      `MMI has dipped to ${mmi} within the Greed zone (${delta} pts today, ${deltaWeek} pts this week). ` +
      `Early signs of cooling sentiment. No immediate action needed, but prepare a watchlist ` +
      `for accumulation — a further dip into Fear territory would present a better entry opportunity.`
    );
  }

  // ── FEAR ──────────────────────────────────────────────────────────────────
  if (zone === "fear") {
    if (momentum === "falling_fast" || momentum === "falling") {
      return (
        `MMI has fallen to ${mmi} in Fear territory (${delta} pts today). ` +
        `Markets are oversold in the short term as pessimism builds. ` +
        `Begin accumulating blue-chip stocks and index funds on dips. ` +
        `Stagger entries in 2–3 tranches — momentum suggests further weakness may follow ` +
        `before a meaningful recovery.`
      );
    }
    // neutral / rising / rising_fast
    return (
      `MMI is at ${mmi} in the Fear zone and showing recovery momentum (${delta} pts today). ` +
      `This positive shift is encouraging. Consider increasing SIP top-up amounts and ` +
      `adding selectively to quality midcap and bluechip positions. The risk-reward is ` +
      `favourable for medium-term investors at this level.`
    );
  }

  // ── EXTREME FEAR ──────────────────────────────────────────────────────────
  // (catches all momentum states — this zone is rare and always high-alert)
  return (
    `MMI has dropped to a rare ${mmi} — Extreme Fear! This level occurs less than 5% of the ` +
    `time historically and has consistently marked major market bottoms. VIX at ${vix} signals ` +
    `peak pessimism. Deploy capital aggressively in tranches across index funds and quality ` +
    `large-caps. History rewards investors who buy decisively during Extreme Fear. ` +
    `This is a generational buying opportunity.`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify an MMI value into its zone band.
 * Uses continuous < comparisons — no integer boundary gaps.
 * @param {number} mmi
 * @returns {object}  matching entry from ZONES
 */
function classifyZone(mmi) {
  if (mmi < 20) return ZONES[0]; // extreme_fear:       [0,  20)
  if (mmi < 30) return ZONES[1]; // fear:               [20, 30)
  if (mmi < 70) return ZONES[2]; // greed (Neutral):    [30, 70)
  if (mmi < 80) return ZONES[3]; // extreme_greed:      [70, 80)
  return ZONES[4];                // high_extreme_greed: [80, 100]
}

/**
 * Derive momentum label from today-vs-lastday MMI delta.
 * @param {number} delta
 * @returns {string}
 */
function classifyMomentum(delta) {
  if (delta >  3) return "rising_fast";
  if (delta >  1) return "rising";
  if (delta >= -1) return "neutral";
  if (delta >= -3) return "falling";
  return "falling_fast";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute a fully-annotated trading signal from today's MMI and index data.
 *
 * @param {object}      mmiData     - return value of fetchMMI()
 * @param {object}      indicesData - return value of fetchIndices()
 * @param {number|null} previousMMI - last persisted mmi value (for delta), or null
 *
 * @returns {{
 *   date:             string,
 *   mmi:              number,
 *   zone:             string,
 *   signal:           string,
 *   color:            string,
 *   emoji:            string,
 *   momentum:         string,
 *   mmiDelta:         number,
 *   mmiDeltaWeek:     number,
 *   action:           string,
 *   analysis:         string,
 *   isHighAlert:      boolean,
 *   nifty50Close:     number|null,
 *   niftyNext50Close: number|null,
 *   subIndicators:    { vix, fii, skew, momentum, trin, extrema },
 * }}
 */
export function computeSignal(mmiData, indicesData, previousMMI) {
  const mmi = mmiData.mmi;

  // Delta: today vs yesterday (from live API) or from KV previous record
  const lastdayMMI  = mmiData.lastday?.mmi ?? previousMMI ?? mmi;
  const lastwkMMI   = mmiData.lastweek?.mmi ?? mmi;

  const mmiDelta     = parseFloat((mmi - lastdayMMI).toFixed(2));
  const mmiDeltaWeek = parseFloat((mmi - lastwkMMI).toFixed(2));

  const { zone, signal, color, emoji, action } = classifyZone(mmi);
  const momentum = classifyMomentum(mmiDelta);

  const subIndicators = {
    vix:      mmiData.vix,
    fii:      mmiData.fii,
    skew:     mmiData.skew,
    momentum: mmiData.momentum,
    trin:     mmiData.trin,
    extrema:  mmiData.extrema,
  };

  const partial = { mmi, zone, momentum, mmiDelta, mmiDeltaWeek, subIndicators };
  const analysis = buildAnalysis(partial);

  const HIGH_ALERT_ZONES = new Set(["extreme_fear", "high_extreme_greed"]);

  return {
    date:             mmiData.date,
    mmi,
    zone,
    signal,
    color,
    emoji,
    momentum,
    mmiDelta,
    mmiDeltaWeek,
    action,
    analysis,
    isHighAlert:      HIGH_ALERT_ZONES.has(zone),
    nifty50Close:     indicesData?.nifty50?.close     ?? null,
    niftyNext50Close: indicesData?.niftyNext50?.close ?? null,
    subIndicators,
  };
}

// Re-export ZONES for frontend gauge rendering
export { ZONES };
