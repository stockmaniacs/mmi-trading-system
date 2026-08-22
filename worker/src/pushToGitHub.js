/**
 * pushToGitHub.js
 * Persists MMI signal data to GitHub using the Contents API and caches
 * the last 90 signals in Cloudflare KV for fast /api/history serving.
 *
 * API used: GET + PUT /repos/{owner}/{repo}/contents/data/{file}
 * (Contents API — simpler than the Git Data API; one call per file.)
 *
 * Required env bindings:
 *   GITHUB_TOKEN        (secret) — classic PAT or fine-grained with contents:write
 *   GITHUB_REPO         (var)    — "owner/repo", e.g. "stockmaniacs/mmi-trading-system"
 *   GITHUB_DATA_BRANCH  (var)    — branch to commit to, e.g. "main"
 *
 * Resilience design:
 *   1. KV is always written BEFORE the GitHub PUT — dashboard is never stale even
 *      if GitHub rejects the commit.
 *   2. On a 409 SHA conflict (e.g. after a manual data fix), we re-fetch the file's
 *      current SHA and retry the PUT once — recovering without human intervention.
 *   3. If backfillSignal is provided (previous trading day was missing), it is
 *      inserted into history before today's entry — self-healing one-day gaps.
 */

const BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Append today's signal to mmi-history.json on GitHub, rebuild signals.json
 * (last 90, newest-first for frontend), then cache in KV.
 *
 * Idempotent: if signal.date is already recorded, exits without writing.
 * Never throws: all GitHub failures are logged; the cron continues to email.
 *
 * @param {object}      signal         - return value of computeSignal()
 * @param {object}      env            - Cloudflare Worker env bindings
 * @param {object|null} backfillSignal - optional previous-day record to insert
 *                                       when that date is missing from history
 */
