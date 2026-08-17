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

const API_BASE          = 'https://mmi-worker.stockmaniacs.workers.dev';
// Both served from Cloudflare KV via the Worker — no rate-limits, always fresh
const HISTORY_URL       = `${API_BASE}/api/history`;       // last 90, newest-first (table)
const FULL_HISTORY_URL  = `${API_BASE}/api/full-history`;  // all records, oldest-first (charts)

// ── Zone meta ───────────────────────────────────────────────────────────────

// 6 zones: TickerTape's 4 (Extreme Fear/Fear/Greed/Extreme Greed) + user sub-zones at the extremes
const ZONE_META = {
  high_extreme_fear:  { label: 'High Extreme Fear',  color: '#06b6d4' },
  extreme_fear:       { label: 'Extreme Fear',        color: '#22c55e' },
  fear:               { label: 'Fear',                color: '#84cc16' },
  greed:              { label: 'Greed',               color: '#f59e0b' },
  extreme_greed:      { label: 'Extreme Greed',       color: '#f97316' },
  high_extreme_greed: { label: 'High Extreme Greed',  color: '#dc2626' },
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

function fmt(v, decimals = 2) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(decimals);
}

function fmtDelta(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return { text: '—', cls: '' };
  const sign = n > 0 ? '+' : '';
  const cls  = n > 0.5 ? 'delta-up' : n < -0.5 ? 'delta-down' : 'delta-flat';
  return { text: sign + n.toFixed(2), cls };
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

let mmiChart        = null;
let niftyPriceChart = null;
let niftyMMIChart   = null;
let nxtPriceChart   = null;
let nxtMMIChart     = null;

// Full 353-record history (oldest-first) for 3M/6M/1Y chart views
let fullHistory = [];
let activeRange = '6M';

/**
 * Filter an oldest-first history array to the last N calendar months.
 * Returns a sub-array still in oldest-first order.
 *
 * @param {Array}  history - oldest-first array with { date: "YYYY-MM-DD", … }
 * @param {number} months  - how many calendar months back to include
 * @returns {Array}
 */
function filterByRange(history, months) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"
  return history.filter(r => r.date >= cutoffStr);
}

/**
 * Re-render all three chart sections for the given range label ("3M"|"6M"|"1Y").
 * Uses the global fullHistory array (oldest-first, full dataset).
 */
function renderAllCharts(range) {
  const months   = range === '3M' ? 3 : range === '6M' ? 6 : 12;
  const filtered = filterByRange(fullHistory, months);

  renderChart(filtered);
  renderIndexMMIChart(
    filtered, 'nifty50Close',
    'nifty-price-chart', 'nifty-mmi-lower',
    () => niftyPriceChart, c => { niftyPriceChart = c; },
    () => niftyMMIChart,   c => { niftyMMIChart   = c; },
    'Nifty 50'
  );
  renderIndexMMIChart(
    filtered, 'niftyNext50Close',
    'niftynxt-price-chart', 'niftynxt-mmi-lower',
    () => nxtPriceChart, c => { nxtPriceChart = c; },
    () => nxtMMIChart,   c => { nxtMMIChart   = c; },
    'Nifty Next 50'
  );
}

