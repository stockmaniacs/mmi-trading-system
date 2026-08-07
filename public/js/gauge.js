/**
 * gauge.js
 * Draws a semicircular MMI gauge on a <canvas> element.
 * No external dependencies.
 *
 * Usage:
 *   import { drawGauge } from './gauge.js';
 *   drawGauge(canvasElement, mmiValue);   // mmiValue 0–100
 */

// Zone colour stops along the 0–100 arc
const ZONE_STOPS = [
  { pct: 0,    color: "#16a34a" }, // extreme_fear     (green)
  { pct: 0.30, color: "#65a30d" }, // fear             (lime)
  { pct: 0.50, color: "#ca8a04" }, // greed            (amber)
  { pct: 0.69, color: "#ea580c" }, // extreme_greed    (orange)
  { pct: 0.80, color: "#dc2626" }, // high_extr. greed (red)
  { pct: 1.00, color: "#dc2626" }, // end sentinel
];

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} value  0–100
 */
export function drawGauge(canvas, value) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const H = Math.round(W * 0.55);

  canvas.width  = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const cx = W / 2;
  const cy = H * 0.88;          // centre sits near the bottom for a half-circle
  const R  = W * 0.42;
  const thick = R * 0.18;

  const START_ANGLE = Math.PI;        // 9 o'clock  (left)
  const END_ANGLE   = 2 * Math.PI;   // 3 o'clock  (right)
  const ARC_SPAN    = Math.PI;       // 180°

  ctx.clearRect(0, 0, W, H);

  // --- Background track ---
  ctx.beginPath();
  ctx.arc(cx, cy, R, START_ANGLE, END_ANGLE);
  ctx.lineWidth = thick;
  ctx.lineCap = "butt";
  ctx.strokeStyle = "#1e293b";
  ctx.stroke();

  // --- Coloured zone arc (gradient-like segments) ---
  for (let i = 0; i < ZONE_STOPS.length - 1; i++) {
    const s = ZONE_STOPS[i];
    const e = ZONE_STOPS[i + 1];
    const a1 = START_ANGLE + s.pct * ARC_SPAN;
    const a2 = START_ANGLE + e.pct * ARC_SPAN;

    const grad = ctx.createLinearGradient(
      cx + R * Math.cos(a1), cy + R * Math.sin(a1),
      cx + R * Math.cos(a2), cy + R * Math.sin(a2)
    );
    grad.addColorStop(0, s.color);
    grad.addColorStop(1, e.color);

    ctx.beginPath();
    ctx.arc(cx, cy, R, a1, a2);
    ctx.lineWidth = thick;
    ctx.lineCap = "butt";
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

  // --- Needle ---
  const clampedPct = Math.max(0, Math.min(100, value)) / 100;
  const needleAngle = START_ANGLE + clampedPct * ARC_SPAN;
  const needleLen   = R * 0.82;
  const hubR        = thick * 0.7;

  // Shadow for depth
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur  = 6;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(
    cx + needleLen * Math.cos(needleAngle),
    cy + needleLen * Math.sin(needleAngle)
  );
  ctx.lineWidth = thick * 0.22;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#f1f5f9";
  ctx.stroke();
  ctx.restore();

  // Hub circle
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, 2 * Math.PI);
  ctx.fillStyle = "#f1f5f9";
  ctx.fill();

  // --- Zone tick marks ---
  const ticks = [0, 30, 50, 69, 80, 100];
  ticks.forEach((t) => {
    const pct = t / 100;
    const a = START_ANGLE + pct * ARC_SPAN;
    const inner = R - thick / 2 - 6;
    const outer = R + thick / 2 + 6;

    ctx.beginPath();
    ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
    ctx.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.stroke();

    // Label
    const labelR = R + thick / 2 + 18;
    const lx = cx + labelR * Math.cos(a);
    const ly = cy + labelR * Math.sin(a);
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = `${Math.round(W * 0.035)}px Inter,system-ui,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(t), lx, ly);
  });
}

/**
 * Animate the needle from `from` to `to` over `duration` ms.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} from   start value 0–100
 * @param {number} to     end value 0–100
 * @param {number} [duration=700]
 */
export function animateGauge(canvas, from, to, duration = 700) {
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    drawGauge(canvas, from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
