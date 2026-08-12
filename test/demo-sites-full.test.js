import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  buildClientBundleSmokeTarget,
  buildPreviewSmokeTargets,
  evaluateClientBundleSmokeFiles,
  evaluatePreviewSmokeHtml
} from '../src/preview-smoke.js';

const execFileAsync = promisify(execFile);

test('full demo-site runner lists framework validation targets', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/test-demo-sites-full.mjs', '--list'], {
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(stdout);

  assert.equal(result.action, 'test_demo_sites_full');
  assert.ok(result.sites.some((site) => site.site === 'astro' && site.framework_build));
  assert.ok(result.sites.some((site) => site.site === 'astro' && site.generated_integration_compile));
  assert.ok(result.sites.some((site) => site.site === 'next' && site.preview_url === 'http://127.0.0.1:4402/'));
  assert.ok(result.sites.some((site) => site.site === 'static' && !site.framework_build));
  assert.ok(result.sites.some((site) => site.site === 'static' && !site.generated_integration_compile));
});

test('full demo-site runner keeps static validation dependency-free', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/test-demo-sites-full.mjs', '--site', 'static'], {
    maxBuffer: 1024 * 1024
  });

  assert.match(stdout, /demo build check passed: hts-demo-static/);
  assert.match(stdout, /"site": "static"/);
  assert.match(stdout, /"status": "lightweight_only"/);
});

test('preview smoke evidence validates server-rendered generated route markers', () => {
  const targets = buildPreviewSmokeTargets({
    baseUrl: 'http://127.0.0.1:4402/',
    site: 'next',
    generated: {
      integration_id: 'demo-next-generated-compile-v1',
      smoke_route: '/about',
      storyblok_slug: 'demo-next-generated-compile-v1/about'
    }
  });
  const generatedRoute = targets.find((target) => target.name === 'generated_route');

  assert.equal(generatedRoute.url, 'http://127.0.0.1:4402/about');
  const result = evaluatePreviewSmokeHtml(generatedRoute, {
    responseOk: true,
    httpStatus: 200,
    html: '<!doctype html><html><body><span data-hts-storyblok-source="generated-fallback" data-hts-storyblok-slug="demo-next-generated-compile-v1/about"></span><main data-integration="demo-next-generated-compile-v1"></main></body></html>'
  });

  assert.equal(result.status, 'passed');
  assert.ok(result.checks.some((check) => check.name === 'storyblok_slug_marker' && check.status === 'passed'));
});

test('preview smoke evidence fails server-rendered generated route marker drift', () => {
  const generatedRoute = buildPreviewSmokeTargets({
    baseUrl: 'http://127.0.0.1:4401/',
    site: 'astro',
    generated: {
      integration_id: 'demo-astro-generated-compile-v1',
      smoke_route: '/about',
      storyblok_slug: 'demo-astro-generated-compile-v1/about'
    }
  }).find((target) => target.name === 'generated_route');
  const result = evaluatePreviewSmokeHtml(generatedRoute, {
    responseOk: true,
    httpStatus: 200,
    html: '<!doctype html><html><body><main data-integration="demo-astro-generated-compile-v1"></main></body></html>'
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /storyblok_source_marker/);
});

test('preview smoke evidence marks Vite demo routes as client app shell checks', () => {
  const generatedRoute = buildPreviewSmokeTargets({
    baseUrl: 'http://127.0.0.1:4405/',
    site: 'react',
    generated: {
      integration_id: 'demo-react-generated-compile-v1',
      smoke_route: '/',
      storyblok_slug: 'demo-react-generated-compile-v1/home'
    }
  }).find((target) => target.name === 'generated_route');
  const result = evaluatePreviewSmokeHtml(generatedRoute, {
    responseOk: true,
    httpStatus: 200,
    html: '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>'
  });

  assert.equal(generatedRoute.render_mode, 'client_app_shell');
  assert.equal(result.status, 'passed');
  assert.ok(result.checks.some((check) => check.name === 'client_app_shell' && check.status === 'passed'));
});

test('client bundle smoke evidence validates generated React and Vue bundle inclusion', () => {
  const target = buildClientBundleSmokeTarget({
    site: 'vue',
    generated: {
      integration_id: 'demo-vue-generated-compile-v1'
    }
  });
  const result = evaluateClientBundleSmokeFiles(target, [{
    path: 'assets/index.js',
    content: 'const integration="demo-vue-generated-compile-v1";const headline="Generated integration compile smoke";'
  }]);

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.matched_files, ['assets/index.js']);
});

test('client bundle smoke evidence fails when generated tokens are missing', () => {
  const target = buildClientBundleSmokeTarget({
    site: 'react',
    generated: {
      integration_id: 'demo-react-generated-compile-v1'
    }
  });
  const result = evaluateClientBundleSmokeFiles(target, [{
    path: 'assets/index.js',
    content: 'const app="existing shell only";'
  }]);

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /integration_id_in_bundle/);
  assert.match(result.reason, /generated_story_seed_in_bundle/);
});
