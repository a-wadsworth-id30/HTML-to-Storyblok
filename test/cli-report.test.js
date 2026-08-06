import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { createIntegrationPlan } from '../src/planner.js';

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
      'hts_acme_v1_',
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
});

test('apply dry-run executes the import pipeline without copying template assets as repository duplicates', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_v1_',
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

  assert.equal(result.dry_run, true);
  assert.deepEqual(result.steps[0].repository_assets, []);
  assert.equal(result.steps[2].results.status, 'skipped');
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
