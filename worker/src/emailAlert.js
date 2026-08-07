/**
 * emailAlert.js
 * Sends daily MMI signal alerts via Brevo transactional email API.
 *
 * Template A — Standard daily alert  (signal.isHighAlert === false)
 *   Subject: "📊 MMI Daily: {mmi} — {signal} | {date}"
 *
 * Template B — HIGH ALERT            (signal.isHighAlert === true)
 *   Subject: "🚨 HIGH ALERT — MMI {mmi}: {signal} | StockManiacs"
 *   Adds a coloured warning banner + Historical Context section.
 */

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

const RECIPIENTS = [
  { email: "stockmaniacsdotnet@gmail.com", name: "StockManiacs" },
  { email: "helpdesk@stockmaniacs.net",    name: "Helpdesk" },
  { email: "stockmaniacs@ymail.com",       name: "StockManiacs Yahoo" },
];

// ---------------------------------------------------------------------------
// Exported: send
// ---------------------------------------------------------------------------

/**
 * Send the MMI signal alert email via Brevo.
 * Email failures are logged but DO NOT throw — must not abort the cron job.
 *
 * @param {object} signal - return value of computeSignal()
 * @param {object} env    - Cloudflare Worker env bindings (needs BREVO_API_KEY)
 */
export async function sendEmailAlert(signal, env) {
  const subject  = buildSubject(signal);
  const htmlBody = generateEmailHTML(signal);

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key":      env.BREVO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender:      { email: "alerts@stockmaniacs.net", name: "StockManiacs Alerts" },
      to:          RECIPIENTS,
      subject,
      htmlContent: htmlBody,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Brevo send failed (${res.status}):`, errText);
    // Do NOT throw — email failure must not abort the cron job
  } else {
    console.log(`Email sent: ${subject}`);
  }
}

// ---------------------------------------------------------------------------
// Exported: HTML generator (pure function, no side effects)
// ---------------------------------------------------------------------------

/**
 * Generate the full HTML email body.
 * All styles are inline — email clients strip <style> blocks.
 * No external images, no external fonts.
 *
 * @param {object} signal - return value of computeSignal()
 * @returns {string}
 */
export function generateEmailHTML(signal) {
  // Template B: header bg = signal colour; Template A: dark navy
  const headerBg = signal.isHighAlert ? signal.color : "#1e3a5f";

  const rows = [];
  rows.push(renderHeader(headerBg));
  if (signal.isHighAlert) rows.push(renderHighAlertBanner(signal));
  rows.push(renderHero(signal));
  rows.push(renderReadings(signal));
  rows.push(renderAction(signal));
  rows.push(renderAnalysis(signal));
  rows.push(renderIndexLevels(signal));
  rows.push(renderSubIndicators(signal));
  if (signal.isHighAlert) rows.push(renderHistoricalContext());
  rows.push(renderSpacer(24));
  rows.push(renderFooter());

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="UTF-8"/>\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1.0"/>\n` +
    `<title>StockManiacs MMI Alert</title>\n` +
    `</head>\n` +
    `<body style="margin:0;padding:0;background-color:#f4f6f9;` +
      `font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="background-color:#f4f6f9;padding:24px 0;">\n` +
    `<tr><td align="center">\n` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ` +
      `style="max-width:600px;width:100%;background-color:#ffffff;` +
      `border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.10);">\n` +
    rows.join("\n") +
    `\n</table>\n` +
    `</td></tr>\n` +
    `</table>\n` +
    `</body>\n` +
    `</html>`
  );
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

function buildSubject(signal) {
  const mmi = fmtMMI(signal.mmi);
  if (signal.isHighAlert) {
    return `🚨 HIGH ALERT — MMI ${mmi}: ${signal.signal} | StockManiacs`;
  }
  return `📊 MMI Daily: ${mmi} — ${signal.signal} | ${signal.date}`;
}

// ---------------------------------------------------------------------------
// Section renderers — each returns a <tr>…</tr> string
// ---------------------------------------------------------------------------

