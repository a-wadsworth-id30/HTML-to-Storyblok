import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inferGitLabRemote, openDraftMergeRequest } from '../src/gitlab.js';

const execFileAsync = promisify(execFile);

test('openDraftMergeRequest produces draft GitLab payload in dry run', async () => {
  const result = await openDraftMergeRequest({
    project: 'group/project',
    sourceBranch: 'feature/html-template',
    targetBranch: 'main',
    title: 'Integrate template',
    dryRun: true
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.project, 'group/project');
  assert.equal(result.payload.source_branch, 'feature/html-template');
  assert.equal(result.payload.target_branch, 'main');
  assert.equal(result.payload.title, 'Draft: Integrate template');
});

test('inferGitLabRemote parses GitLab SSH remotes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-gitlab-'));
  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@gitlab.com:group/subgroup/project.git'], { cwd: repoPath });

  const remote = await inferGitLabRemote(repoPath);
  assert.equal(remote.host, 'gitlab.com');
  assert.equal(remote.project, 'group/subgroup/project');
});
