import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReport, renderMarkdownReport } from '../src/reporter.js';
import { createRouteHandoffChecklist, renderRouteHandoffChecklistMarkdown } from '../src/route-handoff-checklist.js';
import { pathExists } from '../src/utils.js';

test('route handoff checklist marks generated Astro routes ready for reviewed automatic wiring', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-checklist-astro-'));
  const manifest = await createGeneratedManifest(repoPath, 'route-checklist-astro-v1', 'astro');
  await writePackageJson(repoPath, {
    dependencies: { astro: '^5.0.0' },
    scripts: { build: 'astro build', lint: 'eslint .', typecheck: 'astro check' }
  });

  const result = await createRouteHandoffChecklist(manifest, { repoPath, route: '/about' });

  assert.equal(result.status, 'ready');
  assert.equal(result.summary.ready_routes, 1);
  assert.equal(result.routes[0].handoff_mode, 'automatic_route_file');
  assert.ok(result.routes[0].checklist.some((item) => item.label === 'Run wire-routes dry run' && item.status === 'done'));
  assert.ok(result.acceptance_criteria.some((item) => item.includes('wire-routes dry run')));
  assert.match(renderRouteHandoffChecklistMarkdown(result), /Route Handoff Checklist/);
});

test('route handoff checklist gives manual React router steps without writing routes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-checklist-react-'));
  const manifest = await createGeneratedManifest(repoPath, 'route-checklist-react-v1', 'react');
  await writePackageJson(repoPath, {
    dependencies: { vite: '^7.0.0', react: '^19.0.0' },
    scripts: { build: 'vite build' }
  });

  const result = await createRouteHandoffChecklist(manifest, { repoPath, route: 'home' });

  assert.equal(result.status, 'manual_required');
  assert.equal(result.summary.manual_routes, 1);
  assert.equal(result.routes[0].handoff_mode, 'manual_host_router');
  assert.ok(result.routes[0].checklist.some((item) => /React routing layer/.test(item.label)));
  assert.equal(await pathExists(path.join(repoPath, 'src/pages/index.astro')), false);
});

test('route handoff checklist blocks when adapter evidence is missing', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-checklist-missing-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'route-checklist-missing-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'astro'
  });
  await writePackageJson(repoPath, {
    dependencies: { astro: '^5.0.0' },
    scripts: { build: 'astro build' }
  });

  const result = await createRouteHandoffChecklist(manifest, { repoPath });

  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.adapter_plan_available, false);
  assert.ok(result.next_steps.some((step) => step.includes('platform-readiness')));
});

test('route-checklist CLI writes markdown and report evidence', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-route-checklist-cli-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-route-checklist-cli-work-'));
  const manifest = await createGeneratedManifest(repoPath, 'route-checklist-cli-v1', 'astro');
  await writePackageJson(repoPath, {
    dependencies: { astro: '^5.0.0' },
    scripts: { build: 'astro build', lint: 'eslint .', typecheck: 'astro check' }
  });
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'route-checklist',
      '--manifest',
      manifestPath,
      '--repo',
      repoPath,
      '--route',
      '/about',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);

  assert.equal(result.action, 'route_handoff_checklist');
  assert.match(result.markdown_report, /route-handoff-checklist\.md$/);
  assert.equal(await pathExists(path.join(workDir, 'route-handoff-checklist.json')), true);
  assert.match(await readFile(result.markdown_report, 'utf8'), /Acceptance Criteria/);
  assert.equal(report.latest_route_handoff_checklist.status, 'ready');
  assert.match(markdown, /Latest route handoff checklist: ready/);
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

async function writePackageJson(repoPath, overrides) {
  await writeFile(path.join(repoPath, 'package.json'), `${JSON.stringify({
    name: 'hts-route-handoff-checklist-fixture',
    private: true,
    ...overrides
  }, null, 2)}\n`);
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