/** 1. Header row: brand left, alert label right */
function renderHeader(headerBg) {
  return (
    `<tr>\n` +
    `<td style="background-color:${headerBg};padding:16px 24px;">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td style="color:#ffffff;font-weight:700;font-size:18px;` +
      `font-family:Arial,Helvetica,sans-serif;">StockManiacs</td>\n` +
    `<td align="right" style="color:rgba(255,255,255,0.85);font-size:13px;` +
      `font-family:Arial,Helvetica,sans-serif;white-space:nowrap;">` +
      `Market Mood Index Alert</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 2. HIGH ALERT warning banner (Template B only) */
function renderHighAlertBanner(signal) {
  const bgTint = hexToRgba(signal.color, 0.10);
  const warningText =
    signal.zone === "extreme_fear"
      ? `Extreme Fear detected — MMI at ${fmtMMI(signal.mmi)}. ` +
        `Historically, this zone marks rare buying opportunities. ` +
        `Review your investment plan before acting.`
      : `Market Euphoria Warning — MMI at ${fmtMMI(signal.mmi)}. ` +
        `Markets are significantly overbought. ` +
        `Capital protection and profit-booking are the priority.`;

  return (
    `<tr>\n` +
    `<td style="padding:16px 24px 0;">\n` +
    // Left-border box via a 2-cell table (more reliable than border-left in email)
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td width="4" style="background-color:${signal.color};` +
      `border-radius:2px 0 0 2px;">&nbsp;</td>\n` +
    `<td style="background-color:${bgTint};padding:14px 18px;">\n` +
    `<p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1a1a2e;` +
      `font-family:Arial,Helvetica,sans-serif;">⚠️ HIGH ALERT</p>\n` +
    `<p style="margin:0;font-size:14px;color:#333333;line-height:1.65;` +
      `font-family:Arial,Helvetica,sans-serif;">${warningText}</p>\n` +
    `</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 3. Hero block: large MMI number on signal colour background */
function renderHero(signal) {
  return (
    `<tr>\n` +
    `<td style="background-color:${signal.color};padding:40px 24px;text-align:center;">\n` +
    `<p style="margin:0;font-size:48px;font-weight:700;color:#ffffff;` +
      `line-height:1;font-family:Arial,Helvetica,sans-serif;">${fmtMMI(signal.mmi)}</p>\n` +
    `<p style="margin:12px 0 0;font-size:22px;color:rgba(255,255,255,0.95);` +
      `font-family:Arial,Helvetica,sans-serif;">${signal.emoji} ${signal.signal}</p>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 4. Today's Reading: MMI | Zone | Momentum + deltas */
function renderReadings(signal) {
  const dayCol   = signal.mmiDelta     >= 0 ? "#16a34a" : "#dc2626";
  const weekCol  = signal.mmiDeltaWeek >= 0 ? "#16a34a" : "#dc2626";
  const dayDelta = fmtDelta(signal.mmiDelta);
  const wkDelta  = fmtDelta(signal.mmiDeltaWeek);

  return (
    `<tr>\n` +
    `<td style="background-color:#f8f9fa;padding:20px 24px;` +
      `border-top:1px solid #e9ecef;border-bottom:1px solid #e9ecef;">\n` +
    `<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Today’s Reading</p>\n` +
    `<p style="margin:0 0 14px;font-size:15px;color:#212529;` +
      `font-family:Arial,Helvetica,sans-serif;">\n` +
    `<strong>MMI:</strong> ${fmtMMI(signal.mmi)}` +
    `&nbsp;&nbsp;|&nbsp;&nbsp;` +
    `<strong>Zone:</strong> ${zoneLabel(signal.zone)}` +
    `&nbsp;&nbsp;|&nbsp;&nbsp;` +
    `<strong>Momentum:</strong> ${momentumLabel(signal.momentum)}` +
    `</p>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td width="50%" style="font-size:13px;color:#495057;` +
      `font-family:Arial,Helvetica,sans-serif;padding-right:8px;">` +
      `Change from yesterday:&nbsp;` +
      `<strong style="color:${dayCol};">${dayDelta} pts</strong></td>\n` +
    `<td width="50%" style="font-size:13px;color:#495057;` +
      `font-family:Arial,Helvetica,sans-serif;">` +
      `Change from last week:&nbsp;` +
      `<strong style="color:${weekCol};">${wkDelta} pts</strong></td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 5. "What This Means" — action text in coloured left-border box */
function renderAction(signal) {
  return (
    `<tr>\n` +
    `<td style="padding:20px 24px 0;">\n` +
    `<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">What This Means</p>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td width="4" style="background-color:${signal.color};` +
      `border-radius:2px 0 0 2px;">&nbsp;</td>\n` +
    `<td style="background-color:#f8f9fa;padding:14px 18px;">\n` +
    `<p style="margin:0;font-size:14px;color:#212529;line-height:1.65;` +
      `font-family:Arial,Helvetica,sans-serif;">${signal.action}</p>\n` +
    `</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 6. Market Analysis — signal.analysis paragraph */
function renderAnalysis(signal) {
  return (
    `<tr>\n` +
    `<td style="padding:20px 24px 0;">\n` +
    `<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Market Analysis</p>\n` +
    `<p style="margin:0;font-size:14px;color:#333333;line-height:1.75;` +
      `font-family:Arial,Helvetica,sans-serif;">${signal.analysis}</p>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 7. Index Levels — 2-row table */
function renderIndexLevels(signal) {
  const n50  = fmtIndex(signal.nifty50Close);
  const nn50 = fmtIndex(signal.niftyNext50Close);

  return (
    `<tr>\n` +
    `<td style="padding:20px 24px 0;">\n` +
    `<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Index Levels</p>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="border:1px solid #dee2e6;border-radius:4px;overflow:hidden;">\n` +
    // Row 1
    `<tr style="background-color:#f8f9fa;">\n` +
    `<td style="padding:10px 16px;font-size:13px;color:#495057;` +
      `font-family:Arial,Helvetica,sans-serif;` +
      `border-bottom:1px solid #dee2e6;">Nifty 50</td>\n` +
    `<td align="right" style="padding:10px 16px;font-size:13px;font-weight:700;` +
      `color:#212529;font-family:Arial,Helvetica,sans-serif;` +
      `border-bottom:1px solid #dee2e6;">${n50}</td>\n` +
    `</tr>\n` +
    // Row 2
    `<tr>\n` +
    `<td style="padding:10px 16px;font-size:13px;color:#495057;` +
      `font-family:Arial,Helvetica,sans-serif;">Nifty Next 50</td>\n` +
    `<td align="right" style="padding:10px 16px;font-size:13px;font-weight:700;` +
      `color:#212529;font-family:Arial,Helvetica,sans-serif;">${nn50}</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 8. Sub-Indicators — 3-column mini-table: FII | VIX | Put/Call Skew */
function renderSubIndicators(signal) {
  const si   = signal.subIndicators ?? {};
  const fii  = fmtFii(si.fii);
  const vix  = fmtNum(si.vix, 2);
  const skew = fmtDelta(si.skew);

  const thStyle =
    `padding:8px 12px;font-size:12px;color:#6c757d;` +
    `font-family:Arial,Helvetica,sans-serif;` +
    `border-bottom:1px solid #dee2e6;background-color:#f8f9fa;`;
  const thMidStyle = thStyle + `border-right:1px solid #dee2e6;`;
  const tdStyle =
    `padding:12px;font-size:14px;font-weight:700;color:#212529;` +
    `font-family:Arial,Helvetica,sans-serif;`;
  const tdMidStyle = tdStyle + `border-right:1px solid #dee2e6;`;

  return (
    `<tr>\n` +
    `<td style="padding:20px 24px 0;">\n` +
    `<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Sub-Indicators</p>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="border:1px solid #dee2e6;border-radius:4px;overflow:hidden;">\n` +
    // Header row
    `<tr>\n` +
    `<th style="${thMidStyle}">FII Net (&#8377;Cr)</th>\n` +
    `<th style="${thMidStyle}">VIX</th>\n` +
    `<th style="${thStyle}">Put/Call Skew</th>\n` +
    `</tr>\n` +
    // Data row
    `<tr>\n` +
    `<td style="${tdMidStyle}">${fii}</td>\n` +
    `<td style="${tdMidStyle}">${vix}</td>\n` +
    `<td style="${tdStyle}">${skew}</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** 9. Historical Context (Template B only) */
function renderHistoricalContext() {
  return (
    `<tr>\n` +
    `<td style="padding:20px 24px 0;">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td style="background-color:#fff8e1;border:1px solid #ffd54f;` +
      `border-radius:4px;padding:14px 18px;">\n` +
    `<p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#f57f17;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Historical Context</p>\n` +
    `<p style="margin:0;font-size:13px;color:#5d4037;line-height:1.65;` +
      `font-family:Arial,Helvetica,sans-serif;">` +
      `Levels above 80 or below 30 are rare — occurring less than 10% of trading days. ` +
      `View the full MMI history chart at ` +
      `<a href="https://mmi.stockmaniacs.net" ` +
        `style="color:#1565c0;text-decoration:none;">mmi.stockmaniacs.net</a>` +
      `</p>\n` +
    `</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

/** Vertical spacer row */
function renderSpacer(heightPx) {
  return (
    `<tr>\n` +
    `<td style="height:${heightPx}px;line-height:${heightPx}px;font-size:1px;">&nbsp;</td>\n` +
    `</tr>`
  );
}

/** 10. Footer */
function renderFooter() {
  return (
    `<tr>\n` +
    `<td style="padding:20px 24px;border-top:1px solid #dee2e6;text-align:center;">\n` +
    `<p style="margin:0 0 6px;font-size:11px;color:#adb5bd;` +
      `font-family:Arial,Helvetica,sans-serif;">` +
      `Automated daily alert from StockManiacs.net — Not investment advice.` +
    `</p>\n` +
    `<p style="margin:0;font-size:11px;color:#adb5bd;` +
      `font-family:Arial,Helvetica,sans-serif;">` +
      `© StockManiacs` +
      `&nbsp;|&nbsp;` +
      `<a href="https://stockmaniacs.net" ` +
        `style="color:#6c757d;text-decoration:none;">stockmaniacs.net</a>` +
      `&nbsp;|&nbsp;` +
      `View MMI Dashboard:&nbsp;` +
      `<a href="https://mmi.stockmaniacs.net" ` +
        `style="color:#6c757d;text-decoration:none;">mmi.stockmaniacs.net</a>` +
    `</p>\n` +
    `</td>\n` +
    `</tr>`
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format an MMI value to 1 decimal place.
 * @param {number|null} val
 * @returns {string}
 */
function fmtMMI(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(1);
}

/**
 * Format a delta value with explicit sign (+/-).
 * @param {number|null} val
 * @returns {string}
 */
function fmtDelta(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  return (n >= 0 ? "+" : "") + n.toFixed(1);
}

/**
 * Format a generic number to `decimals` places.
 * @param {number|null} val
 * @param {number}      [decimals=2]
 * @returns {string}
 */
function fmtNum(val, decimals) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(decimals ?? 2);
}

/**
 * Format an index closing price as an Indian-style ₹ amount.
 * Uses Intl.NumberFormat with the en-IN locale.
 * @param {number|null} val
 * @returns {string}
 */
function fmtIndex(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return new Intl.NumberFormat("en-IN", {
    style:                 "currency",
    currency:              "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(val));
}

/**
 * Format an FII flow value (₹ crore) with explicit sign.
 * @param {number|null} val
 * @returns {string}
 */
function fmtFii(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

/**
 * Convert a zone key to a human-readable label.
 * @param {string} zone
 * @returns {string}
 */
function zoneLabel(zone) {
  const MAP = {
    extreme_fear:       "Extreme Fear",
    fear:               "Fear",
    greed:              "Greed",
    extreme_greed:      "Extreme Greed",
    high_extreme_greed: "High Extreme Greed",
  };
  return MAP[zone] ?? zone;
}

/**
 * Convert a momentum key to a human-readable label.
 * @param {string} momentum
 * @returns {string}
 */
function momentumLabel(momentum) {
  const MAP = {
    rising_fast:  "Rising Fast",
    rising:       "Rising",
    neutral:      "Neutral",
    falling:      "Falling",
    falling_fast: "Falling Fast",
  };
  return MAP[momentum] ?? momentum;
}

/**
 * Convert a 6-digit hex colour to an rgba() string.
 * Example: hexToRgba("#dc2626", 0.10) → "rgba(220,38,38,0.10)"
 * @param {string} hex    - "#rrggbb"
 * @param {number} alpha  - 0–1
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
