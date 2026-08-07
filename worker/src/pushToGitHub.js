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
 * @param {object} signal - return value of computeSignal()
 * @param {object} env    - Cloudflare Worker env bindings
 */
export async function pushToGitHub(signal, env) {
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
    history.push(signal);

    // ── Step 3: Sort ascending (chronological order for the history file) ─────
    history.sort((a, b) => a.date.localeCompare(b.date));

    // ── Step 4: Build signals.json — last 90, newest-first for frontend ───────
    // slice(-90) gives the newest 90 in ascending order; reverse → descending
    const last90 = history.slice(-90).reverse();

    // Shared commit message for both PUTs
    const commitMsg =
      `chore(data): MMI ${signal.mmi} | ${signal.signal} | ${signal.date}`;

    // ── Step 5a: PUT mmi-history.json ────────────────────────────────────────
    const histOk = await putFile(
      "mmi-history.json", history, historySha, commitMsg, env
    );
    if (!histOk) {
      // 409 conflict or write failure — abort to avoid skewing the two files
      return;
    }

    // ── Step 5b: GET signals.json SHA, then PUT ───────────────────────────────
    // We only need the SHA here; we never read signals.json's content because
    // it is always fully rebuilt from history.
    const { sha: signalsSha } = await getFile("signals.json", env);
    await putFile("signals.json", last90, signalsSha, commitMsg, env);

    // ── Step 6: Cache last 90 in KV so /api/history is served without GitHub ──
    await env.MMI_KV.put("signals-history", JSON.stringify(last90));

    console.log(
      `[pushToGitHub] Done — ` +
      `history: ${history.length} records | signals: ${last90.length} records`
    );
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

  // GitHub folds base64 at 60 chars with newlines — strip before decoding
  const data = JSON.parse(atob(file.content.replace(/\n/g, "")));

  return { data, sha: file.sha };
}

/**
 * PUT (create or update) a file in the repo's data/ directory.
 *
 * - sha = null  →  create new file (omit sha from request body)
 * - sha = string →  update existing file (must match current blob SHA)
 *
 * Returns true on success (2xx).
 * Returns false and logs on 409 conflict ("next day's run will catch up").
 * Returns false and logs on any other non-2xx status (never throws).
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

  if (res.status === 409) {
    console.log(
      `[pushToGitHub] PUT ${filename} → 409 conflict — ` +
      `skipping, next day's run will catch up`
    );
    return false;
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[pushToGitHub] PUT ${filename} → ${res.status}: ${text}`);
    return false;
  }

  console.log(`[pushToGitHub] PUT ${filename} → ${res.status} OK`);
  return true;
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
