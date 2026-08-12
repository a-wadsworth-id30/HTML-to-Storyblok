import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createPlatformReadiness, renderPlatformReadinessMarkdown } from '../src/platform-readiness.js';
import { createReport, renderMarkdownReport } from '../src/reporter.js';
import { pathExists } from '../src/utils.js';

test('platform readiness verifies generated Astro adapter and route proposal evidence', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-astro-'));
  const manifest = await createGeneratedManifest(repoPath, 'platform-astro-v1', 'astro');
  await writePackageJson(repoPath, {
    dependencies: { astro: '^5.0.0' },
    scripts: {
      build: 'astro build',
      lint: 'eslint .',
      typecheck: 'astro check'
    }
  });

  const result = await createPlatformReadiness(manifest, { repoPath });

  assert.equal(result.framework, 'astro');
  assert.equal(result.automatic_route_handoff_supported, true);
  assert.equal(result.manual_route_handoff_required, false);
  assert.equal(result.summary.failed_checks, 0);
  assert.equal(result.summary.routes, 5);
  assert.equal(result.summary.route_previews_available, 5);
  assert.equal(result.summary.route_proposals_available, 5);
  assert.ok(result.next_steps.some((step) => step.includes('wire-routes')));
  assert.match(renderPlatformReadinessMarkdown(result), /Platform Readiness Report/);
});

test('platform readiness reports manual host-router handoff for React projects', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-react-'));
  const manifest = await createGeneratedManifest(repoPath, 'platform-react-v1', 'react');
  await writePackageJson(repoPath, {
    dependencies: { vite: '^7.0.0', react: '^19.0.0' },
    scripts: {
      build: 'vite build'
    }
  });

  const result = await createPlatformReadiness(manifest, { repoPath });

  assert.equal(result.framework, 'react');
  assert.equal(result.status, 'warning');
  assert.equal(result.automatic_route_handoff_supported, false);
  assert.equal(result.manual_route_handoff_required, true);
  assert.ok(result.routes.every((route) => route.handoff_mode === 'manual_host_router'));
  assert.ok(result.next_steps.some((step) => step.includes('host react router manually')));
});

test('platform readiness can require automatic route handoff for CI gates', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-react-required-'));
  const manifest = await createGeneratedManifest(repoPath, 'platform-react-required-v1', 'react');
  await writePackageJson(repoPath, {
    dependencies: { vite: '^7.0.0', react: '^19.0.0' },
    scripts: { build: 'vite build' }
  });

  const result = await createPlatformReadiness(manifest, {
    repoPath,
    requireAutomaticRoutes: true
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.failed_checks, 1);
  assert.ok(result.checks.some((check) => check.name === 'framework_handoff_mode' && check.status === 'failed'));
});

test('platform readiness blocks when generated adapter plan is missing', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-missing-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'platform-missing-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'astro'
  });
  await writePackageJson(repoPath, {
    dependencies: { astro: '^5.0.0' },
    scripts: { build: 'astro build' }
  });

  const result = await createPlatformReadiness(manifest, { repoPath });

  assert.equal(result.status, 'blocked');
  assert.ok(result.checks.some((check) => check.name === 'adapter_plan_available' && check.status === 'failed'));
  assert.ok(result.next_steps[0].includes('generate'));
});

test('platform-readiness CLI writes markdown and report evidence', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-cli-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-platform-cli-work-'));
  const manifest = await createGeneratedManifest(repoPath, 'platform-cli-v1', 'astro');
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
      'platform-readiness',
      '--manifest',
      manifestPath,
      '--repo',
      repoPath,
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);

  assert.equal(result.action, 'platform_readiness');
  assert.match(result.markdown_report, /platform-readiness-report\.md$/);
  assert.equal(await pathExists(path.join(workDir, 'platform-readiness.json')), true);
  assert.match(await readFile(result.markdown_report, 'utf8'), /Platform Readiness Report/);
  assert.equal(report.latest_platform_readiness.framework, 'astro');
  assert.match(markdown, /Latest platform readiness/);
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
    name: 'hts-platform-readiness-fixture',
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
