/**
 * Minimal GitHub REST API client used by the in-browser editor to push
 * Markdown edits as a real PR. No backend — everything runs from the static
 * GitHub Pages site, authenticated by a Personal Access Token that the user
 * pastes once and that lives in localStorage from then on.
 *
 * Token scope: classic PAT with `repo`, or a fine-grained PAT scoped to
 * `0xNullAI/DG-Wiki` with Contents: read+write and Pull requests: read+write.
 */

const OWNER = '0xNullAI';
const REPO = 'DG-Wiki';
const BASE_BRANCH = 'main';
const API = 'https://api.github.com';

const TOKEN_KEY = 'dg-wiki:gh-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function whoami(token: string): Promise<{ login: string; avatarUrl: string }> {
  const resp = await fetch(`${API}/user`, {
    headers: ghHeaders(token),
  });
  if (!resp.ok) {
    throw new Error(`GitHub auth failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { login: string; avatar_url: string };
  return { login: data.login, avatarUrl: data.avatar_url };
}

interface SubmitEditOptions {
  token: string;
  filePath: string;
  content: string;
  pageId: string;
  message?: string;
}

export interface SubmitEditResult {
  prUrl: string;
  branchName: string;
}

export async function submitEdit(options: SubmitEditOptions): Promise<SubmitEditResult> {
  const { token, filePath, content, pageId, message } = options;

  // 1. Identify the user (used in branch name + PR title)
  const me = await whoami(token);
  const safeUser = me.login.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

  // 2. Get the SHA of the file currently on `main`
  const fileResp = await fetch(
    `${API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filePath)}?ref=${BASE_BRANCH}`,
    { headers: ghHeaders(token) },
  );
  if (!fileResp.ok) {
    throw new Error(`无法读取 main 上的源文件: ${fileResp.status}`);
  }
  const fileData = (await fileResp.json()) as { sha: string };
  const baseSha = fileData.sha;

  // 3. Get the SHA of `main`'s tip commit, used as starting point for new branch
  const refResp = await fetch(
    `${API}/repos/${OWNER}/${REPO}/git/refs/heads/${BASE_BRANCH}`,
    { headers: ghHeaders(token) },
  );
  if (!refResp.ok) {
    throw new Error(`无法读取 main 分支信息: ${refResp.status}`);
  }
  const refData = (await refResp.json()) as { object: { sha: string } };
  const baseCommitSha = refData.object.sha;

  // 4. Create a feature branch
  const stamp = Date.now().toString(36);
  const branchName = `wiki-edit/${safeUser}-${pageId}-${stamp}`;
  const createBranchResp = await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseCommitSha,
    }),
  });
  if (!createBranchResp.ok) {
    throw new Error(`分支创建失败: ${createBranchResp.status} ${await createBranchResp.text()}`);
  }

  // 5. Commit the new content to the new branch
  const commitMessage = message ?? `docs(${pageId}): edit via DG-Wiki`;
  const putResp = await fetch(
    `${API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filePath)}`,
    {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: commitMessage,
        content: utf8ToBase64(content),
        sha: baseSha,
        branch: branchName,
      }),
    },
  );
  if (!putResp.ok) {
    throw new Error(`提交内容失败: ${putResp.status} ${await putResp.text()}`);
  }

  // 6. Open a PR
  const prResp = await fetch(`${API}/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      title: `docs(${pageId}): edit from ${me.login} via DG-Wiki`,
      head: branchName,
      base: BASE_BRANCH,
      body: [
        '_Submitted via the in-browser editor at_ https://0xnullai.github.io/DG-Wiki/',
        '',
        `Page: \`${pageId}\` (\`${filePath}\`)`,
        `Author: @${me.login}`,
      ].join('\n'),
    }),
  });
  if (!prResp.ok) {
    throw new Error(`PR 创建失败: ${prResp.status} ${await prResp.text()}`);
  }
  const pr = (await prResp.json()) as { html_url: string };

  return { prUrl: pr.html_url, branchName };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

function utf8ToBase64(s: string): string {
  // Browser-safe UTF-8 → base64. window.btoa() can't handle non-Latin1 directly.
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
