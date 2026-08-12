import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHtmlVisualSnapshot, buildVisualBaseline, compareVisualSnapshot } from '../src/visual-regression.js';

test('buildHtmlVisualSnapshot records stable rendered structure and markers', () => {
  const snapshot = buildHtmlVisualSnapshot(`<!doctype html>
<html>
  <head><title>Campaign Home</title><link rel="stylesheet" href="/style.css"></head>
  <body>
    <span data-hts-storyblok-source="storyblok-draft" data-hts-storyblok-slug="acme-campaign-v1/home" hidden></span>
    <main class="hts-acme-campaign-v1-root" data-integration="acme-campaign-v1">
      <h1>Launch faster</h1>
      <h2>Safe imports</h2>
      <img src="/hero.svg" alt="Hero">
      <a href="/contact">Contact</a>
    </main>
  </body>
</html>`, {
    site: 'astro',
    route: '/'
  });

  assert.equal(snapshot.status, 'passed');
  assert.equal(snapshot.key, 'astro /');
  assert.equal(snapshot.signature.title, 'Campaign Home');
  assert.deepEqual(snapshot.signature.headings, ['Launch faster']);
  assert.equal(snapshot.signature.integration_root, 'acme-campaign-v1');
  assert.equal(snapshot.signature.storyblok_source, 'storyblok-draft');
  assert.equal(snapshot.signature.storyblok_slug, 'acme-campaign-v1/home');
  assert.equal(snapshot.signature.metrics.image_count, 1);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
});

test('compareVisualSnapshot detects rendered structure drift', () => {
  const original = buildHtmlVisualSnapshot('<!doctype html><html><body><main data-integration="acme-campaign-v1"><h1>Launch faster</h1><a href="/contact">Contact</a></main></body></html>', {
    site: 'astro',
    route: '/'
  });
  const changed = buildHtmlVisualSnapshot('<!doctype html><html><body><main data-integration="acme-campaign-v1"><h1>Launch safely</h1><a href="/pricing">Pricing</a></main></body></html>', {
    site: 'astro',
    route: '/'
  });
  const baseline = buildVisualBaseline([original]);
  const comparison = compareVisualSnapshot(changed, baseline.snapshots[changed.key]);

  assert.equal(comparison.status, 'failed');
  assert.ok(comparison.checks.some((check) => check.name === 'primary_headings' && check.status === 'failed'));
  assert.ok(comparison.checks.some((check) => check.name === 'link_targets' && check.status === 'failed'));
});
