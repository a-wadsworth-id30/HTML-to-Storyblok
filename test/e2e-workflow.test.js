import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';

test('CLI runs the safe local import workflow from plan through rollback', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-e2e-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-e2e-work-'));
  const templatePath = 'test/fixtures/basic-template';
  const manifestPath = path.join(workDir, 'integration-manifest.json');

  const planOutput = await captureStdout(() => runCli([
    'plan',
    '--integration-id',
    'acme-homepage-v1',
    '--storyblok-prefix',
    'hts_acme_homepage_v1_',
    '--template',
    templatePath,
    '--framework',
    'static',
    '--work-dir',
    workDir
  ]));
  const manifest = JSON.parse(planOutput);

  assert.equal(manifest.integration_id, 'acme-homepage-v1');
  assert.equal(manifest.validation.valid, true);
  assert.equal(manifest.repository_namespace, 'src/integrations/acme-homepage-v1');
  assert.ok(manifest.storyblok.components_to_create.length > 0);
  assert.ok(manifest.storyblok.stories_to_create.some((story) => story.slug === 'acme-homepage-v1/home'));
  assert.ok(manifest.storyblok.assets_to_create.some((asset) => asset.filename === 'acme-homepage-v1/hero.svg'));

  const planValidationOutput = await captureStdout(() => runCli([
    'validate-plan',
    '--manifest',
    manifestPath,
    '--work-dir',
    workDir
  ]));
  const planValidation = JSON.parse(planValidationOutput);
  assert.equal(planValidation.valid, true);

  const summaryValidationOutput = await captureStdout(() => runCli([
    'validate-plan',
    '--manifest',
    manifestPath,
    '--json-summary',
    '--work-dir',
    workDir
  ]));
  const summaryValidation = JSON.parse(summaryValidationOutput);
  assert.equal(summaryValidation.command, 'validate-plan');
  assert.equal(summaryValidation.status, 'passed');
  assert.equal(summaryValidation.plan_valid, true);

  const warningValidationOutput = await captureStdout(() => runCli([
    'validate-plan',
    '--manifest',
    manifestPath,
    '--severity',
    'warning',
    '--work-dir',
    workDir
  ]));
  const warningValidation = JSON.parse(warningValidationOutput);
  assert.equal(warningValidation.severity_filter, 'warning');
  assert.equal(warningValidation.violation_counts.warning, 0);

  const examplesOutput = await captureStdout(() => runCli([
    'examples',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--template',
    templatePath,
    '--work-dir',
    workDir
  ]));
  const examples = JSON.parse(examplesOutput);
  assert.equal(examples.action, 'command_examples');
  assert.ok(examples.examples.some((example) => example.includes('storyblok-apply')));

  const dryRunApplyOutput = await captureStdout(() => runCli([
    'apply',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--template',
    templatePath,
    '--framework',
    'static',
    '--dry-run',
    '--work-dir',
    workDir
  ]));
  const dryRunApply = JSON.parse(dryRunApplyOutput);
  assert.equal(dryRunApply.dry_run, true);
  assert.equal(dryRunApply.steps.find((step) => step.action === 'local_validation').results.status, 'skipped');
  assert.ok(dryRunApply.steps.find((step) => step.action === 'storyblok_components').results.length > 0);
  assert.ok(dryRunApply.steps.find((step) => step.action === 'storyblok_assets').results.length > 0);
  assert.ok(dryRunApply.steps.find((step) => step.action === 'storyblok_draft_stories').results.length > 0);

  const generateOutput = await captureStdout(() => runCli([
    'generate',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--template',
    templatePath,
    '--framework',
    'static',
    '--work-dir',
    workDir
  ]));
  const generate = JSON.parse(generateOutput);
  assert.equal(generate.dry_run, false);
  assert.ok(generate.files.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(generate.assets.includes('src/integrations/acme-homepage-v1/assets/hero.svg'));

  const generatedHtml = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'utf8');
  const generatedCss = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/styles/template.css'), 'utf8');
  assert.match(generatedHtml, /class="hts-acme-homepage-v1-root"/);
  assert.doesNotMatch(generatedHtml, /onclick|example\.com\/tracker/);
  assert.match(generatedCss, /\.hts-acme-homepage-v1-root \.hts-acme-homepage-v1-site-header/);
  assert.doesNotMatch(generatedCss, /\.site-header\s*{/);

  const validationOutput = await captureStdout(() => runCli([
    'validate',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--work-dir',
    workDir
  ]));
  const validation = JSON.parse(validationOutput);
  assert.equal(validation.status, 'passed');

  const reportOutput = await captureStdout(() => runCli([
    'report',
    '--work-dir',
    workDir
  ]));
  const report = JSON.parse(reportOutput);
  assert.equal(report.commands_failed.length, 0);
  assert.equal(report.safety_confirmation.plan_valid, true);
  assert.ok(report.artifacts.some((artifact) => artifact.type === 'integration_manifest'));
  assert.ok(report.artifacts.some((artifact) => artifact.type === 'integration_validation'));

  const rollbackPreviewOutput = await captureStdout(() => runCli([
    'rollback-preview',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--work-dir',
    workDir
  ]));
  const rollbackPreview = JSON.parse(rollbackPreviewOutput);
  assert.equal(rollbackPreview.policy, 'manual_confirmation_required');
  assert.ok(rollbackPreview.repository_files_to_remove.every((entry) => entry.owned_by_integration));

  const rollbackOutput = await captureStdout(() => runCli([
    'rollback',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--confirm-integration-id',
    'acme-homepage-v1',
    '--work-dir',
    workDir
  ]));
  const rollback = JSON.parse(rollbackOutput);
  assert.equal(rollback.integration_id, 'acme-homepage-v1');
  assert.ok(rollback.repository_files_removed.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(rollback.repository_files_removed.includes('src/integrations/acme-homepage-v1/assets/hero.svg'));
  assert.equal(rollback.remote_resources_not_removed.reason.includes('--remote --confirm-remote-delete'), true);
});

async function runCli(args) {
  process.exitCode = undefined;
  await main(['node', 'html-to-storyblok', ...args]);
  assert.equal(process.exitCode, undefined);
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
