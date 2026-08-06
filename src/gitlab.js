import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { branchNameForManifest, currentGitBranch, prepareReviewBranch } from './git.js';
import { envValue } from './utils.js';

const execFileAsync = promisify(execFile);

export async function openDraftMergeRequest({
  repoPath = process.cwd(),
  project,
  title,
  body,
  sourceBranch,
  targetBranch = 'main',
  removeSourceBranch = false,
  manifest = null,
  prepareBranch = false,
  commit = false,
  push = false,
  commitMessage,
  remoteName = 'origin',
  dryRun = false,
  env = process.env
} = {}) {
  const remote = project ? { project, webUrl: null } : await inferGitLabRemote(repoPath);
  const prepared = prepareBranch || commit || push
    ? await prepareReviewBranch({
      repoPath,
      manifest,
      branch: sourceBranch || branchNameForManifest(manifest),
      base: targetBranch,
      remote: remoteName,
      commit,
      push,
      commitMessage,
      dryRun
    })
    : null;
  const currentBranch = prepared?.branch || sourceBranch || await currentGitBranch(repoPath);
  const draftTitle = ensureDraftTitle(title || `HTML-to-Storyblok integration: ${currentBranch}`);
  const payload = {
    source_branch: currentBranch,
    target_branch: targetBranch,
    title: draftTitle,
    description: body || 'Draft merge request opened by html-to-storyblok.',
    remove_source_branch: Boolean(removeSourceBranch)
  };

  if (dryRun) {
    return {
      action: 'open_draft_merge_request',
      dry_run: true,
      project: remote.project,
      review_branch: prepared,
      payload
    };
  }

  const token = envValue(['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN'], env);
  if (!token) throw new Error('Set GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN to open a merge request through the GitLab API.');
  const baseUrl = normalizeBaseUrl(envValue(['GITLAB_BASE_URL'], env) || remote.baseUrl || 'https://gitlab.com');
  const encodedProject = encodeURIComponent(remote.project);
  const response = await fetch(`${baseUrl}/api/v4/projects/${encodedProject}/merge_requests`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
      'User-Agent': 'html-to-storyblok-cli'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`GitLab create merge request failed with ${response.status}: ${data.message || JSON.stringify(data)}`);
  }
  return {
    action: 'open_draft_merge_request',
    dry_run: false,
    project: remote.project,
    review_branch: prepared,
    iid: data.iid,
    id: data.id,
    url: data.web_url,
    status: data.draft || data.work_in_progress ? 'draft' : 'open'
  };
}

export async function inferGitLabRemote(repoPath) {
  const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoPath });
  const remote = stdout.trim();
  const ssh = remote.match(/^(?:git@)?([^:/]+):(.+?)(?:\.git)?$/);
  const sshUrl = remote.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/);
  const https = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  const match = sshUrl || https || ssh;
  if (!match || !match[1].includes('gitlab')) throw new Error(`could not infer GitLab project from remote: ${remote}`);
  return {
    host: match[1],
    baseUrl: `https://${match[1]}`,
    project: match[2]
  };
}

function ensureDraftTitle(title) {
  return /^(draft:|\[draft\]|\(draft\))/i.test(title) ? title : `Draft: ${title}`;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, '');
}
