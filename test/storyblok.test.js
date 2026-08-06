import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDraftStories, createStoryblokAssetFolders, createStoryblokComponents, deleteStoryblokIntegrationResources, inspectStoryblokContentStory, uploadStoryblokAssets } from '../src/storyblok.js';

test('createStoryblokComponents treats matching existing components as idempotent', async () => {
  const calls = mockFetch((url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET');
    assert.match(url, /\/components\/$/);
    return {
      components: [
        {
          id: 123,
          name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          is_root: false,
          is_nestable: true,
          preview_field: 'headline',
          schema: {
            headline: {
              type: 'text',
              translatable: true,
              description: 'Section headline'
            }
          }
        }
      ]
    };
  });

  const result = await createStoryblokComponents({
    storyblok: {
      components_to_create: [
        {
          technical_name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          component_type: 'nestable',
          preview_field: 'headline',
          schema: {
            headline: {
              type: 'text',
              translatable: true,
              description: 'Section headline'
            }
          }
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'already_exists');
  assert.equal(calls.length, 1);
  restoreFetch();
});

test('createStoryblokComponents retries Storyblok Management API rate limits', async () => {
  originalFetch = global.fetch;
  const calls = [];
  let postAttempts = 0;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/components/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ components: [] });
    }
    if (String(url).endsWith('/components/') && options.method === 'POST') {
      postAttempts += 1;
      if (postAttempts === 1) {
        return jsonResponse({ error: 'Rate limit of 6 request per second reached. Retry later.' }, {
          ok: false,
          status: 429,
          headers: { 'retry-after': '0' }
        });
      }
      return jsonResponse({
        component: {
          id: 124,
          name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          is_nestable: true,
          schema: {
            headline: {
              type: 'text',
              translatable: true,
              description: 'Section headline'
            }
          }
        }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await createStoryblokComponents({
    storyblok: {
      components_to_create: [
        {
          technical_name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          component_type: 'nestable',
          schema: {
            headline: {
              type: 'text',
              translatable: true,
              description: 'Section headline'
            }
          }
        }
      ]
    }
  }, { env: { ...storyblokEnv(), STORYBLOK_RETRY_BASE_MS: '0' } });

  assert.equal(result[0].status, 'created');
  assert.equal(postAttempts, 2);
  assert.equal(calls.length, 3);
  restoreFetch();
});

test('createDraftStories treats matching draft stories as idempotent', async () => {
  const content = {
    component: 'hts_acme_homepage_v1_template_page',
    body: []
  };
  mockFetch((url) => {
    assert.match(url, /\/stories\?by_slugs=/);
    return {
      stories: [
        {
          id: 456,
          slug: 'integration-preview/acme-homepage-v1',
          full_slug: 'integration-preview/acme-homepage-v1',
          published_at: null,
          content
        }
      ]
    };
  });

  const result = await createDraftStories({
    storyblok: {
      stories_to_create: [
        {
          slug: 'integration-preview/acme-homepage-v1',
          component: 'hts_acme_homepage_v1_template_page',
          content
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'already_exists');
  assert.equal(result[0].published, false);
  restoreFetch();
});

test('createStoryblokAssetFolders creates only missing namespaced folders', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.endsWith('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return { asset_folders: [] };
    }
    if (url.endsWith('/asset_folders/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, {
        asset_folder: {
          name: 'acme-homepage-v1',
          parent_id: 0
        }
      });
      return {
        asset_folder: {
          id: 77,
          name: 'acme-homepage-v1',
          parent_id: 0
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokAssetFolders({
    integration_id: 'acme-homepage-v1',
    storyblok: {
      asset_folders_to_create: [
        { path: 'acme-homepage-v1', name: 'acme-homepage-v1', parent_id: 0 }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].id, 77);
  assert.equal(calls.length, 2);
  restoreFetch();
});

test('uploadStoryblokAssets resolves integration asset folders before signing uploads', async () => {
  const assetRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-storyblok-asset-'));
  const assetPath = path.join(assetRoot, 'hero.svg');
  await writeFile(assetPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  const calls = mockFetch((url, options = {}) => {
    if (url.endsWith('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return { asset_folders: [] };
    }
    if (url.endsWith('/asset_folders/') && options.method === 'POST') {
      return {
        asset_folder: {
          id: 77,
          name: 'acme-homepage-v1',
          parent_id: 0
        }
      };
    }
    if (url.includes('/assets?search=')) {
      return { assets: [] };
    }
    if (url.endsWith('/assets/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.asset_folder_id, 77);
      assert.equal(payload.filename, 'acme-homepage-v1/hero.svg');
      return {
        id: 88,
        post_url: 'https://storyblok-upload.example/upload',
        fields: {
          key: 'upload-key'
        }
      };
    }
    if (url === 'https://storyblok-upload.example/upload') {
      return {};
    }
    if (url.endsWith('/assets/88/finish_upload')) {
      return {
        asset: {
          id: 88,
          filename: 'https://a.storyblok.com/f/space/acme-homepage-v1/hero.svg',
          short_filename: 'hero.svg'
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await uploadStoryblokAssets({
    integration_id: 'acme-homepage-v1',
    storyblok: {
      asset_folders_to_create: [
        { path: 'acme-homepage-v1', name: 'acme-homepage-v1', parent_id: 0 }
      ],
      assets_to_create: [
        {
          local_path: assetPath,
          filename: 'acme-homepage-v1/hero.svg',
          asset_folder_path: 'acme-homepage-v1'
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].asset_folder_id, 77);
  assert.ok(calls.some((call) => call.url === 'https://storyblok-upload.example/upload'));
  restoreFetch();
});

test('inspectStoryblokContentStory reports Content API unavailability without a preview token', async () => {
  const result = await inspectStoryblokContentStory({
    slug: 'integration-preview/acme-homepage-v1',
    env: {}
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /STORYBLOK_PREVIEW_TOKEN/);
});

test('inspectStoryblokContentStory summarizes draft content without exposing token values', async () => {
  mockFetch((url) => {
    assert.match(url, /token=preview-token/);
    return {
      story: {
        id: 789,
        uuid: 'story-uuid',
        name: 'Preview',
        slug: 'acme-homepage-v1',
        full_slug: 'integration-preview/acme-homepage-v1',
        content: {
          component: 'hts_acme_homepage_v1_template_page'
        },
        published_at: null
      }
    };
  });

  const result = await inspectStoryblokContentStory({
    slug: 'integration-preview/acme-homepage-v1',
    env: {
      STORYBLOK_PREVIEW_TOKEN: 'preview-token'
    }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.story.root_component, 'hts_acme_homepage_v1_template_page');
  assert.doesNotMatch(JSON.stringify(result), /preview-token/);
  restoreFetch();
});

test('deleteStoryblokIntegrationResources deletes only verified namespaced draft resources', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=')) {
      return {
        stories: [
          {
            id: 11,
            slug: 'acme-homepage-v1',
            full_slug: 'integration-preview/acme-homepage-v1',
            published_at: null,
            content: {
              component: 'hts_acme_homepage_v1_template_page'
            }
          }
        ]
      };
    }
    if (url.endsWith('/stories/11') && options.method === 'DELETE') return { story: { id: 11 } };
    if (url.includes('/assets?search=')) {
      return {
        assets: [
          {
            id: 22,
            filename: 'https://a.storyblok.com/f/123/acme-homepage-v1/hero.svg',
            short_filename: 'hero.svg'
          }
        ]
      };
    }
    if (url.endsWith('/assets/22') && options.method === 'DELETE') return { asset: { id: 22 } };
    if (url.endsWith('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return {
        asset_folders: [
          {
            id: 33,
            name: 'acme-homepage-v1',
            parent_id: 0
          }
        ]
      };
    }
    if (url.endsWith('/asset_folders/33') && options.method === 'DELETE') return { asset_folder: { id: 33 } };
    if (url.endsWith('/components/') && (options.method || 'GET') === 'GET') {
      return {
        components: [
          {
            id: 44,
            name: 'hts_acme_homepage_v1_template_page',
            is_root: true
          },
          {
            id: 45,
            name: 'hts_acme_homepage_v1_hero',
            is_nestable: true
          }
        ]
      };
    }
    if (url.endsWith('/components/44') && options.method === 'DELETE') return { component: { id: 44 } };
    if (url.endsWith('/components/45') && options.method === 'DELETE') return { component: { id: 45 } };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await deleteStoryblokIntegrationResources(remoteRollbackManifest(), {
    env: storyblokEnv(),
    confirmIntegrationId: 'acme-homepage-v1',
    confirmRemoteDelete: true
  });

  assert.equal(result.stories[0].status, 'deleted');
  assert.equal(result.assets[0].status, 'deleted');
  assert.equal(result.asset_folders[0].status, 'deleted');
  assert.equal(result.components.length, 2);
  assert.ok(calls.some((call) => call.url.endsWith('/components/45') && call.options.method === 'DELETE'));
  restoreFetch();
});

test('deleteStoryblokIntegrationResources refuses published stories', async () => {
  mockFetch((url) => {
    if (url.includes('/stories?by_slugs=')) {
      return {
        stories: [
          {
            id: 11,
            slug: 'acme-homepage-v1',
            full_slug: 'integration-preview/acme-homepage-v1',
            published_at: '2026-08-06T10:00:00.000Z',
            content: {
              component: 'hts_acme_homepage_v1_template_page'
            }
          }
        ]
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  await assert.rejects(
    deleteStoryblokIntegrationResources(remoteRollbackManifest(), {
      env: storyblokEnv(),
      confirmIntegrationId: 'acme-homepage-v1',
      confirmRemoteDelete: true
    }),
    /published Storyblok story/
  );
  restoreFetch();
});

let originalFetch;

function mockFetch(handler) {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = handler(String(url), options);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body)
    };
  };
  return calls;
}

function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || null
    },
    text: async () => JSON.stringify(body)
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function storyblokEnv() {
  return {
    STORYBLOK_MANAGEMENT_TOKEN: 'management-token',
    STORYBLOK_SPACE_ID: '12345'
  };
}

function remoteRollbackManifest() {
  return {
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      components_to_create: [
        {
          technical_name: 'hts_acme_homepage_v1_template_page'
        },
        {
          technical_name: 'hts_acme_homepage_v1_hero'
        }
      ],
      stories_to_create: [
        {
          slug: 'integration-preview/acme-homepage-v1'
        }
      ],
      asset_folders_to_create: [
        {
          path: 'acme-homepage-v1',
          name: 'acme-homepage-v1',
          parent_id: 0
        }
      ],
      assets_to_create: [
        {
          filename: 'acme-homepage-v1/hero.svg'
        }
      ]
    }
  };
}
