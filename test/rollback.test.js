import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createRollbackPreview, rollbackIntegration } from '../src/rollback.js';

test('rollbackPreview lists only integration-owned repository paths for removal', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const preview = createRollbackPreview(manifest);

  assert.equal(preview.policy, 'manual_confirmation_required');
  assert.ok(preview.repository_files_to_remove.length > 0);
  assert.ok(preview.repository_files_to_remove.every((entry) => entry.owned_by_integration));
  assert.equal(preview.rollback_ledger.action, 'rollback_ledger');
  assert.equal(preview.rollback_ledger.phase, 'preview');
  assert.equal(preview.rollback_ledger.local.targets, preview.repository_files_to_remove.length);
  assert.ok(preview.rollback_ledger.remote.total_targets > 0);
  assert.ok(preview.rollback_ledger.risk_flags.includes('remote_resources_not_requested'));
});

test('rollbackIntegration removes generated local files only after integration confirmation', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-rollback-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await assert.rejects(
    rollbackIntegration(manifest, { repoPath, confirmIntegrationId: 'wrong-id' }),
    /confirm-integration-id/
  );

  const result = await rollbackIntegration(manifest, {
    repoPath,
    confirmIntegrationId: 'acme-homepage-v1'
  });

  assert.ok(result.repository_files_removed.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.deepEqual(await readdir(repoPath), ['src']);
  assert.ok(result.remote_resources_not_removed.storyblok_components.length > 0);
  assert.equal(result.rollback_ledger.phase, 'rollback');
  assert.equal(result.rollback_ledger.confirmation.integration_id_confirmed, true);
  assert.equal(result.rollback_ledger.local.removed.length, result.repository_files_removed.length);
  assert.equal(result.rollback_ledger.local.hash_verification.status, 'passed');
});

test('rollbackIntegration prunes multi-page route preview directories', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-rollback-routes-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });

  const preview = createRollbackPreview(manifest, { repoPath });

  assert.ok(preview.empty_directories_to_prune.includes('src/integrations/acme-campaign-v1/routes/home'));
  assert.ok(preview.empty_directories_to_prune.includes('src/integrations/acme-campaign-v1/routes'));

  const result = await rollbackIntegration(manifest, {
    repoPath,
    confirmIntegrationId: 'acme-campaign-v1'
  });

  assert.ok(result.directories_pruned.includes('src/integrations/acme-campaign-v1/routes/home'));
  assert.ok(result.directories_pruned.includes('src/integrations/acme-campaign-v1/routes'));
  assert.deepEqual(await readdir(repoPath), ['src']);
});

test('rollbackIntegration refuses modified generated files when hash ledger detects drift', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-rollback-drift-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-drift-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await writeFile(path.join(repoPath, 'src/integrations/acme-drift-v1/template.html'), '<main>edited after generation</main>\n');

  await assert.rejects(
    rollbackIntegration(manifest, {
      repoPath,
      confirmIntegrationId: 'acme-drift-v1'
    }),
    /generated files were modified/
  );

  const result = await rollbackIntegration(manifest, {
    repoPath,
    confirmIntegrationId: 'acme-drift-v1',
    allowModifiedGeneratedFiles: true
  });

  assert.equal(result.repository_file_hash_verification.status, 'failed');
  assert.ok(result.repository_files_removed.includes('src/integrations/acme-drift-v1/template.html'));
  assert.ok(result.rollback_ledger.risk_flags.includes('generated_file_drift_detected'));
});
