/**
 * dashboard.js
 * Fetches MMI signal data and renders the dashboard.
 *
 * Data strategy:
 *   1. Fetch latest signal  → GET {API_BASE}/api/signal
 *   2. Fetch history        → GET {HISTORY_URL} (GitHub raw, newest-first)
 *   3. If live API fails    → use history[0] as "latest"
 *   4. Chart uses oldest-first (reverse of HISTORY_URL order)
 *   5. Table shows first 30 entries (newest) from HISTORY_URL order
 */

'use strict';

// ── Config ─────────────────────────────────────────────────────────────────

const API_BASE    = 'https://mmi-worker.YOUR-SUBDOMAIN.workers.dev';
const HISTORY_URL = 'https://raw.githubusercontent.com/stockmaniacs/mmi-trading-system/main/data/signals.json';

// ── Zone meta ───────────────────────────────────────────────────────────────

const ZONE_META = {
  extreme_fear:       { label: 'Extreme Fear',       color: '#16a34a' },
  fear:               { label: 'Fear',               color: '#22c55e' },
  greed:              { label: 'Greed',              color: '#f59e0b' },
  extreme_greed:      { label: 'Extreme Greed',      color: '#f97316' },
  high_extreme_greed: { label: 'High Extreme Greed', color: '#dc2626' },
};

const MOMENTUM_LABELS = {
  rising_fast:  '↑↑ Rising Fast',
  rising:       '↑ Rising',
  neutral:      '→ Neutral',
  falling:      '↓ Falling',
  falling_fast: '↓↓ Falling Fast',
};

// ── Utilities ───────────────────────────────────────────────────────────────

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function fmt(v, decimals = 1) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(decimals);
}

function fmtDelta(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return { text: '—', cls: '' };
  const sign = n > 0 ? '+' : '';
  const cls  = n > 0.5 ? 'delta-up' : n < -0.5 ? 'delta-down' : 'delta-flat';
  return { text: sign + n.toFixed(1), cls };
}

function zoneColor(zone) {
  return (ZONE_META[zone] || {}).color || '#94a3b8';
}

