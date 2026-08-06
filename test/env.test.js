import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadEnvironment, parseDotEnv } from '../src/env.js';

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
});
