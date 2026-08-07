/**
 * pushToGitHub.js
 * Appends today's signal to the history, persists to KV, then commits
 * both data files to GitHub via the REST API.
 *
 * Signature: pushToGitHub(signal, env)
 *
 * Secrets / env vars (wrangler.toml [vars] or `wrangler secret put`):
 *   GITHUB_TOKEN        — fine-grained PAT with "Contents: write"
 *   GITHUB_REPO         — e.g. "stockmaniacs/mmi-trading-system"
 *   GITHUB_DATA_BRANCH  — e.g. "main"
 */

const GITHUB_API = "https://api.github.com";

/**
 * Append `signal` to the history stored in KV, then commit both
 * data/mmi-history.json (full) and data/signals.json (last 90) to GitHub.
 *
 * @param {object} signal - return value of computeSignal()
 * @param {object} env    - Cloudflare Worker env bindings
 * @returns {Promise<{ sha: string }>}
 */
export async function pushToGitHub(signal, env) {
  // ── 1. Load existing history from KV ──────────────────────────────────────
  const histRaw = await env.MMI_KV.get("signals-history");
  const history = histRaw ? JSON.parse(histRaw) : [];

  // De-duplicate by date (today's run replaces any earlier entry for same date)
  const deduped = history.filter((r) => r.date !== signal.date);
  deduped.push(signal);
  deduped.sort((a, b) => a.date.localeCompare(b.date));

  // ── 2. Persist updated history back to KV ─────────────────────────────────
  await env.MMI_KV.put("signals-history", JSON.stringify(deduped));
  console.log(`[pushToGitHub] KV signals-history updated — ${deduped.length} records`);

  // ── 3. Commit to GitHub ───────────────────────────────────────────────────
  const signals90 = deduped.slice(-90);
  const commitMsg = `chore: update MMI data [${signal.date}] — ${signal.signal} (MMI ${signal.mmi})`;

  const { sha } = await commitFiles(env, [
    { path: "data/mmi-history.json", content: deduped    },
    { path: "data/signals.json",     content: signals90  },
  ], commitMsg);

  console.log(`[pushToGitHub] Committed to GitHub — SHA: ${sha}`);
  return { sha };
}

// ---------------------------------------------------------------------------
// GitHub Git Data API helpers
// ---------------------------------------------------------------------------

/**
 * Commit one or more files to the configured branch in a single commit.
 *
 * @param {object} env
 * @param {Array<{ path: string, content: object|string }>} files
 * @param {string} message
 * @returns {Promise<{ sha: string, url: string }>}
 */
async function commitFiles(env, files, message) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_DATA_BRANCH } = env;
  const branch = GITHUB_DATA_BRANCH ?? "main";

  // Get current branch tip
  const refData = await ghGet(
    GITHUB_TOKEN,
    `/repos/${GITHUB_REPO}/git/ref/heads/${branch}`
  );
  const latestCommitSha = refData.object.sha;

  // Get tree SHA from the commit
  const commitData = await ghGet(
    GITHUB_TOKEN,
    `/repos/${GITHUB_REPO}/git/commits/${latestCommitSha}`
  );
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async ({ path, content }) => {
      const raw = typeof content === "string"
        ? content
        : JSON.stringify(content, null, 2);

      const blob = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/blobs`, {
        content:  btoa(unescape(encodeURIComponent(raw))), // UTF-8 safe base64
        encoding: "base64",
      });

      return { path, mode: "100644", type: "blob", sha: blob.sha };
    })
  );

  // Create new tree
  const newTree = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree:      treeItems,
  });

  // Create commit
  const newCommit = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/commits`, {
    message,
    tree:    newTree.sha,
    parents: [latestCommitSha],
  });

  // Advance branch ref
  await ghPatch(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/refs/heads/${branch}`, {
    sha:   newCommit.sha,
    force: false,
  });

  return { sha: newCommit.sha, url: newCommit.html_url ?? "" };
}

// ---------------------------------------------------------------------------
// Low-level GitHub REST wrappers
// ---------------------------------------------------------------------------

function ghHeaders(token) {
  return {
    Authorization:       `Bearer ${token}`,
    Accept:              "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type":      "application/json",
    "User-Agent":        "mmi-worker/1.0",
  };
}

async function ghGet(token, path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function ghPost(token, path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method:  "POST",
    headers: ghHeaders(token),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub POST ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function ghPatch(token, path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method:  "PATCH",
    headers: ghHeaders(token),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub PATCH ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
