#!/usr/bin/env node
/**
 * seed.js — Seed mmi-history.json and signals.json from a CSV export.
 *
 * Usage:
 *   node scripts/seed.js --input /path/to/mmi-history.csv
 *
 * Expected CSV columns (order-independent, header row required):
 *   Date, MMI Value, Interpretation, Nifty Value
 *
 * Supported date formats: YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, M/D/YYYY
 */

import { createReadStream } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Zone classification (mirrors signalEngine.js — keep in sync)
// ---------------------------------------------------------------------------

const ZONES = [
  {
    min: 0, max: 30, zone: "extreme_fear",
    signal: "STRONG BUY",
    action: "Deploy aggressively. Extreme Fear — rare buying opportunity.",
  },
  {
    min: 31, max: 50, zone: "fear",
    signal: "BUY",
    action: "Accumulate. Fear zone — good entry for SIP and lump sum.",
  },
  {
    min: 51, max: 69, zone: "greed",
    signal: "HOLD",
    action: "Stay invested. No fresh positions. Greed is building.",
  },
  {
    min: 70, max: 80, zone: "extreme_greed",
    signal: "REDUCE",
    action: "Book partial profits. Market is overheated.",
  },
  {
    min: 81, max: 100, zone: "high_extreme_greed",
    signal: "AVOID",
    action: "Avoid new positions. Sit on cash. Correction likely.",
  },
];

function classify(mmi) {
  const band = ZONES.find((z) => mmi >= z.min && mmi <= z.max);
  return band ?? (mmi < 0 ? ZONES[0] : ZONES[ZONES.length - 1]);
}

// ---------------------------------------------------------------------------
// Date normalisation
// ---------------------------------------------------------------------------

/**
 * Parse any of these into "YYYY-MM-DD":
 *   2024-03-15, 15-03-2024, 15/03/2024, 3/15/2024, 15 Mar 2024
 * Returns null on failure.
 */
function normaliseDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // ISO: 2024-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD-MM-YYYY or DD/MM/YYYY
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;

  // M/D/YYYY (US style)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;

  // "15 Mar 2024" / "15-Mar-2024"
  const MONTHS = {
    jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
    jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
  };
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, "0")}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// CSV parser (streaming, no external deps)
// ---------------------------------------------------------------------------

/**
 * Parse a CSV file into an array of objects keyed by the header row.
 * Handles quoted fields, commas inside quotes, and CRLF/LF line endings.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function parseCSV(filePath) {
  const rows = [];
  let headers = null;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fields = splitCSVLine(trimmed);

    if (!headers) {
      headers = fields.map((h) => h.trim());
      continue;
    }

    const row = {};
    headers.forEach((h, i) => {
      row[h] = (fields[i] ?? "").trim();
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Split a single CSV line respecting quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function splitCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Column resolver — tolerates different header spellings
// ---------------------------------------------------------------------------

function findColumn(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse CLI flags
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error("Usage: node scripts/seed.js --input /path/to/mmi-history.csv");
    process.exit(1);
  }

  const inputPath = resolve(args[inputIdx + 1]);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(__dirname, "../data");

  console.log(`\n📂 Reading CSV: ${inputPath}`);

  let rawRows;
  try {
    rawRows = await parseCSV(inputPath);
  } catch (err) {
    console.error(`❌ Failed to read CSV: ${err.message}`);
    process.exit(1);
  }

  if (!rawRows.length) {
    console.error("❌ CSV is empty or has no data rows.");
    process.exit(1);
  }

  // Resolve column names (flexible mapping)
  const headers = Object.keys(rawRows[0]);
  const COL_DATE   = findColumn(headers, ["date", "Date", "DATE"]);
  const COL_MMI    = findColumn(headers, ["mmi value", "mmi", "MMI Value", "MMI"]);
  const COL_LABEL  = findColumn(headers, ["interpretation", "label", "Interpretation", "Label", "mood"]);
  const COL_NIFTY  = findColumn(headers, ["nifty value", "nifty 50", "nifty50", "nifty", "Nifty Value", "Nifty 50"]);

  if (!COL_DATE || !COL_MMI) {
    console.error(`❌ Could not identify required columns.\n   Headers found: ${headers.join(", ")}`);
    process.exit(1);
  }

  console.log(`✅ Columns mapped:`);
  console.log(`   Date          → "${COL_DATE}"`);
  console.log(`   MMI Value     → "${COL_MMI}"`);
  console.log(`   Interpretation→ "${COL_LABEL ?? "(not found — derived)"}"`);
  console.log(`   Nifty Value   → "${COL_NIFTY ?? "(not found)"}"`);

  // Transform rows
  const records = [];
  const skipped = [];

  for (const row of rawRows) {
    const dateStr = normaliseDate(row[COL_DATE]);
    const mmiRaw  = parseFloat(String(row[COL_MMI]).replace(/[,\s]/g, ""));
    const niftyRaw = COL_NIFTY ? parseFloat(String(row[COL_NIFTY]).replace(/[,\s]/g, "")) : null;

    if (!dateStr || isNaN(mmiRaw)) {
      skipped.push({ raw: row, reason: !dateStr ? "invalid date" : "invalid MMI value" });
      continue;
    }

    const interpretation = (COL_LABEL && row[COL_LABEL]) ? row[COL_LABEL].trim() : null;
    const { zone, signal, action } = classify(mmiRaw);

    records.push({
      date: dateStr,
      mmi: Math.round(mmiRaw * 100) / 100,
      interpretation: interpretation ?? deriveLabel(mmiRaw),
      nifty: isNaN(niftyRaw) ? null : Math.round(niftyRaw * 100) / 100,
      zone,
      signal,
      action,
    });
  }

  // Sort chronologically
  records.sort((a, b) => a.date.localeCompare(b.date));

  // De-duplicate by date (last occurrence wins)
  const seen = new Map();
  for (const r of records) seen.set(r.date, r);
  const history = [...seen.values()];

  const signals = history.slice(-90);

  // Write output files
  writeFileSync(`${dataDir}/mmi-history.json`, JSON.stringify(history, null, 2), "utf8");
  writeFileSync(`${dataDir}/signals.json`, JSON.stringify(signals, null, 2), "utf8");

  // --- Summary ---
  const signalCounts = {};
  for (const r of history) signalCounts[r.signal] = (signalCounts[r.signal] ?? 0) + 1;

  console.log(`\n✅ Seed complete!`);
  console.log(`   Total records : ${history.length}`);
  console.log(`   Date range    : ${history[0]?.date} → ${history[history.length - 1]?.date}`);
  console.log(`   Skipped rows  : ${skipped.length}`);
  if (skipped.length) {
    skipped.slice(0, 5).forEach((s) =>
      console.log(`     ↳ [${s.reason}] ${JSON.stringify(s.raw)}`)
    );
    if (skipped.length > 5) console.log(`     ↳ ... and ${skipped.length - 5} more`);
  }
  console.log(`\n   Signal distribution:`);
  for (const [sig, count] of Object.entries(signalCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / history.length) * 100).toFixed(1);
    console.log(`     ${sig.padEnd(15)} ${count.toString().padStart(5)} (${pct}%)`);
  }
  console.log(`\n   Output:`);
  console.log(`     data/mmi-history.json  (${history.length} records)`);
  console.log(`     data/signals.json      (${signals.length} records — last 90)\n`);
}

function deriveLabel(mmi) {
  if (mmi <= 30) return "Extreme Fear";
  if (mmi <= 50) return "Fear";
  if (mmi <= 69) return "Greed";
  if (mmi <= 80) return "Extreme Greed";
  return "High Extreme Greed";
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
