import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { createIntegrationPlan } from '../src/planner.js';
import { generateIntegration } from '../src/generator.js';
import { analyzeRouteCollisions, renderRouteCollisionReport } from '../src/route-collision-analyzer.js';
import { pathExists } from '../src/utils.js';

test('analyzeRouteCollisions blocks exact existing Astro route files', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-collision-exact-'));
  const manifest = await createGeneratedManifest(repoPath, 'astro-exact-v1', 'astro');
  await mkdir(path.join(repoPath, 'src/pages/about'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/pages/about/index.astro'), '<p>Existing about route</p>\n');

  const result = await analyzeRouteCollisions(manifest, { repoPath, route: '/about' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.exact_route_file_collisions, 1);
  assert.equal(result.routes[0].status, 'blocked');
  assert.ok(result.routes[0].blockers.includes('existing_route_file_available'));
  assert.match(renderRouteCollisionReport(result), /Existing host route file/);
});

test('analyzeRouteCollisions blocks dynamic route overlaps before static route wiring', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-collision-dynamic-'));
  const manifest = await createGeneratedManifest(repoPath, 'astro-dynamic-v1', 'astro');
  await mkdir(path.join(repoPath, 'src/pages'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/pages/[slug].astro'), '<p>Existing dynamic route</p>\n');

  const result = await analyzeRouteCollisions(manifest, { repoPath, route: '/services' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.dynamic_route_overlaps, 1);
  assert.ok(result.routes[0].blockers.includes('dynamic_route_overlap'));
});

test('analyzeRouteCollisions warns about Netlify rewrite overlaps without blocking local writes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-collision-netlify-'));
  const manifest = await createGeneratedManifest(repoPath, 'next-rewrite-v1', 'next');
  await writeFile(path.join(repoPath, 'netlify.toml'), `[[redirects]]
from = "/services"
to = "/legacy-services"
status = 301
`);

  const result = await analyzeRouteCollisions(manifest, { repoPath, route: '/services' });

  assert.equal(result.status, 'warning');
  assert.equal(result.summary.rewrite_overlaps, 1);
  assert.equal(result.routes[0].status, 'warning');
  assert.ok(result.routes[0].warnings.includes('netlify_rewrite_overlap'));
});

test('route-collisions CLI command writes readable markdown evidence', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-collision-cli-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-route-collision-cli-work-'));
  const manifest = await createGeneratedManifest(repoPath, 'route-cli-v1', 'astro');
  await writeFile(path.join(workDir, 'integration-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'route-collisions',
      '--manifest',
      path.join(workDir, 'integration-manifest.json'),
      '--repo',
      repoPath,
      '--route',
      '/about',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);

  assert.equal(result.action, 'analyze_route_collisions');
  assert.equal(result.status, 'passed');
  assert.match(result.markdown_report, /route-collision-analysis-report\.md$/);
  assert.equal(await pathExists(path.join(workDir, 'route-collision-analysis.json')), true);
  const report = await readFile(result.markdown_report, 'utf8');
  assert.match(report, /Route Collision And Rewrite Analysis/);
  assert.match(report, /Routes checked: 1/);
});

async function createGeneratedManifest(repoPath, integrationId, framework) {
  const manifest = await createIntegrationPlan({
    integrationId,
    templatePath: 'templates/acme-campaign',
    framework
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework
  });
  return manifest;
}

async function captureStdout(callback) {
  const originalLog = console.log;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return output.trim();
}
