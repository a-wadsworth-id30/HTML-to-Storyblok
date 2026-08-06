import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';

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