async function init() {
  // Footer year
  const fyEl = document.getElementById('footer-year');
  if (fyEl) fyEl.textContent = new Date().getFullYear();

  let signal  = null;
  let history = [];   // newest-first (signals.json — used for table only)
  let apiError = null;

  // ── 1. Fetch live signal, recent history, and full history in parallel ───
  const [signalResult, historyResult, fullHistoryResult] = await Promise.allSettled([
    fetchJSON(`${API_BASE}/api/signal`),
    fetchJSON(HISTORY_URL),
    fetchJSON(FULL_HISTORY_URL),
  ]);

  // Live signal
  if (signalResult.status === 'fulfilled') {
    const raw = signalResult.value;
    if (raw && typeof raw.mmi === 'number') {
      signal = raw;
    } else {
      apiError = 'No signal yet — showing latest from history.';
    }
  } else {
    apiError = 'Live signal unavailable — showing latest from history.';
  }

  // Recent history (newest-first, for table)
  if (historyResult.status === 'fulfilled') {
    const raw = historyResult.value;
    if (Array.isArray(raw) && raw.length > 0) {
      history = raw;
    }
  }

  // Full history (oldest-first, for charts)
  if (fullHistoryResult.status === 'fulfilled') {
    const raw = fullHistoryResult.value;
    if (Array.isArray(raw) && raw.length > 0) {
      fullHistory = raw; // mmi-history.json is already oldest-first
    }
  }

  // Fall back to reversing signals.json if full history couldn't be loaded
  if (fullHistory.length === 0 && history.length > 0) {
    fullHistory = [...history].reverse(); // make oldest-first
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
  renderAllCharts(activeRange);    // renders all three chart sections (3M/6M/1Y)
  renderTable(history);            // table always uses signals.json (newest-first, 30 rows)
  renderHeader(signal);

  // ── 6. Wire range selector buttons ───────────────────────────
  const rangeTabsEl = document.getElementById('range-tabs');
  if (rangeTabsEl) {
    rangeTabsEl.addEventListener('click', e => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const range = btn.dataset.range;
      if (range === activeRange) return;

      activeRange = range;

      // Update active styling
      rangeTabsEl.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Re-render all charts with new range
      renderAllCharts(range);
    });
  }

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
  setText('momentum-sub', '7-day: ' + fmt(s.mmiDeltaWeek, 2) + ' pts');
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
 * Render the MMI trend chart using Chart.js 4 + annotation plugin.
 * history must be oldest-first (already filtered to the selected range).
 */
function renderChart(history) {
  if (!history.length) return;

  // history is oldest-first, pre-filtered to the selected range
  const slice   = history;
  const labels  = slice.map(r => {
    const d = new Date(r.date + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  const values      = slice.map(r => parseFloat(r.mmi));
  // Dots only outside the 30–70 band: high_extreme_fear + extreme_fear (< 30) and extreme_greed + high_extreme_greed (> 70)
  const SIGNAL_DOT = new Set(['high_extreme_fear', 'extreme_fear', 'extreme_greed', 'high_extreme_greed']);
  const colors      = slice.map(r => zoneColor(r.zone));
  const dotRadius   = slice.map(r => SIGNAL_DOT.has(r.zone) ? 4 : 0);
  const hoverRadius = slice.map(r => SIGNAL_DOT.has(r.zone) ? 6 : 0);

  const ctx = document.getElementById('mmi-chart');
  if (!ctx) return;

  if (mmiChart) {
    mmiChart.destroy();
    mmiChart = null;
  }

  // 6-zone band annotations (TickerTape zones + user extreme sub-zones)
  const annotations = {
    high_extreme_fear_band: {
      type: 'box', yMin: 0, yMax: 20,
      backgroundColor: 'rgba(6,182,212,0.10)', borderWidth: 0,
      label: { display: true, content: 'High Ext. Fear', position: { x: 'start', y: 'center' }, color: '#06b6d4', font: { size: 9 } },
    },
    extreme_fear_band: {
      type: 'box', yMin: 20, yMax: 30,
      backgroundColor: 'rgba(34,197,94,0.09)', borderWidth: 0,
      label: { display: true, content: 'Ext. Fear', position: { x: 'start', y: 'center' }, color: '#22c55e', font: { size: 9 } },
    },
    fear_band: {
      type: 'box', yMin: 30, yMax: 50,
      backgroundColor: 'rgba(132,204,22,0.08)', borderWidth: 0,
      label: { display: true, content: 'Fear', position: { x: 'start', y: 'center' }, color: '#84cc16', font: { size: 9 } },
    },
    greed_band: {
      type: 'box', yMin: 50, yMax: 70,
      backgroundColor: 'rgba(245,158,11,0.07)', borderWidth: 0,
      label: { display: true, content: 'Greed', position: { x: 'start', y: 'center' }, color: '#f59e0b', font: { size: 9 } },
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
        pointRadius: dotRadius,
        pointBackgroundColor: colors,
        pointBorderColor: colors,
        pointHoverRadius: hoverRadius,
        pointHitRadius: 10,
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
          ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 45, maxTicksLimit: 12 },
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
                'MMI: ' + (ctx.raw || 0).toFixed(2),
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

// ── Dual-pane Index vs MMI Chart ──────────────────────────────────────────────

// 6 zone bands for dual-pane MMI sub-chart
const MMI_ZONE_BANDS = {
  high_ext_fear:  { yMin: 0,  yMax: 20,  bg: 'rgba(6,182,212,0.13)',  label: 'High Ext. Fear',  color: '#06b6d4' },
  ext_fear:       { yMin: 20, yMax: 30,  bg: 'rgba(34,197,94,0.09)',  label: 'Ext. Fear',        color: '#22c55e' },
  fear:           { yMin: 30, yMax: 50,  bg: 'rgba(132,204,22,0.08)', label: 'Fear',              color: '#84cc16' },
  greed:          { yMin: 50, yMax: 70,  bg: 'rgba(245,158,11,0.07)', label: 'Greed',             color: '#f59e0b' },
  ext_greed:      { yMin: 70, yMax: 80,  bg: 'rgba(249,115,22,0.13)', label: 'Ext. Greed',       color: '#f97316' },
  high_ext_greed: { yMin: 80, yMax: 100, bg: 'rgba(220,38,38,0.13)',  label: 'High Ext. Greed',  color: '#dc2626' },
};

/**
 * Render a dual-pane (price top / MMI bottom) chart for a given index.
 * Only uses records where indexKey is a non-null number.
 * Shows a "data accumulating" note if fewer than 5 points are available.
 */
function renderIndexMMIChart(
  history, indexKey,
  priceCanvasId, mmiCanvasId,
  getPriceChart, setPriceChart,
  getMMIChart,   setMMIChart,
  indexLabel
) {
  // Filter records that have this index value; history is already oldest-first, pre-filtered
  const slice = history
    .filter(r => typeof r[indexKey] === 'number' && r[indexKey] != null);

  // Show "accumulating" note for Nifty Next 50 when sparse
  const noteId = indexKey === 'niftyNext50Close' ? 'niftynxt-note' : null;
  const cardId = indexKey === 'niftyNext50Close' ? 'niftynxt-card' : null;
  if (noteId) {
    const noteEl = document.getElementById(noteId);
    const cardEl = document.getElementById(cardId);
    if (slice.length < 5) {
      if (noteEl) noteEl.style.display = 'block';
      if (cardEl) cardEl.style.display = 'none';
      return;
    }
    if (noteEl) noteEl.style.display = 'none';
  }

  if (slice.length === 0) return;

  const labels = slice.map(r => {
    const d = new Date(r.date + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  const prices = slice.map(r => r[indexKey]);
  const mmis   = slice.map(r => parseFloat(r.mmi));

  // Dots only outside the 30–70 band: high_extreme_fear + extreme_fear (<30) and extreme_greed + high_extreme_greed (>70)
  const IDX_SIGNAL_DOT = new Set(['high_extreme_fear', 'extreme_fear', 'extreme_greed', 'high_extreme_greed']);
  const priceDotRadius = slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? 4 : 0);
  const priceDotColor  = slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? zoneColor(r.zone) : 'transparent');
  const dotCol         = slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? zoneColor(r.zone) : '#94a3b8');

  const sharedScaleX = {
    grid:  { color: 'rgba(51,65,85,0.5)' },
    ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 45, maxTicksLimit: 12 },
  };
  const sharedTooltip = {
    backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
    titleColor: '#f1f5f9', bodyColor: '#94a3b8', padding: 10,
  };

  // ── Destroy old instances ────────────────────────────────────
  const oldPrice = getPriceChart();
  if (oldPrice) { oldPrice.destroy(); }
  const oldMMI = getMMIChart();
  if (oldMMI)   { oldMMI.destroy(); }

  // ── Top pane: Index price ────────────────────────────────────
  const priceCtx = document.getElementById(priceCanvasId);
  if (priceCtx) {
    setPriceChart(new Chart(priceCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: indexLabel,
          data: prices,
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.07)',
          borderWidth: 2,
          pointRadius: priceDotRadius,
          pointHoverRadius: slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? 6 : 0),
          pointBackgroundColor: priceDotColor,
          pointBorderColor: priceDotColor,
          pointHitRadius: 10,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: sharedScaleX,
          y: {
            grid:  { color: 'rgba(51,65,85,0.5)' },
            ticks: {
              color: '#94a3b8', font: { size: 10 },
              callback: v => inr.format(Math.round(v)),
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...sharedTooltip,
            callbacks: {
              label: ctx => `${indexLabel}: ₹${inr.format(ctx.raw)}`,
            },
          },
          annotation: { annotations: {} },
        },
      },
    }));
  }

  // ── Bottom pane: MMI with OB/OS zone bands ───────────────────
  const mmiAnnotations = {};
  for (const [key, b] of Object.entries(MMI_ZONE_BANDS)) {
    mmiAnnotations[key] = {
      type: 'box', yMin: b.yMin, yMax: b.yMax,
      backgroundColor: b.bg, borderWidth: 0,
      label: {
        display: true, content: b.label,
        position: { x: 'end', y: 'center' },
        color: b.color, font: { size: 9, weight: '600' },
      },
    };
  }

  const mmiCtx = document.getElementById(mmiCanvasId);
  if (mmiCtx) {
    setMMIChart(new Chart(mmiCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'MMI',
          data: mmis,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.06)',
          borderWidth: 2,
          pointRadius: slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? 3.5 : 0),
          pointHoverRadius: slice.map(r => IDX_SIGNAL_DOT.has(r.zone) ? 5 : 0),
          pointBackgroundColor: dotCol,
          pointBorderColor:     dotCol,
          tension: 0.35,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: sharedScaleX,
          y: {
            min: 0, max: 100,
            grid:  { color: 'rgba(51,65,85,0.5)' },
            ticks: { color: '#94a3b8', font: { size: 10 }, stepSize: 20 },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...sharedTooltip,
            callbacks: {
              label: ctx => {
                const r = slice[ctx.dataIndex] || {};
                return [
                  'MMI: ' + ctx.raw.toFixed(2),
                  'Zone: ' + zoneLabel(r.zone),
                  'Signal: ' + (r.signal || '—'),
                ];
              },
            },
          },
          annotation: { annotations: mmiAnnotations },
        },
      },
    }));
  }
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
      <td class="mmi-cell">${fmt(r.mmi, 2)}</td>
      <td><span class="zone-badge" style="background:${badgeCol}">${zoneLabel(r.zone)}</span></td>
      <td>${r.emoji || ''} ${r.signal || '—'}</td>
      <td class="${delta.cls}">${delta.text}</td>
      <td>${momLabel}</td>
    </tr>`;
  }).join('');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
