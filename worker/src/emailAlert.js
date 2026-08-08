/**
 * emailAlert.js
 * Sends MMI signal alerts via Hostinger SMTP using cloudflare:sockets.
 *
 * Required env bindings:
 *   SMTP_HOST     (var)    — "smtp.hostinger.com"
 *   SMTP_USER     (var)    — sender address, e.g. "alerts@stockmaniacs.net"
 *   SMTP_PASSWORD (secret) — Hostinger email account password
 *
 * Protocol: port 587 with STARTTLS (more widely supported than port 465 SMTPS).
 *
 * Template A — Standard daily alert  (signal.isHighAlert === false)
 *   Subject: "📊 MMI Daily: {mmi} — {signal} | {date}"
 *
 * Template B — HIGH ALERT            (signal.isHighAlert === true)
 *   Subject: "🚨 HIGH ALERT — MMI {mmi}: {signal} | StockManiacs"
 *   Adds a coloured warning banner + Historical Context section.
 */

import { connect } from 'cloudflare:sockets';

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
 * Send the MMI signal alert email via Hostinger SMTP.
 * Email failures are logged but DO NOT throw — must not abort the cron job.
 *
 * @param {object} signal - return value of computeSignal()
 * @param {object} env    - Cloudflare Worker env bindings
 */
export async function sendEmailAlert(signal, env) {
  const subject  = buildSubject(signal);
  const htmlBody = generateEmailHTML(signal);

  try {
    await smtpSend({
      host:        env.SMTP_HOST || "smtp.hostinger.com",
      user:        env.SMTP_USER,
      pass:        env.SMTP_PASSWORD,
      toAddresses: RECIPIENTS.map((r) => r.email),
      subject,
      html:        htmlBody,
    });
    console.log(`[emailAlert] Sent: ${subject}`);
  } catch (err) {
    console.error(`[emailAlert] SMTP send failed — ${err.message}`);
    // Do NOT throw — email failure must not abort the cron job
  }
}

// ---------------------------------------------------------------------------
// SMTP client using cloudflare:sockets (port 587 + STARTTLS)
// ---------------------------------------------------------------------------

/**
 * Connect to the SMTP server on port 587 (plaintext), perform STARTTLS to
 * upgrade to TLS, then authenticate and send one email.
 *
 * Uses AUTH LOGIN (base64 username + password, standard for Hostinger).
 * Uses Content-Transfer-Encoding: base64 so the HTML body is 7-bit safe.
 *
 * We deliberately use port 587 + STARTTLS rather than port 465 direct SSL
 * because it is more reliably reachable from Cloudflare Workers edge IPs.
 */
