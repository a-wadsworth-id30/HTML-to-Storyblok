import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { branchNameForManifest, currentGitBranch, prepareReviewBranch } from './git.js';
import { envValue } from './utils.js';

const execFileAsync = promisify(execFile);

export async function openDraftPullRequest({
  repoPath = process.cwd(),
  owner,
  repo,
  title,
  body,
  head,
  base = 'main',
  manifest = null,
  prepareBranch = false,
  commit = false,
  push = false,
  commitMessage,
  remoteName = 'origin',
  dryRun = false,
  env = process.env
} = {}) {
  const remote = owner && repo ? { owner, repo } : await inferGitHubRemote(repoPath, remoteName);
  const prepared = prepareBranch || commit || push
    ? await prepareReviewBranch({
      repoPath,
      manifest,
      branch: head || branchNameForManifest(manifest),
      base,
      remote: remoteName,
      commit,
      push,
      commitMessage,
      dryRun
    })
    : null;
  const currentBranch = prepared?.branch || head || await currentGitBranch(repoPath);
  const payload = {
    title: title || `HTML-to-Storyblok integration: ${currentBranch}`,
    body: body || 'Draft pull request opened by html-to-storyblok.',
    head: currentBranch,
    base,
    draft: true,
    maintainer_can_modify: true
  };
  const manualUrl = githubPullRequestUrl(remote, base, currentBranch);

  if (dryRun) {
    return {
      action: 'open_draft_pull_request',
      dry_run: true,
      repository: `${remote.owner}/${remote.repo}`,
      review_branch: prepared,
      url: manualUrl,
      payload
    };
  }

  const token = envValue(['GITHUB_TOKEN', 'GH_TOKEN'], env);
  if (!token) {
    throw new Error(`Set GITHUB_TOKEN or GH_TOKEN to open a pull request through the GitHub API. Manual PR URL: ${manualUrl}`);
  }
  const response = await fetch(`https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'html-to-storyblok-cli'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub create pull request failed with ${response.status}: ${data.message || JSON.stringify(data)}`);
  }
  return {
    action: 'open_draft_pull_request',
    dry_run: false,
    repository: `${remote.owner}/${remote.repo}`,
    review_branch: prepared,
    number: data.number,
    url: data.html_url,
    status: data.draft ? 'draft' : 'open'
  };
}

export async function inferGitHubRemote(repoPath, remoteName = 'origin') {
  const { stdout } = await execFileAsync('git', ['config', '--get', `remote.${remoteName}.url`], { cwd: repoPath });
  const remote = stdout.trim();
  const parsed = parseGitHubRemote(remote);
  if (!parsed) throw new Error(`could not infer GitHub owner/repo from remote: ${remote}`);
  return parsed;
}

export function parseGitHubRemote(remote) {
  const value = String(remote || '').trim();
  if (!value) return null;

  const url = parseRemoteUrl(value);
  const scp = url ? null : value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  const host = url?.host || scp?.[1];
  const pathname = url?.pathname || scp?.[2];

  if (!host || !pathname || !isGitHubHost(host)) return null;

  const parts = pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  if (parts.length !== 2) return null;
  return {
    owner: decodeURIComponent(parts[0]),
    repo: decodeURIComponent(parts[1])
  };
}

function parseRemoteUrl(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return {
      host: parsed.hostname,
      pathname: parsed.pathname
    };
  } catch {
    return null;
  }
}

function isGitHubHost(host) {
  const value = String(host || '').toLowerCase();
  return (
    value === 'github.com' ||
    value === 'github' ||
    value.startsWith('github.') ||
    value.startsWith('github-') ||
    value.includes('.github.')
  );
}

function githubPullRequestUrl(remote, base, head) {
  const owner = encodeURIComponent(remote.owner);
  const repo = encodeURIComponent(remote.repo);
  const baseRef = encodeURIComponent(base);
  const headRef = encodeURIComponent(head);
  return `https://github.com/${owner}/${repo}/compare/${baseRef}...${headRef}?expand=1`;
}
