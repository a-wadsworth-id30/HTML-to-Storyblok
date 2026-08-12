import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClientApplyReviewGate, renderClientApplyReviewGateMarkdown } from '../src/client-review-gate.js';
import { main } from '../src/cli.js';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReport } from '../src/reporter.js';

test('client apply review gate records safe repository evidence before generation', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-client-review-safe-'));
  await writePackage(repoPath, { build: 'node --version' });
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const gate = await createClientApplyReviewGate(manifest, {
    repoPath,
    hostChecks: ['lint', 'typecheck', 'build']
  });
  const markdown = renderClientApplyReviewGateMarkdown(gate);

  assert.equal(gate.ready_for_apply, true);
  assert.equal(gate.status, 'warning');
  assert.ok(gate.checks.some((check) => check.name === 'planned_writes_isolated' && check.status === 'passed'));
  assert.ok(gate.checks.some((check) => check.name === 'route_handoff_review' && check.status === 'warning'));
  assert.equal(gate.host_scripts.find((script) => script.script === 'build').command, 'npm run build');
  assert.match(markdown, /Client Apply Review Gate/);
});

test('client apply review gate previews additive route handoff after generation', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-client-review-routes-'));
  await writePackage(repoPath, { build: 'node --version' });
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'astro'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework: 'astro'
  });

  const gate = await createClientApplyReviewGate(manifest, {
    repoPath,
    hostChecks: ['build']
  });

  assert.equal(gate.route_handoff_preview.status, 'passed');
  assert.equal(gate.route_handoff_preview.summary.would_create, 5);
  assert.equal(gate.ready_for_route_handoff, true);
  assert.ok(gate.checks.some((check) => check.name === 'host_routes_preserved' && check.status === 'passed'));
});

test('client apply review gate fails planned target collisions in apply mode', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-client-review-collision-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'existing file\n');

  const gate = await createClientApplyReviewGate(manifest, { repoPath });

  assert.equal(gate.status, 'failed');
  assert.equal(gate.ready_for_apply, false);
  assert.ok(gate.checks.some((check) => check.name === 'repository_preflight' && check.status === 'failed'));
});

test('client-review CLI writes markdown evidence and report summarizes it', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-client-review-cli-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-client-review-cli-work-'));
  await writePackage(repoPath, { build: 'node --version' });
  await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'plan',
      '--integration-id',
      'acme-client-review-v1',
      '--template',
      'test/fixtures/basic-template',
      '--framework',
      'static',
      '--repo',
      repoPath,
      '--work-dir',
      workDir
    ]);
  });

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'apply-review',
      '--manifest',
      path.join(workDir, 'integration-manifest.json'),
      '--repo',
      repoPath,
      '--host-checks',
      'build',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const markdown = await readFile(path.join(workDir, 'client-review-gate-report.md'), 'utf8');
  const report = await createReport(workDir);

  assert.equal(result.action, 'client_apply_review_gate');
  assert.equal(result.ready_for_apply, true);
  assert.match(markdown, /Host Script Discovery/);
  assert.equal(report.latest_client_review_gate.type, 'client_review_gate');
  assert.equal(report.safety_confirmation.client_review_ready, true);
});

async function writePackage(repoPath, scripts) {
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    type: 'module',
    scripts
  }, null, 2));
  await writeFile(path.join(repoPath, 'package-lock.json'), '');
}

async function captureStdout(callback) {
  const originalLog = console.log;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    await callback();
    return output;
  } finally {
    console.log = originalLog;
  }
}
