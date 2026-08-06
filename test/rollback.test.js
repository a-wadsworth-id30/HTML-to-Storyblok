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
    storyblokPrefix: 'hts_acme_v1_',
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
    storyblokPrefix: 'hts_acme_v1_',
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
