import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { writeArtifact } from '../src/evidence.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReport, renderMarkdownReport } from '../src/reporter.js';

test('report summarizes manifest, validation, and command failure evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-'));
  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'plan',
      '--integration-id',
      'acme-homepage-v1',
      '--storyblok-prefix',
      'hts_acme_homepage_v1_',
      '--template',
      'test/fixtures/basic-template',
      '--framework',
      'static',
      '--work-dir',
      workDir
    ]);
  });
  assert.match(output, /acme-homepage-v1/);

  await assert.rejects(
    captureStdout(() => main(['node', 'html-to-storyblok', 'unknown-command', '--token', 'secret-token', '--work-dir', workDir])),
    /unknown command/
  );

  const reportOutput = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'report', '--work-dir', workDir]);
  });
  const report = JSON.parse(reportOutput);

  assert.equal(report.commands_completed >= 1, true);
  assert.equal(report.commands_failed.length, 1);
  assert.equal(report.latest_validation.status, 'passed');
  assert.ok(report.artifacts.some((artifact) => artifact.type === 'integration_manifest'));
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);

  const htmlReportOutput = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'report', '--html', '--work-dir', workDir]);
  });
  const htmlReport = JSON.parse(htmlReportOutput);
  assert.match(htmlReport.html_report, /report\.html$/);
  assert.match(await readFile(htmlReport.html_report, 'utf8'), /HTML-to-Storyblok Report/);
});

test('report surfaces skipped duplication diagnostics from the manifest', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-skips-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  manifest.duplication_inference = {
    enabled: true,
    repository_components: 0,
    repository_dependency_files: 0,
    repository_asset_files: 0,
    storyblok_components: 0,
    skipped_repository_candidates: [
      {
        source_path: 'src/components/Hero.jsx',
        confidence: 'medium',
        matched_signal: 'hero',
        blockers: ['local import could not be resolved from src/components/Hero.jsx: ../legacy/Button.jsx']
      }
    ]
  };
  await writeArtifact(workDir, 'integration-manifest.json', manifest);

  const report = await createReport(workDir);
  const manifestSummary = report.artifacts.find((artifact) => artifact.type === 'integration_manifest');
  const markdown = renderMarkdownReport(report);

  assert.equal(manifestSummary.duplication_inference.skipped_repository_candidates, 1);
  assert.equal(manifestSummary.duplication_inference.skipped_candidates[0].source_path, 'src/components/Hero.jsx');
  assert.match(markdown, /## Duplication Diagnostics/);
  assert.match(markdown, /local import could not be resolved/);
});

test('apply dry-run executes the import pipeline without copying template assets as repository duplicates', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'apply',
      '--manifest',
      manifestPath,
      '--repo',
      repoPath,
      '--template',
      'test/fixtures/basic-template',
      '--framework',
      'static',
      '--dry-run',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const duplicateStep = result.steps.find((step) => step.action === 'duplicate');
  const localValidationStep = result.steps.find((step) => step.action === 'local_validation');

  assert.equal(result.dry_run, true);
  assert.deepEqual(duplicateStep.repository_assets, []);
  assert.equal(localValidationStep.results.status, 'skipped');
});

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