function zoneLabel(zone) {
  return (ZONE_META[zone] || {}).label || (zone || '—').replace(/_/g, ' ');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTs(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' IST';
}

function safeSubInd(val) {
  const n = parseFloat(val);
  return isNaN(n) ? '—' : n.toFixed(2);
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = 'block'; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Main ─────────────────────────────────────────────────────────────────────

let mmiChart = null;

async function init() {
  // Footer year
  const fyEl = document.getElementById('footer-year');
  if (fyEl) fyEl.textContent = new Date().getFullYear();

  let signal  = null;
  let history = [];   // newest-first (as stored in signals.json)
  let apiError = null;

  // ── 1. Fetch live signal ─────────────────────────────────────────────────
  try {
    signal = await fetchJSON(`${API_BASE}/api/signal`);
  } catch (err) {
    apiError = 'Live signal unavailable — showing latest from history.';
  }

  // ── 2. Fetch history ─────────────────────────────────────────────────────
  try {
    const raw = await fetchJSON(HISTORY_URL);
    if (Array.isArray(raw) && raw.length > 0) {
      history = raw;
    }
  } catch (_) {
    // history unavailable — proceed with live signal only
  }

  // ── 3. Fallback: use history[0] if live API failed ───────────────────────
  if (!signal && history.length > 0) {
    signal = history[0]; // newest record
  }

  // Nothing at all — leave loading and show generic error
  if (!signal) {
    hide('loading-overlay');
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.textContent = 'Unable to load MMI data. Please try again later.';
      banner.style.display = '';
    }
    return;
  }

  // ── 4. Show error banner if partial failure ───────────────────────────────
  if (apiError) {
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.textContent = apiError;
      banner.style.display = '';
    }
  }

  // ── 5. Render ─────────────────────────────────────────────────────────────
  renderHero(signal);
  renderIndices(signal);
  renderMomentum(signal);
  renderSubIndicators(signal);
  renderAnalysis(signal);
  renderChart(history);
  renderTable(history);
  renderHeader(signal);

  hide('loading-overlay');
  show('main-content');
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderHero(s) {
  renderGauge(s.mmi, s.zone, s.color);

  const badge = document.getElementById('signal-badge');
  if (badge) {
    badge.textContent  = (s.emoji ? s.emoji + ' ' : '') + (s.signal || '—').toUpperCase();
    badge.style.background = s.color || '#94a3b8';
  }

  setText('signal-action', s.action || '');
}

function renderIndices(s) {
  const n50 = parseFloat(s.nifty50Close);
  setText('nifty50-val',  isNaN(n50)  ? '—' : '₹' + inr.format(n50));

  const nn50 = parseFloat(s.niftyNext50Close);
  setText('niftynxt50-val', isNaN(nn50) ? '—' : '₹' + inr.format(nn50));
}

function renderMomentum(s) {
  const day  = fmtDelta(s.mmiDelta);
  const week = fmtDelta(s.mmiDeltaWeek);

  const dayEl = document.getElementById('delta-day');
  if (dayEl) {
    dayEl.textContent = day.text;
    dayEl.className   = 'card-value ' + day.cls;
  }

  const wkEl = document.getElementById('delta-week');
  if (wkEl) {
    wkEl.textContent = week.text;
    wkEl.className   = 'card-value ' + week.cls;
  }

  setText('momentum-label', MOMENTUM_LABELS[s.momentum] || s.momentum || '—');
  setText('momentum-sub', '7-day: ' + fmt(s.mmiDeltaWeek, 1) + ' pts');
}

function renderSubIndicators(s) {
  const sub = s.subIndicators || {};
  setText('sub-vix',      safeSubInd(sub.vix));
  setText('sub-fii',      safeSubInd(sub.fii));
  setText('sub-skew',     safeSubInd(sub.skew));
  setText('sub-momentum', safeSubInd(sub.momentum));
  setText('sub-trin',     safeSubInd(sub.trin));
  setText('sub-extrema',  safeSubInd(sub.extrema));
}

function renderAnalysis(s) {
  setText('analysis-text', s.analysis || '—');

  // Tint the left border with the signal colour
  const card = document.querySelector('#analysis-card .card');
  if (card && s.color) {
    card.style.borderLeftColor = s.color;
  }
}

function renderHeader(s) {
  const ts = s.lastUpdated || s.date || '';
  setText('header-updated', ts ? formatDate(s.date) : '—');
}

// ── Chart ─────────────────────────────────────────────────────────────────────

/**
 * Render a 30-day line chart using Chart.js 4 + annotation plugin.
 * history is newest-first; chart needs oldest-first → slice(0,30).reverse()
 */
function renderChart(history) {
  if (!history.length) return;

  // Up to 30 newest entries, oldest-first for chart
  const slice   = history.slice(0, 30).reverse();
  const labels  = slice.map(r => {
    const d = new Date(r.date + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  const values  = slice.map(r => parseFloat(r.mmi));
  const colors  = slice.map(r => zoneColor(r.zone));

  const ctx = document.getElementById('mmi-chart');
  if (!ctx) return;

  if (mmiChart) {
    mmiChart.destroy();
    mmiChart = null;
  }

  // Zone band annotations (10% opacity fills)
  const annotations = {
    extreme_fear_band: {
      type: 'box', yMin: 0, yMax: 30,
      backgroundColor: 'rgba(22,163,74,0.10)', borderWidth: 0,
      label: { display: true, content: 'Extreme Fear', position: { x: 'start', y: 'center' }, color: '#22c55e', font: { size: 9 } },
    },
    fear_band: {
      type: 'box', yMin: 30, yMax: 50,
      backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 0,
      label: { display: true, content: 'Fear', position: { x: 'start', y: 'center' }, color: '#4ade80', font: { size: 9 } },
    },
    greed_band: {
      type: 'box', yMin: 50, yMax: 70,
      backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 0,
      label: { display: true, content: 'Greed', position: { x: 'start', y: 'center' }, color: '#fbbf24', font: { size: 9 } },
    },
    extreme_greed_band: {
      type: 'box', yMin: 70, yMax: 80,
      backgroundColor: 'rgba(249,115,22,0.10)', borderWidth: 0,
      label: { display: true, content: 'Ext. Greed', position: { x: 'start', y: 'center' }, color: '#fb923c', font: { size: 9 } },
    },
    high_extreme_greed_band: {
      type: 'box', yMin: 80, yMax: 100,
      backgroundColor: 'rgba(220,38,38,0.10)', borderWidth: 0,
      label: { display: true, content: 'High Ext. Greed', position: { x: 'start', y: 'center' }, color: '#f87171', font: { size: 9 } },
    },
  };

  mmiChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'MMI',
        data: values,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.08)',
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: colors,
        pointBorderColor: colors,
        pointHoverRadius: 6,
        tension: 0.35,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid:  { color: 'rgba(51,65,85,0.6)' },
          ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 45 },
        },
        y: {
          min: 0, max: 100,
          grid:  { color: 'rgba(51,65,85,0.6)' },
          ticks: { color: '#94a3b8', font: { size: 10 }, stepSize: 10 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: '#334155',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          padding: 10,
          callbacks: {
            label: (ctx) => {
              const r = slice[ctx.dataIndex] || {};
              return [
                'MMI: ' + (ctx.raw || 0).toFixed(1),
                'Zone: ' + zoneLabel(r.zone),
                'Signal: ' + (r.signal || '—'),
              ];
            },
          },
        },
        annotation: { annotations },
      },
    },
  });
}

// ── History Table ──────────────────────────────────────────────────────────────

function renderTable(history) {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  // Show up to 30 newest (history is already newest-first)
  const rows = history.slice(0, 30);

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No history available yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const delta     = fmtDelta(r.mmiDelta);
    const badgeCol  = zoneColor(r.zone);
    const momLabel  = MOMENTUM_LABELS[r.momentum] || (r.momentum || '—').replace(/_/g, ' ');

    return `<tr>
      <td>${formatDate(r.date)}</td>
      <td class="mmi-cell">${fmt(r.mmi, 1)}</td>
      <td><span class="zone-badge" style="background:${badgeCol}">${zoneLabel(r.zone)}</span></td>
      <td>${r.emoji || ''} ${r.signal || '—'}</td>
      <td class="${delta.cls}">${delta.text}</td>
      <td>${momLabel}</td>
    </tr>`;
  }).join('');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