export async function pushToGitHub(signal, env, backfillSignal = null) {
  try {
    // ── Step 1: GET mmi-history.json (content + SHA) ─────────────────────────
    const { data: raw, sha: historySha } = await getFile("mmi-history.json", env);

    // Treat missing file as empty history (404 → create path)
    const history = Array.isArray(raw) ? raw : [];

    // ── Step 2: Idempotency guard ─────────────────────────────────────────────
    if (history.some((r) => r.date === signal.date)) {
      console.log(`[pushToGitHub] ${signal.date} already in history — skipping`);
      return;
    }

    // ── Step 2b: Self-heal — insert backfill record if the previous day is missing
    if (backfillSignal && !history.some((r) => r.date === backfillSignal.date)) {
      history.push(backfillSignal);
      console.log(
        `[pushToGitHub] Backfilled missing ${backfillSignal.date} ` +
        `(MMI ${backfillSignal.mmi.toFixed(2)}, ${backfillSignal.signal})`
      );
    }

    history.push(signal);

    // ── Step 3: Sort ascending (chronological order for the history file) ─────
    history.sort((a, b) => a.date.localeCompare(b.date));

    // ── Step 4: Build signals.json — last 90, newest-first for frontend ───────
    // slice(-90) gives the newest 90 in ascending order; reverse → descending
    const last90 = history.slice(-90).reverse();

    // Shared commit message for both PUTs
    const commitMsg =
      `chore(data): MMI ${signal.mmi} | ${signal.signal} | ${signal.date}`;

    // ── Step 5: Cache in KV first (always, regardless of GitHub outcome) ──────
    // Dashboard is always served from KV — it must never be stale because
    // GitHub rejected a commit.
    await env.MMI_KV.put("signals-history", JSON.stringify(last90));
    await env.MMI_KV.put("full-history",    JSON.stringify(history));
    console.log(
      `[pushToGitHub] KV updated — ` +
      `history: ${history.length} records | signals: ${last90.length} records`
    );

    // ── Step 6a: PUT mmi-history.json (retry once on 409 SHA conflict) ────────
    const histOk = await putFileWithRetry(
      "mmi-history.json", history, historySha, commitMsg, env
    );
    if (!histOk) {
      // GitHub push failed after retry — KV is already updated so the dashboard
      // shows fresh data. The next cron run will re-attempt the GitHub push.
      console.warn("[pushToGitHub] GitHub push failed — dashboard served from KV.");
      return;
    }

    // ── Step 6b: GET signals.json SHA, then PUT ───────────────────────────────
    // We only need the SHA here; signals.json is always rebuilt from history.
    const { sha: signalsSha } = await getFile("signals.json", env);
    await putFile("signals.json", last90, signalsSha, commitMsg, env);

    console.log(`[pushToGitHub] GitHub committed — ${signal.date} persisted`);
  } catch (err) {
    // Catches throws from getFile (non-404 HTTP errors) or unexpected failures
    console.error(`[pushToGitHub] Unhandled error: ${err.message}`);
    // Never re-throw — must not abort the cron job or prevent email sending
  }
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------------

/**
 * GET a file from the repo's data/ directory.
 *
 * Returns { data: parsedContent, sha: blobSha } on success.
 * Returns { data: null, sha: null } on 404 (file does not exist yet).
 * Throws on any other HTTP error (caller's try/catch handles it).
 *
 * @param {string} filename - e.g. "mmi-history.json"
 * @param {object} env
 * @returns {Promise<{ data: any, sha: string|null }>}
 */
async function getFile(filename, env) {
  const url =
    `${BASE}/repos/${env.GITHUB_REPO}/contents/data/${filename}` +
    `?ref=${env.GITHUB_DATA_BRANCH}`;

  const res = await fetch(url, { headers: makeHeaders(env) });

  if (res.status === 404) {
    console.log(`[pushToGitHub] ${filename} not found on GitHub — will create`);
    return { data: null, sha: null };
  }

  if (!res.ok) {
    // Let the outer try/catch log this and swallow it
    throw new Error(`GET ${filename} → ${res.status}: ${await res.text()}`);
  }

  const file = await res.json();

  // GitHub folds base64 at 60 chars with newlines — strip before decoding.
  // decodeURIComponent(escape(...)) converts the raw UTF-8 binary string that
  // atob() produces into a proper JS string, preserving emoji correctly.
  const binary = atob(file.content.replace(/\n/g, ""));
  const utf8   = decodeURIComponent(escape(binary));
  const data   = JSON.parse(utf8);

  return { data, sha: file.sha };
}

/**
 * PUT (create or update) a file in the repo's data/ directory.
 *
 * - sha = null  →  create new file (omit sha from request body)
 * - sha = string →  update existing file (must match current blob SHA)
 *
 * Returns true on success (2xx).
 * Returns false and logs on 409 conflict or any other non-2xx status (never throws).
 *
 * @param {string}      filename
 * @param {any}         content   - serialised to pretty JSON then base64-encoded
 * @param {string|null} sha       - current blob SHA; null when creating
 * @param {string}      commitMsg
 * @param {object}      env
 * @returns {Promise<boolean>}
 */
async function putFile(filename, content, sha, commitMsg, env) {
  const body = {
    message: commitMsg,
    content: encodeContent(content),
    branch:  env.GITHUB_DATA_BRANCH,
  };

  // sha is required for updates; must be absent (not just null) for creates
  if (sha) {
    body.sha = sha;
  }

  const res = await fetch(
    `${BASE}/repos/${env.GITHUB_REPO}/contents/data/${filename}`,
    {
      method:  "PUT",
      headers: makeHeaders(env),
      body:    JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`[pushToGitHub] PUT ${filename} → ${res.status}: ${text.slice(0, 200)}`);
    return false;
  }

  console.log(`[pushToGitHub] PUT ${filename} → ${res.status} OK`);
  return true;
}

/**
 * PUT a file with one automatic retry on SHA conflict (409).
 *
 * When another commit landed between our GET and PUT (e.g. a manual data fix),
 * the PUT returns 409. We re-fetch only the current SHA — our content (today's
 * data) is still authoritative — and retry once. On a second failure we give up
 * and log; KV is already updated so the dashboard is unaffected.
 *
 * @param {string}      filename
 * @param {any}         content   - full file content to write
 * @param {string|null} sha       - SHA from the initial GET
 * @param {string}      commitMsg
 * @param {object}      env
 * @returns {Promise<boolean>}
 */
async function putFileWithRetry(filename, content, sha, commitMsg, env) {
  const ok = await putFile(filename, content, sha, commitMsg, env);
  if (ok) return true;

  // First attempt failed — re-fetch current SHA and try once more
  console.log(`[pushToGitHub] Retrying ${filename} with fresh SHA...`);
  try {
    const { sha: freshSha } = await getFile(filename, env);
    if (!freshSha) {
      console.error(`[pushToGitHub] Retry aborted — could not re-fetch SHA for ${filename}`);
      return false;
    }
    return await putFile(filename, content, freshSha, commitMsg, env);
  } catch (err) {
    console.error(`[pushToGitHub] Retry fetch failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Encode a JS value as base64 for the GitHub Contents API.
 * btoa(unescape(encodeURIComponent(...))) is the standard pattern for
 * safely encoding UTF-8 content (e.g. ₹, —, emoji) to ASCII base64.
 *
 * @param {any} value
 * @returns {string}
 */
function encodeContent(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value, null, 2))));
}

/**
 * Build the standard Authorization + User-Agent headers for GitHub API calls.
 * Uses the classic "token ..." form (works with both classic and fine-grained PATs).
 *
 * @param {object} env
 * @returns {object}
 */
function makeHeaders(env) {
  return {
    Authorization:  `token ${env.GITHUB_TOKEN}`,
    "User-Agent":   "mmi-worker/1.0",
    "Content-Type": "application/json",
  };
}
