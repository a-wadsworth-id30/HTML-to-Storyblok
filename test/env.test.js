import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENV_TEMPLATE, getEnvironmentSources, initEnvFile, loadEnvironment, parseDotEnv } from '../src/env.js';

test('parseDotEnv handles comments, exports, quotes, and inline comments', () => {
  const parsed = parseDotEnv(`
# ignored
export STORYBLOK_SPACE_ID=12345
STORYBLOK_REGION="us"
STORYBLOK_PREVIEW_TOKEN='preview-token'
NETLIFY_SITE_ID=site-id # trailing comment
MULTILINE="one\\ntwo"
`);

  assert.deepEqual(parsed, {
    STORYBLOK_SPACE_ID: '12345',
    STORYBLOK_REGION: 'us',
    STORYBLOK_PREVIEW_TOKEN: 'preview-token',
    NETLIFY_SITE_ID: 'site-id',
    MULTILINE: 'one\ntwo'
  });
});

test('loadEnvironment merges cwd and repository .env files without overriding shell env', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-env-'));
  const repoPath = path.join(root, 'client-site');
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(root, '.env'), [
    'STORYBLOK_REGION=eu',
    'STORYBLOK_SPACE_ID=root-space',
    ''
  ].join('\n'));
  await writeFile(path.join(repoPath, '.env'), [
    'STORYBLOK_SPACE_ID=repo-space',
    'STORYBLOK_MANAGEMENT_TOKEN=repo-token',
    ''
  ].join('\n'));
  await writeFile(path.join(repoPath, '.env.local'), [
    'STORYBLOK_MANAGEMENT_TOKEN=local-token',
    'NETLIFY_SITE_ID=local-site',
    ''
  ].join('\n'));

  const result = await loadEnvironment({
    cwd: root,
    repoPath,
    env: {
      STORYBLOK_MANAGEMENT_TOKEN: 'shell-token'
    },
    config: {
      storyblok_region: 'us'
    }
  });

  assert.equal(result.env.STORYBLOK_REGION, 'eu');
  assert.equal(result.env.STORYBLOK_SPACE_ID, 'repo-space');
  assert.equal(result.env.STORYBLOK_MANAGEMENT_TOKEN, 'shell-token');
  assert.equal(result.env.NETLIFY_SITE_ID, 'local-site');
  assert.equal(result.files_loaded.length, 3);
  assert.deepEqual(result.variables_loaded, ['NETLIFY_SITE_ID', 'STORYBLOK_REGION', 'STORYBLOK_SPACE_ID']);
  const sources = getEnvironmentSources(result.env);
  assert.equal(sources.STORYBLOK_MANAGEMENT_TOKEN.source, 'shell');
  assert.equal(sources.STORYBLOK_SPACE_ID.source, 'env_file');
  assert.equal(path.basename(sources.STORYBLOK_SPACE_ID.file), '.env');
  assert.equal(sources.NETLIFY_SITE_ID.source, 'env_file');
  assert.equal(path.basename(sources.NETLIFY_SITE_ID.file), '.env.local');
});

test('loadEnvironment uses non-secret Storyblok profile defaults when env files omit them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-env-profile-'));

  const result = await loadEnvironment({
    cwd: root,
    env: {},
    config: {
      storyblok_region: 'us',
      storyblok_space_id: 'profile-space'
    }
  });

  assert.equal(result.env.STORYBLOK_REGION, 'us');
  assert.equal(result.env.STORYBLOK_SPACE_ID, 'profile-space');
  assert.deepEqual(result.files_loaded, []);
  const sources = getEnvironmentSources(result.env);
  assert.equal(sources.STORYBLOK_REGION.source, 'profile');
  assert.equal(sources.STORYBLOK_SPACE_ID.source, 'profile');
});

test('ENV_TEMPLATE includes all supported sensitive integration variables as placeholders', () => {
  for (const name of [
    'STORYBLOK_MANAGEMENT_TOKEN',
    'STORYBLOK_OAUTH_TOKEN',
    'STORYBLOK_PERSONAL_ACCESS_TOKEN',
    'STORYBLOK_SPACE_ID',
    'SB_SPACE_ID',
    'STORYBLOK_PREVIEW_TOKEN',
    'STORYBLOK_PUBLIC_TOKEN',
    'STORYBLOK_DELIVERY_TOKEN',
    'NETLIFY_AUTH_TOKEN',
    'NETLIFY_TOKEN',
    'NETLIFY_SITE_ID',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITLAB_TOKEN',
    'GITLAB_PRIVATE_TOKEN',
    'GITLAB_BASE_URL'
  ]) {
    assert.match(ENV_TEMPLATE, new RegExp(`^${name}=`, 'm'));
  }
});

test('initEnvFile writes a gitignored local scaffold without secret values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-env-init-'));

  const result = await initEnvFile({ cwd: root });
  const content = await readFile(path.join(root, '.env.local'), 'utf8');

  assert.equal(result.relative_path, '.env.local');
  assert.equal(result.secrets_written, false);
  assert.equal(result.gitignored, true);
  assert.equal(content, ENV_TEMPLATE);
  assert.match(content, /^GITHUB_TOKEN=$/m);
  assert.doesNotMatch(content, /your-token|secret-token|management-token|preview-token/i);
});

test('initEnvFile refuses to overwrite without force', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-env-overwrite-'));
  await initEnvFile({ cwd: root });

  await assert.rejects(
    initEnvFile({ cwd: root }),
    /\.env\.local already exists; pass --force to overwrite it/
  );
});
