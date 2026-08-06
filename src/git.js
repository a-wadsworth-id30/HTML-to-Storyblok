import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { validatePlan } from './policy.js';
import { ensureArray } from './utils.js';

const execFileAsync = promisify(execFile);

export async function prepareReviewBranch({
  repoPath = process.cwd(),
  manifest = null,
  branch,
  base = 'main',
  remote = 'origin',
  commit = false,
  push = false,
  commitMessage,
  dryRun = false
} = {}) {
  const root = path.resolve(repoPath);
  const currentBranch = await currentGitBranch(root);
  const resolvedBranch = branch || branchNameForManifest(manifest) || currentBranch;
  const plannedPaths = manifest ? integrationOwnedPaths(manifest) : [];
  if (commit && !manifest) {
    throw new Error('git commit orchestration requires --manifest so only integration-owned files can be staged.');
  }
  if (manifest) {
    const validation = validatePlan(manifest);
    if (!validation.valid) {
      throw new Error('git commit orchestration refused because the manifest failed additive-only validation.');
    }
  }

  const steps = [];
  if (resolvedBranch !== currentBranch) {
    const branchExists = await gitBranchExists(root, resolvedBranch);
    steps.push({
      action: branchExists ? 'switch_branch' : 'create_branch',
      branch: resolvedBranch,
      base
    });
    if (!dryRun) {
      await execGit(root, branchExists ? ['switch', resolvedBranch] : ['switch', '-c', resolvedBranch]);
    }
  }

  let commitResult = null;
  if (commit) {
    const unsafe = await changedFilesOutsideIntegration(root, manifest);
    if (unsafe.length > 0) {
      throw new Error(`refusing to stage changes outside the integration namespace: ${unsafe.join(', ')}`);
    }
    steps.push({
      action: 'stage_integration_paths',
      paths: plannedPaths
    });
    if (!dryRun && plannedPaths.length > 0) {
      await execGit(root, ['add', '--', ...plannedPaths]);
    }

    const hasStagedChanges = dryRun ? true : await stagedChangesExist(root);
    commitResult = {
      action: 'commit_integration_changes',
      message: commitMessage || defaultCommitMessage(manifest),
      status: hasStagedChanges ? 'planned' : 'skipped_no_changes'
    };
    steps.push(commitResult);
    if (!dryRun && hasStagedChanges) {
      await execGit(root, ['commit', '-m', commitResult.message]);
      commitResult.status = 'created';
      commitResult.sha = await gitOutput(root, ['rev-parse', 'HEAD']);
    }
  }

  let pushResult = null;
  if (push) {
    pushResult = {
      action: 'push_review_branch',
      remote,
      branch: resolvedBranch
    };
    steps.push(pushResult);
    if (!dryRun) {
      await execGit(root, ['push', '-u', remote, resolvedBranch]);
      pushResult.status = 'pushed';
    } else {
      pushResult.status = 'planned';
    }
  }

  return {
    action: 'prepare_review_branch',
    dry_run: dryRun,
    repository_path: root,
    branch: resolvedBranch,
    base,
    remote,
    planned_paths: plannedPaths,
    commit: commitResult,
    push: pushResult,
    steps
  };
}

export async function currentGitBranch(repoPath = process.cwd()) {
  const branch = await gitOutput(repoPath, ['branch', '--show-current']);
  if (!branch) throw new Error('could not determine current Git branch');
  return branch;
}

export function branchNameForManifest(manifest) {
  return manifest?.integration_id ? `html-to-storyblok/${manifest.integration_id}` : null;
}

export function integrationOwnedPaths(manifest) {
  return unique([
    ...ensureArray(manifest.repository?.files_to_create),
    ...ensureArray(manifest.repository?.components_to_duplicate).map((entry) => entry.target_path || entry.target),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => asset.target_path || asset.path)
  ].filter(Boolean));
}

async function changedFilesOutsideIntegration(repoPath, manifest) {
  const status = await gitOutput(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  return status
    .split('\n')
    .map((line) => parseStatusPath(line))
    .filter(Boolean)
    .filter((filePath) => !isIntegrationOwnedPath(manifest, filePath));
}

function isIntegrationOwnedPath(manifest, filePath) {
  const normalized = stripStatusQuotes(filePath);
  return normalized.startsWith(`${manifest.repository_namespace}/`) ||
    normalized.startsWith(`public/integrations/${manifest.integration_id}/`);
}

function parseStatusPath(line) {
  if (!line.trim()) return null;
  const raw = line.slice(3).trim();
  if (raw.includes(' -> ')) return raw.split(' -> ').at(-1);
  return raw;
}

async function stagedChangesExist(repoPath) {
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: repoPath });
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

async function gitBranchExists(repoPath, branch) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(repoPath, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout.trim();
}

async function execGit(repoPath, args) {
  await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024
  });
}

function defaultCommitMessage(manifest) {
  return `Add HTML-to-Storyblok integration ${manifest.integration_id}`;
}

function stripStatusQuotes(value) {
  return String(value || '').replace(/^"|"$/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
