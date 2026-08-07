/**
 * pushToGitHub.js
 * Commits updated data files to the GitHub repository via the REST API.
 *
 * Secrets / env vars required:
 *   GITHUB_TOKEN        — fine-grained PAT with "Contents: write" on the repo
 *   GITHUB_REPO         — e.g. "stockmaniacs/mmi-trading-system"
 *   GITHUB_DATA_BRANCH  — e.g. "main"
 */

const GITHUB_API = "https://api.github.com";

/**
 * Push one or more data files to GitHub in a single commit.
 *
 * @param {object} env  - Cloudflare Worker env bindings
 * @param {Array<{ path: string, content: object|string }>} files
 *        path    — repo-relative path, e.g. "data/mmi-history.json"
 *        content — JS object (auto-serialised) or pre-serialised string
 * @param {string} [commitMessage]
 * @returns {Promise<{ sha: string, url: string }>}
 */
export async function pushToGitHub(env, files, commitMessage) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_DATA_BRANCH } = env;
  const branch = GITHUB_DATA_BRANCH ?? "main";
  const msg = commitMessage ?? `chore: update data [${todayIST()}]`;

  // We need the current commit SHA + tree SHA for the branch
  const branchInfo = await ghGet(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/ref/heads/${branch}`);
  const latestCommitSha = branchInfo.object.sha;

  const latestCommit = await ghGet(
    GITHUB_TOKEN,
    `/repos/${GITHUB_REPO}/git/commits/${latestCommitSha}`
  );
  const baseTreeSha = latestCommit.tree.sha;

  // Create blob for each file
  const treeItems = await Promise.all(
    files.map(async ({ path, content }) => {
      const raw =
        typeof content === "string" ? content : JSON.stringify(content, null, 2);

      const blob = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/blobs`, {
        content: btoa(unescape(encodeURIComponent(raw))), // UTF-8 → base64
        encoding: "base64",
      });

      return {
        path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      };
    })
  );

  // Create a new tree
  const newTree = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create the commit
  const newCommit = await ghPost(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/commits`, {
    message: msg,
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  // Update branch ref
  await ghPatch(GITHUB_TOKEN, `/repos/${GITHUB_REPO}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
    force: false,
  });

  console.log(`[pushToGitHub] Committed ${files.length} file(s). SHA: ${newCommit.sha}`);
  return { sha: newCommit.sha, url: newCommit.html_url };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "mmi-worker/1.0",
  };
}

async function ghGet(token, path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghPost(token, path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghPatch(token, path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: "PATCH",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Returns today's date string in IST ("YYYY-MM-DD").
 * @returns {string}
 */
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
