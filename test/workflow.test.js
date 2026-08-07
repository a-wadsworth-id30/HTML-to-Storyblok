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
    if (href.endsWith('/spaces/12345')) {
      return jsonResponse({ space: { id: 12345, name: 'Demo' } });
    }
    if (href.includes('/component_groups/?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ component_groups: [] });
    }
    if (href.includes('/internal_tags/?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ internal_tags: [] });
    }
    if (href.includes('/presets/?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ presets: [] });
    }
    if (href.includes('/component_groups/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ component_groups: [] });
    }
    if (href.endsWith('/component_groups/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      return jsonResponse({
        component_group: {
          id: 55,
          uuid: 'component-folder-uuid',
          name: payload.component_group.name,
          parent_id: payload.component_group.parent_id || 0
        }
      });
    }
    if (href.includes('/internal_tags/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ internal_tags: [] });
    }
    if (href.endsWith('/internal_tags/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      return jsonResponse({
        internal_tag: {
          id: 56,
          name: payload.internal_tag.name,
          object_type: payload.internal_tag.object_type
        }
      });
    }
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
    if (href.includes('/stories?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ stories: [] });
    }
    if (href.includes('/asset_folders/?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ asset_folders: [] });
    }
    if (href.includes('/assets?per_page=1') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ assets: [] });
    }
    if (href.endsWith('/asset_folders/') && options.method === 'POST') {
      return jsonResponse({ error: 'asset folder unavailable' }, { ok: false, status: 500 });
    }
    if (href.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ asset_folders: [] });
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
    await stat(path.join(workDir, 'apply-step-06-storyblok-components.json'));
    await assert.rejects(
      stat(path.join(workDir, 'apply-step-07-storyblok-asset-folders.json')),
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
