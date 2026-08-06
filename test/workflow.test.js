import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIntegrationPlan } from '../src/planner.js';
import { applyManifest } from '../src/workflow.js';

test('applyManifest preflights Storyblok credentials before writing local files', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-workflow-preflight-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-workflow-preflight-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await assert.rejects(
    applyManifest(manifest, {
      repo: repoPath,
      template: 'test/fixtures/basic-template',
      framework: 'static',
      env: {}
    }, workDir),
    /refusing to apply before local files are written/
  );

  await assert.rejects(
    stat(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html')),
    /ENOENT/
  );
});
