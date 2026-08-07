/**
 * dashboard.js
 * Fetches live MMI data from the Cloudflare Worker API and renders the dashboard.
 *
 * Reads window.MMI_CONFIG.workerUrl at runtime (set inline in index.html).
 * Falls back to /api/* for local development.
 */

import { animateGauge } from "./gauge.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = window.MMI_CONFIG ?? {};
const WORKER_BASE = (cfg.workerUrl ?? "").replace(/\/$/, "");
const API = (path) => `${WORKER_BASE}${path}`;

const SIGNAL_CSS_CLASS = {
  "STRONG BUY": "sig--STRONG-BUY",
  "BUY":        "sig--BUY",
  "HOLD":       "sig--HOLD",
  "REDUCE":     "sig--REDUCE",
  "AVOID":      "sig--AVOID",
};

const SIGNAL_COLOR = {
  "STRONG BUY": "#16a34a",
  "BUY":        "#65a30d",
  "HOLD":       "#ca8a04",
  "REDUCE":     "#ea580c",
  "AVOID":      "#dc2626",
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  try {
    showLoading();
    const [latest, signals] = await Promise.all([
      apiFetch("/api/latest"),
      apiFetch("/api/signals"),
    ]);
    hideLoading();
    renderDashboard(latest.data, signals.data);
  } catch (err) {
    showError(err.message);
  }
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderDashboard(latest, signals) {
  renderGauge(latest);
  renderSignalCard(latest);
  renderStats(signals);
  renderChart(signals);
  renderTable(signals);
  renderUpdatedAt(latest.fetchedAt);
}

// --- Gauge ---
function renderGauge(r) {
  const canvas = document.getElementById("gauge-canvas");
  if (!canvas) return;
  animateGauge(canvas, 0, r.mmi);

  el("mmi-value").textContent = r.mmi.toFixed(1);
  el("mmi-value").style.color = r.color ?? SIGNAL_COLOR[r.signal] ?? "#f1f5f9";
  el("mmi-label").textContent = r.interpretation;
}

// --- Signal card ---
function renderSignalCard(r) {
  const badge = el("signal-badge");
  badge.textContent = r.signal;
  badge.style.background = r.color ?? SIGNAL_COLOR[r.signal] ?? "#6366f1";

  el("signal-action").textContent = r.action;

  const n50 = el("nifty50");
  const nn50 = el("niftyNext50");
  if (n50)  n50.textContent  = r.nifty50   != null ? `₹${r.nifty50.toLocaleString("en-IN")}` : "—";
  if (nn50) nn50.textContent = r.niftyNext50 != null ? `₹${r.niftyNext50.toLocaleString("en-IN")}` : "—";
}

// --- Stats ---
function renderStats(signals) {
  if (!signals?.length) return;

  // Last 30 days
  const recent = signals.slice(-30);
  const counts = {};
  for (const r of recent) counts[r.signal] = (counts[r.signal] ?? 0) + 1;

  const buySig  = (counts["STRONG BUY"] ?? 0) + (counts["BUY"] ?? 0);
  const holdSig = counts["HOLD"] ?? 0;
  const sellSig = (counts["REDUCE"] ?? 0) + (counts["AVOID"] ?? 0);

  setOptional("stat-buy",  buySig);
  setOptional("stat-hold", holdSig);
  setOptional("stat-sell", sellSig);
  setOptional("stat-total", signals.length);
}

// --- Chart (lightweight SVG sparkline) ---
function renderChart(signals) {
  const container = document.getElementById("history-chart");
  if (!container || !signals?.length) return;

  const W = container.clientWidth || 600;
  const H = 280;
  const PAD = { top: 20, right: 20, bottom: 40, left: 48 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const data = signals.slice(-90); // up to 90 points
  const mmis = data.map((d) => d.mmi);
  const minV = 0, maxV = 100;

  const xScale = (i) => PAD.left + (i / (data.length - 1)) * chartW;
  const yScale = (v) => PAD.top + chartH - ((v - minV) / (maxV - minV)) * chartH;

  // Build path
  const points = data.map((d, i) => `${xScale(i).toFixed(1)},${yScale(d.mmi).toFixed(1)}`);
  const linePath = `M${points.join("L")}`;

  // Area fill path
  const areaPath =
    `M${xScale(0).toFixed(1)},${yScale(0).toFixed(1)}` +
    `L${points.join("L")}` +
    `L${xScale(data.length - 1).toFixed(1)},${yScale(0).toFixed(1)}Z`;

  // Zone band lines
  const BANDS = [
    { v: 30, label: "30 (Fear)", dash: "4,3" },
    { v: 50, label: "50",        dash: "4,3" },
    { v: 69, label: "69 (Greed)", dash: "4,3" },
    { v: 80, label: "80",        dash: "4,3" },
  ];

  const bandLines = BANDS.map(({ v, label, dash }) => {
    const y = yScale(v).toFixed(1);
    return `
      <line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}"
            stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="${dash}" />
      <text x="${PAD.left - 4}" y="${y}" fill="rgba(255,255,255,.3)"
            font-size="10" text-anchor="end" dominant-baseline="middle">${v}</text>`;
  }).join("");

  // X-axis labels (every ~15 entries)
  const step = Math.max(1, Math.round(data.length / 6));
  const xLabels = data
    .filter((_, i) => i % step === 0 || i === data.length - 1)
    .map((d, _, arr) => {
      const origI = data.findIndex((x) => x.date === d.date);
      const xPos = xScale(origI).toFixed(1);
      const label = d.date.slice(5); // "MM-DD"
      return `<text x="${xPos}" y="${H - 8}" fill="rgba(255,255,255,.4)"
                    font-size="10" text-anchor="middle">${label}</text>`;
    }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:100%;overflow:visible;">
      <defs>
        <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#6366f1" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="chart-clip">
          <rect x="${PAD.left}" y="${PAD.top}" width="${chartW}" height="${chartH}" />
        </clipPath>
      </defs>

      ${bandLines}

      <g clip-path="url(#chart-clip)">
        <path d="${areaPath}" fill="url(#area-grad)" />
        <path d="${linePath}" fill="none" stroke="#6366f1" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" />
      </g>

      ${xLabels}
    </svg>`;
}

// --- Signal history table ---
function renderTable(signals) {
  const tbody = document.getElementById("signals-tbody");
  if (!tbody || !signals?.length) return;

  const rows = [...signals].reverse().slice(0, 60);
  tbody.innerHTML = rows.map((r) => {
    const cssClass = SIGNAL_CSS_CLASS[r.signal] ?? "";
    const nifty = r.nifty50 != null
      ? r.nifty50.toLocaleString("en-IN")
      : (r.nifty != null ? Number(r.nifty).toLocaleString("en-IN") : "—");
    return `
      <tr>
        <td>${r.date}</td>
        <td><strong>${r.mmi.toFixed(1)}</strong></td>
        <td>${r.interpretation}</td>
        <td><span class="badge ${cssClass}">${r.signal}</span></td>
        <td>${nifty !== "—" ? `₹${nifty}` : "—"}</td>
      </tr>`;
  }).join("");
}

// --- Updated timestamp ---
function renderUpdatedAt(iso) {
  const el2 = document.getElementById("updated-at");
  if (!el2 || !iso) return;
  const d = new Date(iso);
  el2.textContent = `Updated: ${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;
}

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

function showLoading() {
  const main = document.getElementById("main-content");
  if (main) main.style.display = "none";
  const s = document.getElementById("state-loading");
  if (s) s.style.display = "flex";
}

function hideLoading() {
  const s = document.getElementById("state-loading");
  if (s) s.style.display = "none";
  const main = document.getElementById("main-content");
  if (main) main.style.display = "block";
}

function showError(msg) {
  const s = document.getElementById("state-loading");
  if (s) s.style.display = "none";
  const e = document.getElementById("state-error");
  if (e) {
    e.style.display = "block";
    const em = e.querySelector(".error-message");
    if (em) em.textContent = msg;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(id) { return document.getElementById(id); }

function setOptional(id, val) {
  const node = document.getElementById(id);
  if (node) node.textContent = val;
}

async function apiFetch(path) {
  const res = await fetch(API(path));
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "API error");
  return json;
}
