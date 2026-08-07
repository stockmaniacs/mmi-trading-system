/**
 * index.js — MMI Trading System · Cloudflare Worker
 *
 * Scheduled trigger (wrangler.toml):
 *   crons = ["30 10 * * 1-5"]   →   10:30 UTC = 4:00 PM IST, weekdays
 *
 * HTTP endpoints:
 *   GET  /api/signal              latest signal (JSON)
 *   GET  /api/history             all signals (JSON array)
 *   GET  /api/health              { status: "ok", lastUpdated }
 *   GET  /api/trigger?token=<T>   manual run (requires TRIGGER_TOKEN secret)
 */

import { getHolidays, isMarketOpen } from './fetchHolidays.js';
import { fetchMMI }                   from './fetchMMI.js';
import { fetchIndices }               from './fetchIndices.js';
import { computeSignal }              from './signalEngine.js';
import { pushToGitHub }               from './pushToGitHub.js';
import { sendEmailAlert }             from './emailAlert.js';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Returns today's date string ("YYYY-MM-DD") in the Asia/Kolkata timezone.
 * Uses the en-CA locale which produces ISO-style YYYY-MM-DD output.
 */
function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  // ── Cron handler ──────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const today = getTodayIST();

    // Step 1: Get holidays from Upstox API (cached in KV for 30 days)
    const holidays = await getHolidays(env);

    // Step 2: Check if market is open today
    if (!isMarketOpen(today, holidays)) {
      console.log(`Market closed on ${today} — skipping run`);
      return;
    }

    // Step 3: Fetch MMI and index data in parallel
    let mmiData;
    try {
      mmiData = await fetchMMI();
    } catch (err) {
      console.error(`[scheduled] MMI fetch failed: ${err.message} — aborting run`);
      return; // Can't compute a signal without MMI
    }

    const indicesData = await fetchIndices(); // non-throwing; returns nulls on failure

    // Step 4: Read previous signal from KV for delta calculation
    const prevRaw    = await env.MMI_KV.get('latest-signal');
    const previousMMI = prevRaw ? JSON.parse(prevRaw).mmi : null;

    // Step 5: Compute the signal
    const signal = computeSignal(mmiData, indicesData, previousMMI);

    // Step 6: Write latest signal + timestamp to KV
    await env.MMI_KV.put('latest-signal', JSON.stringify(signal));
    await env.MMI_KV.put('last-updated',  new Date().toISOString());

    // Step 7: Append to history, update KV signals-history, commit to GitHub
    try {
      await pushToGitHub(signal, env);
    } catch (err) {
      console.error(`[scheduled] GitHub push failed: ${err.message}`);
      // Non-fatal — KV is the live source of truth; GitHub is the persisted backup
    }

    // Step 8: Send email alert
    try {
      await sendEmailAlert(signal, env);
    } catch (err) {
      console.error(`[scheduled] Email alert failed: ${err.message}`);
    }

    console.log(
      `Done: MMI=${signal.mmi} | Signal=${signal.signal} | ` +
      `Zone=${signal.zone} | Momentum=${signal.momentum} | Date=${today}`
    );
  },

  // ── HTTP handler ──────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url     = new URL(request.url);
    const headers = {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Latest signal
    if (url.pathname === '/api/signal') {
      const data = await env.MMI_KV.get('latest-signal');
      return new Response(data || '{}', { headers });
    }

    // Full signal history
    if (url.pathname === '/api/history') {
      const data = await env.MMI_KV.get('signals-history');
      return new Response(data || '[]', { headers });
    }

    // Health check
    if (url.pathname === '/api/health') {
      const lastUpdated = await env.MMI_KV.get('last-updated');
      return new Response(
        JSON.stringify({ status: 'ok', lastUpdated }),
        { headers }
      );
    }

    // Manual trigger — protected by TRIGGER_TOKEN secret
    if (
      url.pathname === '/api/trigger' &&
      url.searchParams.get('token') === env.TRIGGER_TOKEN
    ) {
      ctx.waitUntil(this.scheduled({}, env, ctx));
      return new Response(
        JSON.stringify({ status: 'triggered', date: getTodayIST() }),
        { headers }
      );
    }

    return new Response('Not Found', { status: 404 });
  },
};