async function smtpSend({ host, user, pass, toAddresses, subject, html }) {
  const enc = new TextEncoder();

  // ── 1. Plain connection on port 587 ────────────────────────────────────
  const plainSocket = connect(`${host}:587`, { secureTransport: "starttls" });
  let smtp   = new SMTPReader(plainSocket.readable);
  let writer = plainSocket.writable.getWriter();

  /** Write one CRLF-terminated command to the current writer. */
  const write = async (cmd) => writer.write(enc.encode(cmd + "\r\n"));

  /** Read one SMTP response and assert the expected code; throw on mismatch. */
  const expect = async (code) => {
    const resp = await smtp.readResponse();
    if (resp.code !== code) {
      throw new Error(`Expected ${code}, got ${resp.code}: ${resp.lines.join(" | ")}`);
    }
    return resp;
  };

  try {
    // ── 2. Server greeting ─────────────────────────────────────────────
    await expect("220");

    // ── 3. EHLO — discover capabilities ───────────────────────────────
    await write("EHLO mmi-worker");
    const ehlo1 = await expect("250");

    // ── 4. STARTTLS ────────────────────────────────────────────────────
    if (!ehlo1.lines.some((l) => /STARTTLS/i.test(l))) {
      throw new Error("SMTP server did not advertise STARTTLS capability");
    }
    await write("STARTTLS");
    await expect("220"); // "Go ahead"

    // ── 5. Upgrade to TLS — release plain-socket locks first ──────────
    smtp.releaseReader();
    writer.releaseLock();

    const secureSocket = plainSocket.startTls();
    smtp   = new SMTPReader(secureSocket.readable);
    writer = secureSocket.writable.getWriter();

    // ── 6. Re-EHLO over TLS ────────────────────────────────────────────
    await write("EHLO mmi-worker");
    await expect("250");

    // ── 7. AUTH LOGIN ──────────────────────────────────────────────────
    await write("AUTH LOGIN");
    await expect("334"); // "Username:"
    await write(btoa(user));
    await expect("334"); // "Password:"
    await write(btoa(pass));
    await expect("235"); // "Authentication successful"

    // ── 8. Envelope sender (must match authenticated user on Hostinger) ─
    await write(`MAIL FROM:<${user}>`);
    await expect("250");

    // ── 9. Envelope recipients ─────────────────────────────────────────
    for (const addr of toAddresses) {
      await write(`RCPT TO:<${addr}>`);
      await expect("250");
    }

    // ── 10. DATA command ───────────────────────────────────────────────
    await write("DATA");
    await expect("354");

    // ── 11. RFC 2822 message — base64 body avoids dot-stuffing issues ──
    const toHeader = toAddresses.join(", ");
    const b64Html  = utf8ToBase64(html);
    const b64Lines = chunkBase64(b64Html, 76); // RFC 2045: max 76 chars/line

    const messageParts = [
      `Date: ${new Date().toUTCString()}`,
      `From: StockManiacs Alerts <${user}>`,
      `To: ${toHeader}`,
      `Subject: ${mimeEncodeHeader(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,          // blank line separates headers from body
      ...b64Lines,
      ``,          // blank line before DATA terminator
      `.`,         // SMTP end-of-DATA marker (CRLF appended by write())
    ];

    await write(messageParts.join("\r\n"));
    await expect("250"); // message accepted

    // ── 12. QUIT ───────────────────────────────────────────────────────
    await write("QUIT");
    // Don't await 221 — server may close the connection immediately

  } finally {
    // Best-effort cleanup — release any remaining stream locks
    try { smtp.releaseReader(); } catch (_) { /* ignore */ }
    try { writer.releaseLock();  } catch (_) { /* ignore */ }
    try { plainSocket.close();   } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// SMTPReader — buffered line-by-line reader for the SMTP response stream
// ---------------------------------------------------------------------------

class SMTPReader {
  constructor(readable) {
    this.reader  = readable.getReader();
    this.buffer  = "";
    this.decoder = new TextDecoder();
  }

  /** Release the reader lock so the socket can be upgraded (STARTTLS). */
  releaseReader() {
    try { this.reader.releaseLock(); } catch (_) { /* ignore */ }
  }

  /** Read one CRLF-terminated line from the stream. */
  async readLine() {
    while (!this.buffer.includes("\r\n")) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP: connection closed unexpectedly");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const idx  = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 2);
    return line;
  }

  /**
   * Read a complete (possibly multi-line) SMTP response.
   * Multi-line responses use "NNN-" continuation; the final line uses "NNN ".
   * Returns { code: "250", lines: ["250-SIZE 73400320", ..., "250 OK"] }
   */
  async readResponse() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      // 4th character is ' ' on the last line, '-' on continuation lines
      if (line.length < 4 || line[3] === " ") break;
    }
    const last = lines[lines.length - 1];
    return { code: last.slice(0, 3), lines };
  }
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

/**
 * Encode a potentially non-ASCII subject line per RFC 2047 (Q-encoding in base64).
 * Handles emoji and multi-byte characters safely.
 */
function mimeEncodeHeader(str) {
  return `=?UTF-8?B?${utf8ToBase64(str)}?=`;
}

/**
 * Convert a JS string to base64-encoded UTF-8.
 * Works with full Unicode (emoji, ₹, —, …) in Cloudflare Workers.
 */
function utf8ToBase64(str) {
  const bytes  = new TextEncoder().encode(str);
  let   binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Split a base64 string into fixed-width lines (RFC 2045 §6.8: max 76 chars).
 */
function chunkBase64(b64, width) {
  const lines = [];
  for (let i = 0; i < b64.length; i += width) {
    lines.push(b64.slice(i, i + width));
  }
  return lines;
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
    return `\u{1F6A8} HIGH ALERT — MMI ${mmi}: ${signal.signal} | StockManiacs`;
  }
  return `\u{1F4CA} MMI Daily: ${mmi} — ${signal.signal} | ${signal.date}`;
}

// ---------------------------------------------------------------------------
// Section renderers — each returns a <tr>…</tr> string
// ---------------------------------------------------------------------------

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
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n` +
    `<tr>\n` +
    `<td width="4" style="background-color:${signal.color};` +
      `border-radius:2px 0 0 2px;">&nbsp;</td>\n` +
    `<td style="background-color:${bgTint};padding:14px 18px;">\n` +
    `<p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#1a1a2e;` +
      `font-family:Arial,Helvetica,sans-serif;">&#x26A0;&#xFE0F; HIGH ALERT</p>\n` +
    `<p style="margin:0;font-size:14px;color:#333333;line-height:1.65;` +
      `font-family:Arial,Helvetica,sans-serif;">${warningText}</p>\n` +
    `</td>\n` +
    `</tr>\n` +
    `</table>\n` +
    `</td>\n` +
    `</tr>`
  );
}

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

function renderReadings(signal) {
  const dayCol   = (signal.mmiDelta     ?? 0) >= 0 ? "#16a34a" : "#dc2626";
  const weekCol  = (signal.mmiDeltaWeek ?? 0) >= 0 ? "#16a34a" : "#dc2626";
  const dayDelta = fmtDelta(signal.mmiDelta);
  const wkDelta  = fmtDelta(signal.mmiDeltaWeek);

  return (
    `<tr>\n` +
    `<td style="background-color:#f8f9fa;padding:20px 24px;` +
      `border-top:1px solid #e9ecef;border-bottom:1px solid #e9ecef;">\n` +
    `<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#6c757d;` +
      `text-transform:uppercase;letter-spacing:1px;` +
      `font-family:Arial,Helvetica,sans-serif;">Today's Reading</p>\n` +
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
    `<tr style="background-color:#f8f9fa;">\n` +
    `<td style="padding:10px 16px;font-size:13px;color:#495057;` +
      `font-family:Arial,Helvetica,sans-serif;` +
      `border-bottom:1px solid #dee2e6;">Nifty 50</td>\n` +
    `<td align="right" style="padding:10px 16px;font-size:13px;font-weight:700;` +
      `color:#212529;font-family:Arial,Helvetica,sans-serif;` +
      `border-bottom:1px solid #dee2e6;">${n50}</td>\n` +
    `</tr>\n` +
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
    `<tr>\n` +
    `<th style="${thMidStyle}">FII Net (&#8377;Cr)</th>\n` +
    `<th style="${thMidStyle}">VIX</th>\n` +
    `<th style="${thStyle}">Put/Call Skew</th>\n` +
    `</tr>\n` +
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

function renderSpacer(heightPx) {
  return (
    `<tr>\n` +
    `<td style="height:${heightPx}px;line-height:${heightPx}px;font-size:1px;">&nbsp;</td>\n` +
    `</tr>`
  );
}

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

function fmtMMI(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(1);
}

function fmtDelta(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  return (n >= 0 ? "+" : "") + n.toFixed(1);
}

function fmtNum(val, decimals) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(decimals ?? 2);
}

function fmtIndex(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(val));
}

function fmtFii(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

function zoneLabel(zone) {
  const MAP = {
    extreme_fear: "Extreme Fear", fear: "Fear", greed: "Greed",
    extreme_greed: "Extreme Greed", high_extreme_greed: "High Extreme Greed",
  };
  return MAP[zone] ?? zone;
}

function momentumLabel(momentum) {
  const MAP = {
    rising_fast: "Rising Fast", rising: "Rising", neutral: "Neutral",
    falling: "Falling", falling_fast: "Falling Fast",
  };
  return MAP[momentum] ?? momentum;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
