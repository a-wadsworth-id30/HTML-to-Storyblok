import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { main } from '../src/cli.js';
import { buildHtmlVisualSnapshot, buildVisualBaseline } from '../src/visual-regression.js';

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

test('demo-sites-live-preview CLI command delegates to the live runner', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-cli-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'demo-sites-live-preview',
    '--list',
    '--work-dir',
    workDir,
    '--no-interactive'
  ]));
  const result = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'demo-sites-live-preview-result.json'), 'utf8'));

  assert.equal(result.action, 'test_demo_sites_live_preview');
  assert.equal(result.status, 'listed');
  assert.equal(artifact.action, 'test_demo_sites_live_preview');
  assert.ok(result.sites.some((site) => site.site === 'next' && site.env === 'HTS_DEMO_NEXT_URL'));
});

test('demo-sites-live-preview CLI command writes markdown evidence reports', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-cli-report-'));
  const fixture = await writeFixture({
    '/': '<!doctype html><html><body><span data-hts-storyblok-source="generated-fallback" data-hts-storyblok-slug="acme-campaign-v1/home" hidden></span><main>Home</main></body></html>'
  });
  const reportPath = path.join(workDir, 'live-preview.md');
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'demo-sites-live-preview',
    '--site',
    'astro',
    '--base-url',
    'https://astro-demo.example.test',
    '--routes',
    '/',
    '--require-configured',
    '--fixture',
    fixture,
    '--report-path',
    reportPath,
    '--work-dir',
    workDir,
    '--no-interactive'
  ]));
  const result = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'demo-sites-live-preview-result.json'), 'utf8'));

  assert.equal(result.status, 'passed');
  assert.equal(result.preview_report, reportPath);
  assert.equal(artifact.preview_report, reportPath);
  assert.match(await readFile(reportPath, 'utf8'), /Demo Site Live Preview Evidence/);
});

test('live demo preview runner passes when deployed routes expose Storyblok draft markers', async () => {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-report-'));
  const reportPath = path.join(reportRoot, 'preview.md');
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
    fixture,
    '--report-path',
    reportPath
  ], { maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'passed');
  assert.equal(result.preview_report, reportPath);
  assert.equal(result.sites[0].routes[0].storyblok_draft_rendered, true);
  assert.equal(result.sites[0].routes[0].storyblok_slug, 'acme-campaign-v1/about');
  assert.match(await readFile(reportPath, 'utf8'), /\/about: passed HTTP 200 source=storyblok-draft/);
});

test('live demo preview runner writes visual baselines from rendered routes', async () => {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-visual-'));
  const baselinePath = path.join(reportRoot, 'visual-baseline.json');
  const fixture = await writeFixture({
    '/': '<!doctype html><html><body><span data-hts-storyblok-source="storyblok-draft" data-hts-storyblok-slug="acme-campaign-v1/home" hidden></span><main data-integration="acme-campaign-v1"><h1>Home</h1><img src="/hero.svg" alt="Hero"></main></body></html>'
  });
  const { stdout } = await execFileAsync('node', [
    'scripts/test-demo-sites-live-preview.mjs',
    '--site',
    'astro',
    '--base-url',
    'https://astro-demo.example.test',
    '--routes',
    '/',
    '--fixture',
    fixture,
    '--visual',
    '--write-visual-baseline',
    baselinePath
  ], { maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));

  assert.equal(result.status, 'passed');
  assert.equal(result.visual_regression, true);
  assert.equal(result.visual_baseline, baselinePath);
  assert.equal(result.visual_summary.snapshots, 1);
  assert.equal(result.sites[0].routes[0].visual_snapshot.status, 'passed');
  assert.ok(baseline.snapshots['astro /']);
});

test('live demo preview runner fails when visual baseline drifts', async () => {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-visual-drift-'));
  const baselinePath = path.join(reportRoot, 'visual-baseline.json');
  const baselineSnapshot = buildHtmlVisualSnapshot('<!doctype html><html><body><main data-integration="acme-campaign-v1"><h1>Home</h1><a href="/contact">Contact</a></main></body></html>', {
    site: 'astro',
    route: '/'
  });
  await writeFile(baselinePath, JSON.stringify(buildVisualBaseline([baselineSnapshot]), null, 2));
  const fixture = await writeFixture({
    '/': '<!doctype html><html><body><main data-integration="acme-campaign-v1"><h1>Changed Home</h1><a href="/pricing">Pricing</a></main></body></html>'
  });

  await assert.rejects(
    execFileAsync('node', [
      'scripts/test-demo-sites-live-preview.mjs',
      '--site',
      'astro',
      '--base-url',
      'https://astro-demo.example.test',
      '--routes',
      '/',
      '--fixture',
      fixture,
      '--visual-baseline',
      baselinePath
    ], { maxBuffer: 1024 * 1024 }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, 'failed');
      assert.equal(result.visual_summary.regressions, 1);
      assert.equal(result.sites[0].routes[0].visual_comparison.status, 'failed');
      assert.match(result.sites[0].routes[0].reason, /Visual regression failed/);
      return true;
    }
  );
});

test('live demo preview runner fails when a deployed route returns 404', async () => {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-fail-report-'));
  const reportPath = path.join(reportRoot, 'preview.md');
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
      fixture,
      '--report-path',
      reportPath
    ], { maxBuffer: 1024 * 1024 }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, 'failed');
      assert.equal(result.preview_report, reportPath);
      const about = result.sites[0].routes.find((route) => route.route === '/about');
      assert.equal(about.status, 'failed');
      assert.equal(about.http_status, 404);
      return true;
    }
  );
  assert.match(await readFile(reportPath, 'utf8'), /\/about: failed HTTP 404/);
});

async function writeFixture(content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hts-live-preview-fixture-'));
  const filePath = path.join(directory, 'responses.json');
  await writeFile(filePath, JSON.stringify(content));
  return filePath;
}

async function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, done) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof done === 'function') done();
    return true;
  };
  try {
    await callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
