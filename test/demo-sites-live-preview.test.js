import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('live demo preview runner lists configured deployed URL checks', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/test-demo-sites-live-preview.mjs', '--list'], {
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(stdout);

  assert.equal(result.action, 'test_demo_sites_live_preview');
  assert.equal(result.status, 'listed');
  assert.ok(result.routes.includes('/contact'));
  assert.ok(result.sites.some((site) => site.site === 'astro' && site.env === 'HTS_DEMO_ASTRO_URL'));
});

test('live demo preview runner passes when deployed routes expose Storyblok draft markers', async () => {
  const fixture = await writeFixture({
    '/about': '<!doctype html><html><body><span data-hts-storyblok-source="storyblok-draft" data-hts-storyblok-slug="acme-campaign-v1/about" hidden></span><main>About</main></body></html>'
  });
  const { stdout } = await execFileAsync('node', [
    'scripts/test-demo-sites-live-preview.mjs',
    '--site',
    'astro',
    '--base-url',
    'https://astro-demo.example.test',
    '--routes',
    '/about',
    '--integration-id',
    'acme-campaign-v1',
    '--require-storyblok-draft',
    '--require-configured',
    '--fixture',
    fixture
  ], { maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'passed');
  assert.equal(result.sites[0].routes[0].storyblok_draft_rendered, true);
  assert.equal(result.sites[0].routes[0].storyblok_slug, 'acme-campaign-v1/about');
});

test('live demo preview runner fails when a deployed route returns 404', async () => {
  const fixture = await writeFixture({
    '/': '<!doctype html><html><body><span data-hts-storyblok-source="generated-fallback" data-hts-storyblok-slug="acme-campaign-v1/home" hidden></span><main>Home</main></body></html>',
    '/about': {
      status: 404,
      body: '<!doctype html><html><body>Not found</body></html>'
    }
  });
  await assert.rejects(
    execFileAsync('node', [
      'scripts/test-demo-sites-live-preview.mjs',
      '--site',
      'astro',
      '--base-url',
      'https://astro-demo.example.test',
      '--routes',
      '/,/about',
      '--require-configured',
      '--fixture',
      fixture
    ], { maxBuffer: 1024 * 1024 }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, 'failed');
      const about = result.sites[0].routes.find((route) => route.route === '/about');
      assert.equal(about.status, 'failed');
      assert.equal(about.http_status, 404);
      return true;
    }
  );
});

async function writeFixture(content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-fixture-'));
  const filePath = path.join(directory, 'responses.json');
  await writeFile(filePath, JSON.stringify(content));
  return filePath;
}
