import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
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
