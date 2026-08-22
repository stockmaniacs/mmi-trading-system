/**
 * gauge.js
 * Renders an SVG semicircle Market Mood Index gauge.
 * Exposes window.renderGauge — called directly from dashboard.js.
 *
 * Gauge geometry
 * ─────────────────────────────────────────────────────────────
 * ViewBox  : 0 0 300 160    (width × height)
 * Center   : cx=150, cy=150  (sits at the bottom of the viewBox)
 * Radius   : 120px
 *
 * Angle mapping (degrees, standard Math convention)
 *   MMI 0   →  180°  →  left  → (30,  150)
 *   MMI 50  →  270°  →  top   → (150,  30)
 *   MMI 100 →  360°  →  right → (270, 150)
 *   Formula : angleDeg = 180 + (mmi / 100) * 180
 *
 * SVG arc sweep-flag=1 traces clockwise in SVG (y-down), which goes
 * UPWARD visually from left through the top to right.  ✓
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────── */

  var CX = 150, CY = 150, R = 120, SW = 16; // cx, cy, radius, strokeWidth

  var SEGMENTS = [
    { from: 0,  to: 20,  color: '#06b6d4' }, // high_extreme_fear  — cyan    [0,  20)
    { from: 20, to: 30,  color: '#22c55e' }, // extreme_fear       — green   [20, 30)
    { from: 30, to: 50,  color: '#84cc16' }, // fear               — lime    [30, 50)
    { from: 50, to: 70,  color: '#f59e0b' }, // greed              — amber   [50, 70)
    { from: 70, to: 80,  color: '#f97316' }, // extreme_greed      — orange  [70, 80)
    { from: 80, to: 100, color: '#dc2626' }, // high_extreme_greed — red     [80, 100]
  ];

  var ZONE_LABELS = {
    high_extreme_fear:  'High Extreme Fear',
    extreme_fear:       'Extreme Fear',
    fear:               'Fear',
    greed:              'Greed',
    extreme_greed:      'Extreme Greed',
    high_extreme_greed: 'High Extreme Greed',
  };

  /* ── Helpers ───────────────────────────────────────────────── */

  /** Convert MMI (0-100) to SVG angle in degrees. */
  function mmiToDeg(mmi) {
    return 180 + (mmi / 100) * 180;
  }

  /** Point on the circle at the given angle (degrees). */
  function pt(angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    return [
      +(CX + R * Math.cos(rad)).toFixed(2),
      +(CY + R * Math.sin(rad)).toFixed(2),
    ];
  }

  /**
   * SVG arc path from mmiStart to mmiEnd along the gauge semicircle.
   * Uses sweep-flag=1 (upward path) and large-arc-flag=0 for spans < 180°.
   */
  function arcPath(mmiStart, mmiEnd) {
    var a1 = mmiToDeg(mmiStart);
    var a2 = mmiToDeg(mmiEnd);
    var p1 = pt(a1);
    var p2 = pt(a2);
    var span = a2 - a1;                    // always positive here
    var large = span >= 180 ? 1 : 0;      // full background needs large=1
    return 'M ' + p1[0] + ',' + p1[1] +
           ' A ' + R + ',' + R + ' 0 ' + large + ',1 ' +
           p2[0] + ',' + p2[1];
  }

  /* ── Public API ────────────────────────────────────────────── */

  /**
   * Render the gauge into <div id="mmi-gauge">.
   * Clears any previous SVG first — safe to call repeatedly.
   *
   * @param {number} mmi   — current MMI value (0–100)
   * @param {string} zone  — zone key, e.g. "extreme_fear"
   * @param {string} color — signal hex colour, e.g. "#f59e0b"
   */
  window.renderGauge = function renderGauge(mmi, zone, color) {
    var el = document.getElementById('mmi-gauge');
    if (!el) return;

    var v = Math.max(0, Math.min(100, +mmi || 0)); // clamped value

    /* Background track */
    var bg = '<path d="' + arcPath(0, 100) + '"' +
             ' fill="none" stroke="#334155"' +
             ' stroke-width="' + SW + '" stroke-linecap="round"/>';

    /* Coloured zone segments */
    var segs = SEGMENTS.map(function (s) {
      return '<path d="' + arcPath(s.from, s.to) + '"' +
             ' fill="none" stroke="' + s.color + '"' +
             ' stroke-width="' + SW + '" stroke-linecap="round"/>';
    }).join('');

    /* Needle */
    var tip   = pt(mmiToDeg(v));
    var tipX  = tip[0], tipY = tip[1];
    var needle =
      '<line x1="' + CX + '" y1="' + CY + '"' +
            ' x2="' + tipX + '" y2="' + tipY + '"' +
            ' stroke="white" stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="' + tipX + '" cy="' + tipY + '" r="5" fill="white"/>';

    /* Hub */
    var hub = '<circle cx="' + CX + '" cy="' + CY + '" r="7" fill="white"/>';

    /* Labels */
    var label = ZONE_LABELS[zone] || (zone || '').replace(/_/g, ' ');
    var valueY = CY - 30;
    var labelY = CY - 12;
    var labels =
      '<text x="' + CX + '" y="' + valueY + '"' +
            ' text-anchor="middle" dominant-baseline="middle"' +
            ' fill="white" font-size="22" font-weight="700"' +
            ' font-family="system-ui,sans-serif">' +
            v.toFixed(2) +
      '</text>' +
      '<text x="' + CX + '" y="' + labelY + '"' +
            ' text-anchor="middle" dominant-baseline="middle"' +
            ' fill="#94a3b8" font-size="10.5"' +
            ' font-family="system-ui,sans-serif">' +
            label +
      '</text>';

    el.innerHTML =
      '<svg viewBox="0 0 300 160" xmlns="http://www.w3.org/2000/svg"' +
           ' role="img" aria-label="MMI Gauge: ' + v.toFixed(2) + '">' +
        bg + segs + needle + hub + labels +
      '</svg>';
  };

}());
