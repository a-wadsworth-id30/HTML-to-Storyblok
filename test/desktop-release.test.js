import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('desktop package metadata is configured for internal Electron releases', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.main, 'desktop/main.js');
  assert.equal(packageJson.license, 'UNLICENSED');
  assert.equal(packageJson.build.appId, 'com.id30.html-to-storyblok');
  assert.equal(packageJson.build.productName, 'HTML-to-Storyblok');
  assert.equal(packageJson.build.directories.output, 'dist/desktop');
  assert.equal(packageJson.build.asar, false);
  assert.ok(packageJson.devDependencies.electron);
  assert.ok(packageJson.devDependencies['electron-builder']);
  assert.ok(packageJson.scripts['desktop:release-check']);
  assert.ok(packageJson.scripts['desktop:pack']);
  assert.ok(packageJson.scripts['desktop:dist']);
});

test('desktop package includes only explicit application paths and no secret build env', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const files = packageJson.build.files;

  assert.deepEqual(files, [
    'bin/**/*',
    'desktop/**/*',
    'src/**/*',
    'templates/**/*',
    'id30-logo.svg',
    'package.json'
  ]);

  const serializedBuild = JSON.stringify(packageJson.build);
  assert.doesNotMatch(serializedBuild, /STORYBLOK_MANAGEMENT_TOKEN|STORYBLOK_PREVIEW_TOKEN|NETLIFY_AUTH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN/);
});

test('desktop release check script passes and reports signing boundary', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/desktop-release-check.mjs'], {
    cwd: new URL('..', import.meta.url).pathname
  });
  const result = JSON.parse(stdout);

  assert.equal(result.action, 'desktop_release_check');
  assert.equal(result.status, 'passed');
  assert.equal(result.product_name, 'HTML-to-Storyblok');
  assert.equal(result.app_id, 'com.id30.html-to-storyblok');
  assert.equal(result.issues.length, 0);
  assert.ok(result.warnings.some((warning) => /signing and notarization/i.test(warning)));
});
