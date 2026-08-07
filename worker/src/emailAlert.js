/**
 * emailAlert.js
 * Sends an MMI signal alert via the Brevo (SendinBlue) Transactional Email API.
 *
 * Signature: sendEmailAlert(signal, env)
 *
 * Required env bindings (wrangler.toml [vars] or secrets):
 *   BREVO_API_KEY         (secret)
 *   BREVO_SENDER_EMAIL    (var)
 *   BREVO_SENDER_NAME     (var)
 *   ALERT_RECIPIENTS      (var) — comma-separated email addresses
 */

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Send the signal alert email.
 * Silently skips if no recipients are configured.
 *
 * @param {object} signal - return value of computeSignal()
 * @param {object} env    - Cloudflare Worker env bindings
 * @returns {Promise<void>}
 */
export async function sendEmailAlert(signal, env) {
  const recipients = parseRecipients(env.ALERT_RECIPIENTS);

  if (!recipients.length) {
    console.warn("[emailAlert] ALERT_RECIPIENTS is empty — skipping email.");
    return;
  }

  const subject = buildSubject(signal);
  const html    = buildHTML(signal);
  const text    = buildText(signal);

  const payload = {
    sender: {
      email: env.BREVO_SENDER_EMAIL,
      name:  env.BREVO_SENDER_NAME,
    },
    to:          recipients.map((email) => ({ email })),
    subject,
    htmlContent: html,
    textContent: text,
  };

  const res = await fetch(BREVO_SEND_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key":      env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo API ${res.status}: ${body}`);
  }

  console.log(
    `[emailAlert] Sent to ${recipients.length} recipient(s). ` +
    `Subject: "${subject}"`
  );
}

// ---------------------------------------------------------------------------
// Email builders
// ---------------------------------------------------------------------------

function buildSubject(s) {
  return `${s.emoji} MMI ${s.signal} — ${s.mmi.toFixed(1)} | ${s.date}`;
}

