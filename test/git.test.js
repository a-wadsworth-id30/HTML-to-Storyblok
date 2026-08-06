import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { currentGitBranch, prepareReviewBranch } from '../src/git.js';
import { createDefaultManifest } from '../src/policy.js';

const execFileAsync = promisify(execFile);

test('prepareReviewBranch creates a review branch and commits integration-owned files only', async () => {
  const repoPath = await createGitRepo();
  const manifest = manifestWithGeneratedFile();
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/README.md'), '# Integration\n');

  const result = await prepareReviewBranch({
    repoPath,
    manifest,
    commit: true
  });

  assert.equal(result.branch, 'html-to-storyblok/acme-homepage-v1');
  assert.equal(result.commit.status, 'created');
  assert.equal(await currentGitBranch(repoPath), 'html-to-storyblok/acme-homepage-v1');
  assert.equal(await gitOutput(repoPath, ['log', '-1', '--pretty=%s']), 'Add HTML-to-Storyblok integration acme-homepage-v1');
  assert.equal(await gitOutput(repoPath, ['status', '--short']), '');
});

test('prepareReviewBranch refuses to stage changes outside the integration namespace', async () => {
  const repoPath = await createGitRepo();
  const manifest = manifestWithGeneratedFile();
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/README.md'), '# Integration\n');
  await writeFile(path.join(repoPath, 'README.md'), '# Changed outside namespace\n');

  await assert.rejects(
    prepareReviewBranch({
      repoPath,
      manifest,
      commit: true
    }),
    /outside the integration namespace/
  );
});

async function createGitRepo() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-git-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'HTML to Storyblok Test'], { cwd: repoPath });
  await writeFile(path.join(repoPath, 'README.md'), '# Test repo\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  return repoPath;
}

function manifestWithGeneratedFile() {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.repository.files_to_create.push('src/integrations/acme-homepage-v1/README.md');
  return manifest;
}

async function gitOutput(repoPath, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath });
  return stdout.trim();
}
