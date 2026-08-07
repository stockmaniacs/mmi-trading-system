/**
 * index.js — MMI Trading System · Cloudflare Worker
 *
 * Triggers:
 *   - Cron: 10:30 UTC Mon–Fri  (= 4:00 PM IST, after NSE close)
 *   - HTTP GET /api/latest      → last persisted record
 *   - HTTP GET /api/history     → full mmi-history.json
 *   - HTTP GET /api/signals     → last 90 signals
 *   - HTTP GET /api/status      → health check
 *   - HTTP POST /api/trigger    → manual run (protected by Bearer token)
 */

import { fetchMMI } from "./fetchMMI.js";
import { fetchIndices } from "./fetchIndices.js";
import { isHoliday } from "./fetchHolidays.js";
import { buildRecord, shouldSendAlert } from "./signalEngine.js";
import { sendAlert } from "./emailAlert.js";
import { pushToGitHub } from "./pushToGitHub.js";

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  /** Scheduled cron trigger */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyJob(env));
  },

  /** HTTP fetch handler */
  async fetch(request, env, ctx) {
    return handleHTTP(request, env, ctx);
  },
};

// ---------------------------------------------------------------------------
// Core job
// ---------------------------------------------------------------------------

/**
 * Run the full daily pipeline:
 *   1. Check if today is a trading day
 *   2. Fetch MMI + indices
 *   3. Classify into zone / signal
 *   4. Persist to KV
 *   5. Push to GitHub
 *   6. Send email if alert criteria met
 *
 * @param {object} env - Cloudflare Worker env bindings
 */
async function runDailyJob(env) {
  const today = todayIST();
  const dayOfWeek = new Date(today).getUTCDay(); // 0=Sun, 6=Sat

  console.log(`[job] Starting daily run for ${today}`);

  // Skip weekends (the cron pattern already filters, but guard anyway)
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log("[job] Weekend — skipping.");
    return;
  }

  // Check NSE holiday
  if (env.UPSTOX_ACCESS_TOKEN) {
    const holiday = await isHoliday(env.MMI_KV, env.UPSTOX_ACCESS_TOKEN, today);
    if (holiday) {
      console.log(`[job] ${today} is an NSE holiday — skipping.`);
      return;
    }
  } else {
    console.warn("[job] UPSTOX_ACCESS_TOKEN not set — skipping holiday check.");
  }

  // --- Fetch data ---
  const [mmiData, indicesData] = await Promise.all([
    fetchMMI(),
    fetchIndices().catch((err) => {
      console.error("[job] fetchIndices failed:", err.message);
      return { nifty50: null, niftyNext50: null };
    }),
  ]);

  const record = buildRecord({
    date: today,
    mmi: mmiData.mmi,
    interpretation: mmiData.interpretation,
    nifty50: indicesData.nifty50,
    niftyNext50: indicesData.niftyNext50,
  });

  console.log(`[job] Record: MMI=${record.mmi} Zone=${record.zone} Signal=${record.signal}`);

  // --- Load history from KV ---
  const rawHistory = await env.MMI_KV.get("mmi-history", "json") ?? [];
  const previousRecord = rawHistory.length > 0 ? rawHistory[rawHistory.length - 1] : null;

  // De-duplicate: replace if same date already exists
  const history = rawHistory.filter((r) => r.date !== today);
  history.push(record);

  // Signals = last 90 records
  const signals = history.slice(-90);

  // --- Persist to KV ---
  await Promise.all([
    env.MMI_KV.put("mmi-history", JSON.stringify(history)),
    env.MMI_KV.put("mmi-signals", JSON.stringify(signals)),
    env.MMI_KV.put("mmi-latest", JSON.stringify(record)),
  ]);

  console.log(`[job] KV updated. History length: ${history.length}`);

  // --- Push to GitHub ---
  try {
    await pushToGitHub(env, [
      { path: "data/mmi-history.json", content: history },
      { path: "data/signals.json", content: signals },
    ]);
  } catch (err) {
    console.error("[job] GitHub push failed:", err.message);
    // Non-fatal — KV is the source of truth; GitHub is a backup
  }

  // --- Email alert ---
  const { shouldAlert, reason } = shouldSendAlert(previousRecord, record);
  if (shouldAlert) {
    try {
      await sendAlert(env, record, reason);
    } catch (err) {
      console.error("[job] Email alert failed:", err.message);
    }
  } else {
    console.log("[job] No alert criteria met — skipping email.");
  }

  console.log(`[job] Done for ${today}.`);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

async function handleHTTP(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return corsResponse(new Response(null, { status: 204 }));
  }

  // Health check
  if (path === "/api/status") {
    return corsResponse(jsonOk({ status: "ok", time: new Date().toISOString() }));
  }

  // Latest record
  if (path === "/api/latest" && request.method === "GET") {
    const data = await env.MMI_KV.get("mmi-latest", "json");
    return corsResponse(data ? jsonOk(data) : jsonError(404, "No data yet"));
  }

  // Full history
  if (path === "/api/history" && request.method === "GET") {
    const data = await env.MMI_KV.get("mmi-history", "json") ?? [];
    return corsResponse(jsonOk(data));
  }

  // Recent signals
  if (path === "/api/signals" && request.method === "GET") {
    const data = await env.MMI_KV.get("mmi-signals", "json") ?? [];
    return corsResponse(jsonOk(data));
  }

  // Manual trigger (protected)
  if (path === "/api/trigger" && request.method === "POST") {
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!env.TRIGGER_SECRET || token !== env.TRIGGER_SECRET) {
      return corsResponse(jsonError(401, "Unauthorized"));
    }
    ctx.waitUntil(runDailyJob(env));
    return corsResponse(jsonOk({ queued: true, message: "Daily job triggered manually." }));
  }

  return corsResponse(jsonError(404, "Not found"));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function jsonOk(data) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return r;
}
