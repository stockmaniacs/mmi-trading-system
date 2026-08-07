/**
 * emailAlert.js
 * Sends signal-change alerts via the Brevo (SendinBlue) Transactional Email API.
 *
 * Environment variables expected (set in wrangler.toml [vars] or secrets):
 *   BREVO_API_KEY         (secret)
 *   BREVO_SENDER_EMAIL    (var)
 *   BREVO_SENDER_NAME     (var)
 *   ALERT_RECIPIENTS      (var, comma-separated list)
 */

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Send an MMI alert email to all configured recipients.
 *
 * @param {object} env        - Cloudflare Worker env bindings
 * @param {object} record     - Today's built record from signalEngine.buildRecord()
 * @param {string} alertReason - Human-readable reason for the alert
 * @returns {Promise<void>}
 */
export async function sendAlert(env, record, alertReason) {
  const recipients = parseRecipients(env.ALERT_RECIPIENTS);
  if (!recipients.length) {
    console.warn("[emailAlert] No ALERT_RECIPIENTS configured — skipping email.");
    return;
  }

  const subject = buildSubject(record);
  const html = buildHTML(record, alertReason);
  const text = buildText(record, alertReason);

  const payload = {
    sender: {
      email: env.BREVO_SENDER_EMAIL,
      name: env.BREVO_SENDER_NAME,
    },
    to: recipients.map((email) => ({ email })),
    subject,
    htmlContent: html,
    textContent: text,
  };

  const res = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${body}`);
  }

  console.log(`[emailAlert] Alert sent to ${recipients.length} recipient(s). Subject: "${subject}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse comma-separated email list; trim whitespace; filter blanks.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseRecipients(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {object} record
 * @returns {string}
 */
function buildSubject(record) {
  const emoji = signalEmoji(record.signal);
  return `${emoji} MMI Alert [${record.signal}] — MMI ${record.mmi} | ${record.date}`;
}

/**
 * @param {object} record
 * @param {string} alertReason
 * @returns {string}
 */
function buildHTML(record, alertReason) {
  const signalColor = record.color ?? "#334155";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MMI Alert</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;
                      box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <!-- Header -->
          <tr>
            <td style="background:${signalColor};padding:28px 32px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:1px;">
                📊 Market Mood Index Alert
              </h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px;">
                ${record.date}
              </p>
            </td>
          </tr>
          <!-- MMI Value -->
          <tr>
            <td style="padding:32px 32px 0;text-align:center;">
              <div style="display:inline-block;background:${signalColor}18;
                          border:2px solid ${signalColor};border-radius:12px;
                          padding:20px 36px;">
                <div style="font-size:52px;font-weight:700;color:${signalColor};
                             line-height:1;">${record.mmi}</div>
                <div style="font-size:15px;color:#475569;margin-top:6px;">
                  ${record.interpretation}
                </div>
              </div>
            </td>
          </tr>
          <!-- Signal Badge -->
          <tr>
            <td style="padding:20px 32px 0;text-align:center;">
              <span style="display:inline-block;background:${signalColor};
                           color:#fff;font-size:18px;font-weight:700;
                           padding:10px 28px;border-radius:50px;
                           letter-spacing:2px;">
                ${record.signal}
              </span>
            </td>
          </tr>
          <!-- Action -->
          <tr>
            <td style="padding:20px 32px 0;">
              <div style="background:#f1f5f9;border-left:4px solid ${signalColor};
                          border-radius:4px;padding:16px 20px;">
                <p style="margin:0;color:#334155;font-size:15px;line-height:1.6;">
                  <strong>Action:</strong> ${record.action}
                </p>
              </div>
            </td>
          </tr>
          <!-- Alert Reason -->
          <tr>
            <td style="padding:16px 32px 0;">
              <div style="background:#fffbeb;border:1px solid #fbbf24;
                          border-radius:4px;padding:12px 16px;">
                <p style="margin:0;color:#78350f;font-size:13px;">
                  ⚡ <strong>Why this alert:</strong> ${alertReason}
                </p>
              </div>
            </td>
          </tr>
          <!-- Index Table -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0"
                     style="border-collapse:collapse;">
                <tr style="background:#f8fafc;">
                  <th style="padding:10px 16px;text-align:left;font-size:13px;
                             color:#64748b;border-bottom:2px solid #e2e8f0;">
                    Index
                  </th>
                  <th style="padding:10px 16px;text-align:right;font-size:13px;
                             color:#64748b;border-bottom:2px solid #e2e8f0;">
                    Close
                  </th>
                </tr>
                <tr>
                  <td style="padding:12px 16px;font-size:14px;color:#1e293b;
                             border-bottom:1px solid #f1f5f9;">Nifty 50</td>
                  <td style="padding:12px 16px;text-align:right;font-size:14px;
                             font-weight:600;color:#1e293b;border-bottom:1px solid #f1f5f9;">
                    ₹${record.nifty50?.toLocaleString("en-IN") ?? "—"}
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;font-size:14px;color:#1e293b;">
                    Nifty Next 50
                  </td>
                  <td style="padding:12px 16px;text-align:right;font-size:14px;
                             font-weight:600;color:#1e293b;">
                    ₹${record.niftyNext50?.toLocaleString("en-IN") ?? "—"}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                StockManiacs MMI Trading System &bull;
                <a href="https://mmi.stockmaniacs.net" style="color:#6366f1;
                   text-decoration:none;">View Dashboard</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Plain-text fallback.
 * @param {object} record
 * @param {string} alertReason
 * @returns {string}
 */
function buildText(record, alertReason) {
  return [
    `MMI ALERT — ${record.date}`,
    `──────────────────────────`,
    `MMI Value   : ${record.mmi} (${record.interpretation})`,
    `Signal      : ${record.signal}`,
    `Action      : ${record.action}`,
    ``,
    `Why this alert: ${alertReason}`,
    ``,
    `Index Closes`,
    `  Nifty 50       : ${record.nifty50 ?? "N/A"}`,
    `  Nifty Next 50  : ${record.niftyNext50 ?? "N/A"}`,
    ``,
    `Dashboard: https://mmi.stockmaniacs.net`,
    `StockManiacs MMI Trading System`,
  ].join("\n");
}

/**
 * Returns an emoji that matches the signal strength.
 * @param {string} signal
 * @returns {string}
 */
function signalEmoji(signal) {
  const map = {
    "STRONG BUY": "🟢",
    "BUY": "💚",
    "HOLD": "🟡",
    "REDUCE": "🟠",
    "AVOID": "🔴",
  };
  return map[signal] ?? "📊";
}
