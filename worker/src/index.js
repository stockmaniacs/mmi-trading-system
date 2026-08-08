/**
 * index.js — MMI Trading System · Cloudflare Worker
 *
 * Scheduled trigger (wrangler.toml):
 *   crons = ["30 10 * * 1-5"]   →   10:30 UTC = 4:00 PM IST, weekdays
 *
 * HTTP endpoints:
 *   GET  /api/signal                        latest signal (JSON)
 *   GET  /api/history                       all signals (JSON array)
 *   GET  /api/health                        { status: "ok", lastUpdated }
 *   GET  /api/trigger?token=<T>             manual run — respects market-open check
 *   GET  /api/trigger?token=<T>&force=true  force run regardless of day/holiday
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
 */
function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ---------------------------------------------------------------------------
// Core pipeline (shared by cron and manual trigger)
// ---------------------------------------------------------------------------

/**
 * Run the full MMI signal pipeline.
 *
 * @param {object}  env   - Cloudflare Worker env bindings
 * @param {boolean} force - when true, skips the market-open check
 */
async function runSignalPipeline(env, force = false) {
  const today = getTodayIST();

  // Step 1: Get NSE holidays (KV-cached, 30-day TTL)
  const holidays = await getHolidays(env);

  // Step 2: Market-open guard (bypassed when force=true)
  if (!force && !isMarketOpen(today, holidays)) {
    console.log(`[pipeline] Market closed on ${today} — skipping run`);
    return;
  }
  if (force) {
    console.log(`[pipeline] force=true — bypassing market-open check for ${today}`);
  }

  // Step 3: Fetch live MMI from TickerTape
  let mmiData;
  try {
    mmiData = await fetchMMI();
  } catch (err) {
    console.error(`[pipeline] MMI fetch failed: ${err.message} — aborting`);
    return;
  }

  // Step 4: Fetch index closes from Yahoo Finance (non-throwing)
  const indicesData = await fetchIndices();

  // Step 5: Read previous signal from KV for delta calculation
  const prevRaw    = await env.MMI_KV.get('latest-signal');
  const previousMMI = prevRaw ? JSON.parse(prevRaw).mmi : null;

  // Step 6: Compute signal
  const signal = computeSignal(mmiData, indicesData, previousMMI);

  // Step 7: Persist to KV
  await env.MMI_KV.put('latest-signal', JSON.stringify(signal));
  await env.MMI_KV.put('last-updated',  new Date().toISOString());

  // Step 8: Push to GitHub (non-fatal on failure)
  try {
    await pushToGitHub(signal, env);
  } catch (err) {
    console.error(`[pipeline] GitHub push failed: ${err.message}`);
  }

  // Step 9: Send email alert via Hostinger SMTP (non-fatal on failure)
  try {
    await sendEmailAlert(signal, env);
  } catch (err) {
    console.error(`[pipeline] Email alert failed: ${err.message}`);
  }

  console.log(
    `[pipeline] Done — MMI=${signal.mmi} | Zone=${signal.zone} | ` +
    `Signal=${signal.signal} | Momentum=${signal.momentum} | Date=${today}`
  );
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  // ── Cron handler (calls pipeline with force=false) ────────────────────────
  async scheduled(event, env, ctx) {
    await runSignalPipeline(env, false);
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

    // Manual trigger — protected by TRIGGER_TOKEN
    // ?force=true bypasses the market-open check (safe for testing on weekends)
    if (
      url.pathname === '/api/trigger' &&
      url.searchParams.get('token') === env.TRIGGER_TOKEN
    ) {
      const force = url.searchParams.get('force') === 'true';
      ctx.waitUntil(runSignalPipeline(env, force));
      return new Response(
        JSON.stringify({ status: 'triggered', date: getTodayIST(), force }),
        { headers }
      );
    }

    return new Response('Not Found', { status: 404 });
  },
};
