/**
 * signalEngine.js
 * Maps MMI data + index data into a fully-annotated trading signal.
 *
 * Export: computeSignal(mmiData, indicesData, previousMMI)
 *
 * Zone table (TickerTape definitions + user's sub-zones at the extremes):
 *   high_extreme_fear:  MMI < 20  — user addition (within Extreme Fear)
 *   extreme_fear:    20 ≤ MMI < 30 — TickerTape: markets likely oversold, good time for fresh positions
 *   fear:            30 ≤ MMI < 50 — TickerTape: action depends on trajectory (falling→wait, rising→selective entry)
 *   greed:           50 ≤ MMI < 70 — TickerTape: act cautiously, trajectory-dependent
 *   extreme_greed:   70 ≤ MMI < 80 — TickerTape: avoid fresh positions, markets overbought
 *   high_extreme_greed: MMI ≥ 80  — user addition (within Extreme Greed)
 */

// ---------------------------------------------------------------------------
// Zone table
// ---------------------------------------------------------------------------

const ZONES = [
  {
    zone: "high_extreme_fear",
    signal: "STRONG BUY", color: "#06b6d4", emoji: "🔵",
    action: "Rare High Extreme Fear — deploy capital aggressively in tranches across index funds and quality large-caps. History marks this as a generational buying opportunity.",
  },
  {
    zone: "extreme_fear",
    signal: "BUY",         color: "#22c55e", emoji: "🟢",
    action: "Extreme Fear (<30) suggests a good time to open fresh positions. Markets are likely oversold and may turn upwards. Accumulate quality stocks in 2–3 tranches.",
  },
  {
    zone: "fear",
    signal: "WATCH",       color: "#84cc16", emoji: "🟡",
    action: "Fear zone (30–50): action depends on trajectory. If MMI is falling → wait for Extreme Fear (<30) as a better entry. If MMI is recovering from Extreme Fear → selective positions may be considered.",
  },
  {
    zone: "greed",
    signal: "HOLD",        color: "#f59e0b", emoji: "🟡",
    action: "Greed zone (50–70): stay cautious about new positions. If MMI is heading toward Extreme Greed → reduce exposure. If cooling from Extreme Greed → wait for a better entry before deploying fresh capital.",
  },
  {
    zone: "extreme_greed",
    signal: "REDUCE",      color: "#f97316", emoji: "🟠",
    action: "Extreme Greed (>70): avoid opening fresh positions. Markets are overbought and likely to turn downwards. Book partial profits, especially in high-beta and speculative positions.",
  },
  {
    zone: "high_extreme_greed",
    signal: "AVOID",       color: "#dc2626", emoji: "🔴",
    action: "High Extreme Greed (>80): avoid all new positions. Sit on cash. Market is significantly overbought at a rare extreme — a meaningful correction is likely.",
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
// Analysis templates
// ---------------------------------------------------------------------------

/**
 * Returns a contextual analysis string for the given computed signal.
 * @param {object} s  - partial signal object (mmi, zone, momentum, mmiDelta, mmiDeltaWeek, subIndicators)
 * @returns {string}
 */
function buildAnalysis(s) {
  const mmi       = s.mmi.toFixed(1);
  const delta     = s.mmiDelta     >= 0 ? `+${s.mmiDelta.toFixed(1)}`     : s.mmiDelta.toFixed(1);
  const deltaWeek = s.mmiDeltaWeek >= 0 ? `+${s.mmiDeltaWeek.toFixed(1)}` : s.mmiDeltaWeek.toFixed(1);
  const vix       = s.subIndicators?.vix != null ? s.subIndicators.vix.toFixed(1) : "N/A";
  const { zone, momentum } = s;

  // ── HIGH EXTREME GREED (>80) ─────────────────────────────────────────────
  if (zone === "high_extreme_greed") {
    if (momentum === "rising_fast") {
      return (
        `MMI has surged to ${mmi}, entering rare High Extreme Greed territory with strong upward ` +
        `momentum (${delta} pts today). Markets are significantly overbought. VIX at ${vix} signals ` +
        `complacency. History shows sharp corrections follow such readings. Avoid all new positions ` +
        `and consider booking profits in weaker holdings.`
      );
    }
    if (momentum === "rising") {
      return (
        `MMI climbed to ${mmi}, firmly in High Extreme Greed with positive momentum (${delta} pts). ` +
        `Euphoria is spreading. This is typically the late stage of a bull run. Reduce exposure to ` +
        `high-beta stocks, tighten stop-losses, and build cash reserves for the correction ahead.`
      );
    }
    // neutral / falling / falling_fast
    return (
      `MMI stands at ${mmi} in High Extreme Greed, though momentum is cooling (${delta} pts today). ` +
      `A potential topping pattern may be forming. Avoid adding new positions. Trail existing ` +
      `stop-losses upward and watch for follow-through selling over the next few sessions.`
    );
  }

  // ── EXTREME GREED (70–80) ────────────────────────────────────────────────
  if (zone === "extreme_greed") {
    if (momentum === "rising_fast") {
      return (
        `MMI has jumped sharply to ${mmi} (${delta} pts today), pushing deeper into Extreme Greed. ` +
        `VIX at ${vix}. Markets are running hot. Avoid aggressive new entries — risk-reward is ` +
        `skewed to the downside. Consider partial profit-booking in overvalued names.`
      );
    }
    if (momentum === "rising" || momentum === "neutral") {
      return (
        `MMI is at ${mmi} in Extreme Greed territory (${delta} pts today, ${deltaWeek} pts this week). ` +
        `Markets are overbought and unlikely to reward fresh long positions. Trail stop-losses on ` +
        `existing holdings, reduce speculative bets, and have a profit-booking plan ready.`
      );
    }
    // falling / falling_fast
    return (
      `MMI has eased to ${mmi} within Extreme Greed (${delta} pts today). Momentum is slowing — ` +
      `an early sign the rally may be losing steam. Book partial profits, especially in recent ` +
      `outperformers. A move toward the Greed zone (below 70) would confirm the reversal.`
    );
  }

  // ── GREED (50–70) ────────────────────────────────────────────────────────
  if (zone === "greed") {
    if (momentum === "rising_fast" || momentum === "rising") {
      return (
        `MMI has risen to ${mmi}, moving toward Extreme Greed territory (${delta} pts today, ` +
        `${deltaWeek} pts this week). Greed is increasing — be cautious about opening new positions. ` +
        `Stay invested in quality holdings but resist chasing momentum. Monitor for a push above 70.`
      );
    }
    if (momentum === "neutral") {
      return (
        `MMI holds at ${mmi} in the Greed zone with neutral momentum (${delta} pts). ` +
        `No immediate action required — hold existing positions with defined stop-losses. ` +
        `Watch for a directional break: above 70 (reduce) or below 50 (evaluate entry).`
      );
    }
    // falling / falling_fast — coming down from Extreme Greed
    return (
      `MMI has dipped to ${mmi} within the Greed zone (${delta} pts today, ${deltaWeek} pts this week). ` +
      `Greed is reducing. More patience is suggested before looking for fresh opportunities — ` +
      `wait for MMI to drop toward Fear or Extreme Fear for a better entry point.`
    );
  }

  // ── FEAR (30–50) ─────────────────────────────────────────────────────────
  if (zone === "fear") {
    if (momentum === "falling_fast" || momentum === "falling") {
      return (
        `MMI has fallen to ${mmi} in the Fear zone (${delta} pts today). Fear is increasing — ` +
        `action depends on trajectory. With MMI dropping, it may be prudent to wait for ` +
        `Extreme Fear (below 30), which is historically a stronger entry point. ` +
        `Prepare your watchlist and stagger planned buys.`
      );
    }
    if (momentum === "rising" || momentum === "rising_fast") {
      return (
        `MMI is recovering at ${mmi} in the Fear zone (${delta} pts today). Fear is reducing — ` +
        `if MMI has bounced from Extreme Fear (<30), this may be a reasonable moment for selective ` +
        `entry into quality positions. Consider SIP top-ups and adding to high-conviction stocks ` +
        `in small tranches.`
      );
    }
    // neutral
    return (
      `MMI is at ${mmi} in the Fear zone with neutral momentum (${delta} pts). ` +
      `Action depends on trajectory: if MMI starts dropping toward 30, wait for Extreme Fear ` +
      `for a better entry. If stabilising after a bounce from below, selective accumulation ` +
      `in quality names can be considered. Monitor the trend closely.`
    );
  }

  // ── EXTREME FEAR (20–30) ─────────────────────────────────────────────────
  if (zone === "extreme_fear") {
    if (momentum === "falling_fast" || momentum === "falling") {
      return (
        `MMI has fallen to ${mmi} in Extreme Fear territory (${delta} pts today). ` +
        `Markets are likely oversold and a turn upwards is possible. ` +
        `Begin opening fresh positions in index funds and quality large-caps in 2–3 tranches. ` +
        `Momentum still suggests further weakness, so stagger entries rather than going all-in.`
      );
    }
    // neutral / rising / rising_fast — fear reducing, good entry window
    return (
      `MMI is at ${mmi} in Extreme Fear with positive or stable momentum (${delta} pts today). ` +
      `Fear is reducing — this is a good time to open fresh positions as markets may be ` +
      `turning upwards. Increase SIP top-ups, add selectively to quality mid-caps and blue-chips. ` +
      `Risk-reward is favourable for medium-term investors.`
    );
  }

  // ── HIGH EXTREME FEAR (<20) ───────────────────────────────────────────────
  // Catches all momentum states — rare zone, always a high-alert buy signal
  return (
    `MMI has dropped to a rare ${mmi} — High Extreme Fear! This level occurs in less than 5% of ` +
    `trading sessions and has historically marked major market bottoms. VIX at ${vix} signals ` +
    `peak pessimism. Deploy capital aggressively in tranches across index funds and quality ` +
    `large-caps. History consistently rewards investors who buy decisively at these levels. ` +
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
  if (mmi < 20) return ZONES[0]; // high_extreme_fear:  [0,  20)
  if (mmi < 30) return ZONES[1]; // extreme_fear:       [20, 30)
  if (mmi < 50) return ZONES[2]; // fear:               [30, 50)
  if (mmi < 70) return ZONES[3]; // greed:              [50, 70)
  if (mmi < 80) return ZONES[4]; // extreme_greed:      [70, 80)
  return ZONES[5];                // high_extreme_greed: [80, 100]
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

  // High-alert zones: user's two extreme sub-zones only
  const HIGH_ALERT_ZONES = new Set(["high_extreme_fear", "high_extreme_greed"]);

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
