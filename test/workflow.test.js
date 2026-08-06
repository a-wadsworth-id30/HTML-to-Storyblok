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

test('applyManifest writes completed step artifacts before a later remote failure', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-workflow-partial-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-workflow-partial-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/components/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ components: [] });
    }
    if (href.endsWith('/components/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      return jsonResponse({
        component: {
          id: Math.floor(Math.random() * 1000) + 1,
          name: payload.component.name,
          display_name: payload.component.display_name,
          is_root: payload.component.is_root,
          is_nestable: payload.component.is_nestable,
          schema: payload.component.schema,
          preview_field: payload.component.preview_field
        }
      });
    }
    if (href.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ error: 'asset folder unavailable' }, { ok: false, status: 500 });
    }
    throw new Error(`unexpected request: ${href}`);
  };

  try {
    await assert.rejects(
      applyManifest(manifest, {
        repo: repoPath,
        template: 'test/fixtures/basic-template',
        framework: 'static',
        env: {
          STORYBLOK_MANAGEMENT_TOKEN: 'management-token',
          STORYBLOK_SPACE_ID: '12345',
          STORYBLOK_RETRY_LIMIT: '0'
        }
      }, workDir),
      /asset folder unavailable/
    );
    await stat(path.join(workDir, 'apply-step-04-storyblok-components.json'));
    await assert.rejects(
      stat(path.join(workDir, 'apply-step-05-storyblok-asset-folders.json')),
      /ENOENT/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: {
      get: () => null
    },
    text: async () => JSON.stringify(body)
  };
}
