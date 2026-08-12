import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { readIntegrationHistory, recordIntegrationHistory } from '../src/history.js';
import { createDefaultManifest } from '../src/policy.js';
import { pathExists } from '../src/utils.js';

test('integration history records multiple integrations with manifest snapshots', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-history-'));
  const first = createDefaultManifest({
    integrationId: 'acme-campaign-v1',
    repositoryNamespace: 'src/integrations/acme-campaign-v1'
  });
  const second = createDefaultManifest({
    integrationId: 'launchpad-saas-v1',
    repositoryNamespace: 'src/integrations/launchpad-saas-v1'
  });

  const firstEntry = await recordIntegrationHistory(workDir, {
    manifest: first,
    action: 'plan',
    status: 'planned',
    validation: first.validation
  });
  const secondEntry = await recordIntegrationHistory(workDir, {
    manifest: second,
    action: 'apply',
    status: 'complete',
    repoPath: '../demo-sites/astro',
    reportPath: path.join(workDir, 'report.md'),
    result: { action: 'apply_manifest', dry_run: false, steps: [{ name: 'Done', status: 'passed' }] }
  });
  const history = await readIntegrationHistory(workDir);

  assert.equal(history.total, 2);
  assert.equal(history.entries[0].integration_id, 'launchpad-saas-v1');
  assert.equal(history.entries[0].status, 'complete');
  assert.equal(history.entries[1].integration_id, 'acme-campaign-v1');
  assert.equal(await pathExists(path.join(workDir, firstEntry.manifest_snapshot)), true);
  assert.equal(await pathExists(path.join(workDir, secondEntry.manifest_snapshot)), true);
});

test('history command returns the import history ledger', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-history-cli-'));
  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'plan',
      '--integration-id',
      'acme-history-v1',
      '--template',
      'templates/acme-campaign',
      '--framework',
      'static',
      '--work-dir',
      workDir
    ]);
  });
  assert.match(output, /"integration_id": "acme-history-v1"/);

  const historyOutput = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'history',
      '--work-dir',
      workDir
    ]);
  });
  const history = JSON.parse(historyOutput);

  assert.equal(history.action, 'integration_history');
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].integration_id, 'acme-history-v1');
  assert.equal(history.entries[0].status, 'planned');
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