function buildHTML(s) {
  const col     = s.color;
  const nifty50 = s.nifty50Close   != null ? `₹${s.nifty50Close.toLocaleString("en-IN")}` : "—";
  const nxtFty  = s.niftyNext50Close != null ? `₹${s.niftyNext50Close.toLocaleString("en-IN")}` : "—";
  const vix     = s.subIndicators?.vix   != null ? s.subIndicators.vix.toFixed(2)   : "—";
  const fii     = s.subIndicators?.fii   != null ? s.subIndicators.fii.toFixed(2)   : "—";
  const deltaSign = s.mmiDelta >= 0 ? `▲ +${s.mmiDelta.toFixed(1)}` : `▼ ${s.mmiDelta.toFixed(1)}`;
  const weekSign  = s.mmiDeltaWeek >= 0 ? `+${s.mmiDeltaWeek.toFixed(1)}` : s.mmiDeltaWeek.toFixed(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>MMI Alert</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
       style="background:#1e293b;border-radius:16px;overflow:hidden;
              box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:600px;width:100%;">

  <!-- Header bar -->
  <tr>
    <td style="background:${col};padding:28px 32px;text-align:center;">
      <div style="font-size:13px;color:rgba(255,255,255,.75);letter-spacing:2px;
                  text-transform:uppercase;margin-bottom:4px;">Market Mood Index Alert</div>
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">${s.date}</h1>
    </td>
  </tr>

  <!-- MMI value + delta -->
  <tr>
    <td style="padding:36px 32px 0;text-align:center;">
      <div style="display:inline-block;background:${col}22;border:2px solid ${col};
                  border-radius:16px;padding:24px 40px;">
        <div style="font-size:60px;font-weight:800;color:${col};line-height:1;">
          ${s.mmi.toFixed(1)}
        </div>
        <div style="font-size:14px;color:#94a3b8;margin-top:6px;">
          ${deltaSign} today &nbsp;|&nbsp; ${weekSign} this week
        </div>
      </div>
    </td>
  </tr>

  <!-- Signal badge -->
  <tr>
    <td style="padding:20px 32px 0;text-align:center;">
      <span style="display:inline-block;background:${col};color:#fff;
                   font-size:20px;font-weight:800;padding:12px 32px;
                   border-radius:50px;letter-spacing:3px;">
        ${s.emoji} ${s.signal}
      </span>
    </td>
  </tr>

  <!-- Zone label -->
  <tr>
    <td style="padding:12px 32px 0;text-align:center;">
      <span style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">
        ${s.zone.replace(/_/g, " ")}
      </span>
      &nbsp;·&nbsp;
      <span style="font-size:13px;color:#94a3b8;">
        Momentum: <strong style="color:#f1f5f9;">${s.momentum.replace(/_/g, " ")}</strong>
      </span>
    </td>
  </tr>

  <!-- Action -->
  <tr>
    <td style="padding:20px 32px 0;">
      <div style="background:#0f172a;border-left:4px solid ${col};
                  border-radius:4px;padding:16px 20px;">
        <p style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.7;">
          <strong style="color:#f1f5f9;">Action:</strong> ${s.action}
        </p>
      </div>
    </td>
  </tr>

  <!-- Analysis -->
  <tr>
    <td style="padding:16px 32px 0;">
      <div style="background:#0f172a;border-radius:8px;padding:18px 20px;">
        <p style="margin:0 0 6px;font-size:11px;color:#64748b;
                  text-transform:uppercase;letter-spacing:1px;">Analysis</p>
        <p style="margin:0;color:#cbd5e1;font-size:13px;line-height:1.75;">
          ${s.analysis}
        </p>
      </div>
    </td>
  </tr>

  <!-- Index + sub-indicator table -->
  <tr>
    <td style="padding:20px 32px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr style="background:#0f172a;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#64748b;
                     text-transform:uppercase;border-bottom:1px solid #334155;">Index / Indicator</th>
          <th style="padding:10px 14px;text-align:right;font-size:11px;color:#64748b;
                     text-transform:uppercase;border-bottom:1px solid #334155;">Value</th>
        </tr>
        ${row("Nifty 50",     nifty50)}
        ${row("Nifty Next 50", nxtFty)}
        ${row("India VIX",    vix)}
        ${row("FII Flow",     fii)}
      </table>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="padding:28px 32px;text-align:center;border-top:1px solid #334155;margin-top:20px;">
      <p style="margin:0;font-size:12px;color:#475569;">
        <a href="https://mmi.stockmaniacs.net"
           style="color:#6366f1;text-decoration:none;font-weight:600;">
          View Dashboard
        </a>
        &nbsp;·&nbsp;
        StockManiacs MMI Trading System
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function row(label, val) {
  return `
    <tr>
      <td style="padding:11px 14px;font-size:13px;color:#cbd5e1;
                 border-bottom:1px solid #1e293b;">${label}</td>
      <td style="padding:11px 14px;text-align:right;font-size:13px;
                 font-weight:600;color:#f1f5f9;border-bottom:1px solid #1e293b;">${val}</td>
    </tr>`;
}

function buildText(s) {
  const deltaSign = s.mmiDelta >= 0 ? `+${s.mmiDelta.toFixed(1)}` : s.mmiDelta.toFixed(1);
  return [
    `${s.emoji} MMI ALERT — ${s.date}`,
    "─".repeat(44),
    `MMI          : ${s.mmi.toFixed(1)} (${deltaSign} today)`,
    `Zone         : ${s.zone.replace(/_/g, " ")}`,
    `Signal       : ${s.signal}`,
    `Momentum     : ${s.momentum.replace(/_/g, " ")}`,
    "",
    `Action: ${s.action}`,
    "",
    "Analysis:",
    s.analysis,
    "",
    "Market Data:",
    `  Nifty 50       : ${s.nifty50Close   != null ? s.nifty50Close   : "N/A"}`,
    `  Nifty Next 50  : ${s.niftyNext50Close != null ? s.niftyNext50Close : "N/A"}`,
    `  India VIX      : ${s.subIndicators?.vix ?? "N/A"}`,
    `  FII Flow       : ${s.subIndicators?.fii ?? "N/A"}`,
    "",
    "Dashboard: https://mmi.stockmaniacs.net",
    "StockManiacs MMI Trading System",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRecipients(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
