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
  const remote = owner && repo ? { owner, repo } : await inferGitHubRemote(repoPath);
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

  if (dryRun) {
    return {
      action: 'open_draft_pull_request',
      dry_run: true,
      repository: `${remote.owner}/${remote.repo}`,
      review_branch: prepared,
      payload
    };
  }

  const token = envValue(['GITHUB_TOKEN', 'GH_TOKEN'], env);
  if (!token) throw new Error('Set GITHUB_TOKEN or GH_TOKEN to open a pull request through the GitHub API.');
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

async function inferGitHubRemote(repoPath) {
  const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoPath });
  const remote = stdout.trim();
  const ssh = remote.match(/github(?:-[\w-]+)?[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  const https = remote.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  const match = ssh || https;
  if (!match) throw new Error(`could not infer GitHub owner/repo from remote: ${remote}`);
  return { owner: match[1], repo: match[2] };
}
