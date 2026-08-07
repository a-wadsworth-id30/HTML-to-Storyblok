import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inferGitHubRemote, openDraftPullRequest, parseGitHubRemote } from '../src/github.js';

const execFileAsync = promisify(execFile);

test('openDraftPullRequest produces draft GitHub payload in dry run', async () => {
  const result = await openDraftPullRequest({
    owner: 'example',
    repo: 'client-site',
    head: 'feature/html-template',
    base: 'main',
    title: 'Integrate template',
    dryRun: true
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.repository, 'example/client-site');
  assert.equal(result.payload.head, 'feature/html-template');
  assert.equal(result.payload.base, 'main');
  assert.equal(result.payload.title, 'Integrate template');
  assert.equal(result.payload.draft, true);
  assert.equal(result.url, 'https://github.com/example/client-site/compare/main...feature%2Fhtml-template?expand=1');
});

test('parseGitHubRemote parses SSH GitHub remotes', () => {
  assert.deepEqual(
    parseGitHubRemote('git@github.com:a-wadsworth-id30/html-to-storyblok-demo-sites.git'),
    {
      owner: 'a-wadsworth-id30',
      repo: 'html-to-storyblok-demo-sites'
    }
  );
});

test('parseGitHubRemote parses SSH URL GitHub remotes', () => {
  assert.deepEqual(
    parseGitHubRemote('ssh://git@github.com/a-wadsworth-id30/html-to-storyblok-demo-sites.git'),
    {
      owner: 'a-wadsworth-id30',
      repo: 'html-to-storyblok-demo-sites'
    }
  );
});

test('parseGitHubRemote parses HTTPS GitHub remotes', () => {
  assert.deepEqual(
    parseGitHubRemote('https://github.com/a-wadsworth-id30/html-to-storyblok-demo-sites.git'),
    {
      owner: 'a-wadsworth-id30',
      repo: 'html-to-storyblok-demo-sites'
    }
  );
});

test('parseGitHubRemote parses GitHub SSH host aliases', () => {
  assert.deepEqual(
    parseGitHubRemote('git@github-id30:a-wadsworth-id30/html-to-storyblok-demo-sites.git'),
    {
      owner: 'a-wadsworth-id30',
      repo: 'html-to-storyblok-demo-sites'
    }
  );
});

test('parseGitHubRemote rejects non-GitHub remotes', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:group/project.git'), null);
});

test('inferGitHubRemote parses configured SSH origin remotes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-github-'));
  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:a-wadsworth-id30/html-to-storyblok-demo-sites.git'], { cwd: repoPath });

  const remote = await inferGitHubRemote(repoPath);
  assert.equal(remote.owner, 'a-wadsworth-id30');
  assert.equal(remote.repo, 'html-to-storyblok-demo-sites');
});

test('inferGitHubRemote respects the selected remote name', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-github-remote-'));
  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@gitlab.com:group/project.git'], { cwd: repoPath });
  await execFileAsync('git', ['remote', 'add', 'id30', 'git@github.com:a-wadsworth-id30/html-to-storyblok-demo-sites.git'], { cwd: repoPath });

  const remote = await inferGitHubRemote(repoPath, 'id30');
  assert.equal(remote.owner, 'a-wadsworth-id30');
  assert.equal(remote.repo, 'html-to-storyblok-demo-sites');
});

test('openDraftPullRequest reports a manual URL when credentials are missing', async () => {
  await assert.rejects(
    openDraftPullRequest({
      owner: 'example',
      repo: 'client-site',
      head: 'feature/html-template',
      base: 'main',
      title: 'Integrate template',
      env: {}
    }),
    /Manual PR URL: https:\/\/github\.com\/example\/client-site\/compare\/main\.\.\.feature%2Fhtml-template\?expand=1/
  );
});
