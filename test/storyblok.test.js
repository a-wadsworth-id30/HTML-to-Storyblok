import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDraftStories, createStoryblokAssetFolders, createStoryblokComponents, deleteStoryblokIntegrationResources, inspectStoryblokContentStory, uploadStoryblokAssets } from '../src/storyblok.js';

test('createStoryblokComponents treats matching existing components as idempotent', async () => {
  const calls = mockFetch((url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET');
    assert.match(url, /\/components\/(?:\?|$)/);
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
    if (String(url).includes('/components/') && (options.method || 'GET') === 'GET') {
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

test('createStoryblokComponents scans paginated component lists before creating', async () => {
  const targetComponent = {
    id: 999,
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
  };
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') {
        return {
          components: Array.from({ length: 100 }, (_entry, index) => ({
            id: index + 1,
            name: `existing_component_${index}`,
            is_nestable: true,
            schema: {}
          }))
        };
      }
      return { components: [targetComponent] };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokComponents({
    storyblok: {
      components_to_create: [
        {
          technical_name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          component_type: 'nestable',
          preview_field: 'headline',
          schema: targetComponent.schema
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'already_exists');
  assert.equal(calls.filter((call) => call.url.includes('/components/') && (call.options.method || 'GET') === 'GET').length, 2);
  assert.ok(!calls.some((call) => call.url.includes('/components/') && call.options.method === 'POST'));
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

test('createDraftStories hydrates draft asset fields from uploaded Storyblok assets', async () => {
  mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=')) {
      return { stories: [] };
    }
    if (url.includes('/stories?per_page=100')) {
      return { stories: [] };
    }
    if (url.endsWith('/stories') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.story.is_folder) {
        return {
          story: {
            id: 22,
            slug: 'acme-homepage-v1',
            full_slug: 'acme-homepage-v1',
            is_folder: true,
            parent_id: 0
          }
        };
      }
      const image = payload.story.content.body[0].image;
      assert.equal(payload.story.slug, 'home');
      assert.equal(payload.story.parent_id, 22);
      assert.equal(image.id, 88);
      assert.equal(image.filename, 'https://a.storyblok.com/f/123/acme-homepage-v1/hero.svg');
      assert.equal(image.alt, 'Hero from template');
      assert.equal(image.fieldtype, 'asset');
      return {
        story: {
          id: 457,
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          published_at: null,
          content: payload.story.content
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createDraftStories({
    storyblok: {
      assets_to_create: [
        {
          source_ref: './assets/hero.svg',
          local_path: '/tmp/hero.svg',
          filename: 'acme-homepage-v1/hero.svg',
          alt: 'Hero from manifest'
        }
      ],
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: [
              {
                component: 'hts_acme_homepage_v1_hero',
                image: {
                  id: null,
                  filename: './assets/hero.svg',
                  alt: 'Hero from template'
                }
              }
            ]
          }
        }
      ]
    }
  }, {
    env: storyblokEnv(),
    assetResults: [
      {
        action: 'upload_asset',
        status: 'created',
        filename: 'acme-homepage-v1/hero.svg',
        id: 88,
        verification: {
          id: 88,
          filename: 'https://a.storyblok.com/f/123/acme-homepage-v1/hero.svg',
          alt: 'Hero from upload'
        }
      }
    ]
  });

  assert.equal(result[0].status, 'created');
  restoreFetch();
});

test('createDraftStories creates one integration folder before imported draft stories', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fhome')) {
      return { stories: [] };
    }
    if (url.includes('/stories?per_page=100')) {
      return { stories: [] };
    }
    if (url.includes('/stories?by_slugs=acme-homepage-v1&per_page=1')) {
      return { stories: [] };
    }
    if (url.endsWith('/stories') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.story.is_folder) {
        assert.deepEqual(payload, {
          story: {
            is_folder: true,
            name: 'Acme Homepage V1',
            slug: 'acme-homepage-v1',
            parent_id: 0
          }
        });
        return {
          story: {
            id: 22,
            slug: 'acme-homepage-v1',
            full_slug: 'acme-homepage-v1',
            is_folder: true,
            parent_id: 0
          }
        };
      }
      assert.equal(payload.story.slug, 'home');
      assert.equal(payload.story.parent_id, 22);
      return {
        story: {
          id: 457,
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          parent_id: 22,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createDraftStories({
    storyblok: {
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          component: 'hts_acme_homepage_v1_template_page',
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: []
          }
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].slug, 'acme-homepage-v1/home');
  assert.equal(result[0].folder_results[0].status, 'created');
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 2);
  restoreFetch();
});

test('createDraftStories reuses one integration folder for multi-page draft stories', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fhome')) {
      return { stories: [] };
    }
    if (url.includes('/stories?per_page=100')) {
      return { stories: [] };
    }
    if (url.includes('/stories?by_slugs=acme-homepage-v1&per_page=1')) {
      return { stories: [] };
    }
    if (url.endsWith('/stories') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.story.is_folder && payload.story.slug === 'acme-homepage-v1') {
        assert.equal(payload.story.parent_id, 0);
        return {
          story: {
            id: 23,
            slug: 'acme-homepage-v1',
            full_slug: 'acme-homepage-v1',
            is_folder: true,
            parent_id: 0
          }
        };
      }
      assert.equal(payload.story.slug, 'home');
      assert.equal(payload.story.parent_id, 23);
      return {
        story: {
          id: 457,
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          parent_id: 23,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createDraftStories({
    storyblok: {
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          component: 'hts_acme_homepage_v1_template_page',
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: []
          }
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].slug, 'acme-homepage-v1/home');
  assert.deepEqual(result[0].folder_results.map((entry) => entry.slug), [
    'acme-homepage-v1'
  ]);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 2);
  restoreFetch();
});

test('createDraftStories hydrates generated internal links with Storyblok story UUIDs', async () => {
  let folderCreated = false;
  const putPayloads = [];
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fhome')) {
      return { stories: [] };
    }
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fabout')) {
      return { stories: [] };
    }
    if (url.includes('/stories?by_slugs=acme-homepage-v1&per_page=1')) {
      return {
        stories: folderCreated
          ? [{ id: 22, slug: 'acme-homepage-v1', full_slug: 'acme-homepage-v1', is_folder: true, parent_id: 0 }]
          : []
      };
    }
    if (url.includes('/stories?per_page=100')) {
      return {
        stories: folderCreated
          ? [{ id: 22, slug: 'acme-homepage-v1', full_slug: 'acme-homepage-v1', is_folder: true, parent_id: 0 }]
          : []
      };
    }
    if (url.endsWith('/stories') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.story.is_folder) {
        folderCreated = true;
        return {
          story: {
            id: 22,
            slug: 'acme-homepage-v1',
            full_slug: 'acme-homepage-v1',
            is_folder: true,
            parent_id: 0
          }
        };
      }
      if (payload.story.slug === 'home') {
        return {
          story: {
            id: 101,
            uuid: 'home-story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            parent_id: 22,
            published_at: null,
            content: payload.story.content
          }
        };
      }
      return {
        story: {
          id: 102,
          uuid: 'about-story-uuid',
          slug: 'about',
          full_slug: 'acme-homepage-v1/about',
          parent_id: 22,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    if (url.endsWith('/stories/101') && options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      putPayloads.push(payload);
      const link = payload.story.content.body[0].cta_link;
      assert.equal(link.id, 'about-story-uuid');
      assert.equal(link.cached_url, 'acme-homepage-v1/about');
      assert.equal(link.fieldtype, 'multilink');
      assert.equal(link.url, '');
      return {
        story: {
          id: 101,
          uuid: 'home-story-uuid',
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          parent_id: 22,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    if (url.endsWith('/stories/102') && options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      putPayloads.push(payload);
      const link = payload.story.content.body[0].cta_link;
      assert.equal(link.id, 'home-story-uuid');
      assert.equal(link.cached_url, 'acme-homepage-v1/home');
      assert.equal(link.fieldtype, 'multilink');
      assert.equal(link.url, '');
      return {
        story: {
          id: 102,
          uuid: 'about-story-uuid',
          slug: 'about',
          full_slug: 'acme-homepage-v1/about',
          parent_id: 22,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createDraftStories({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          component: 'hts_acme_homepage_v1_template_page',
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: [
              {
                component: 'hts_acme_homepage_v1_hero',
                cta_link: {
                  linktype: 'story',
                  cached_url: 'acme-homepage-v1/about'
                }
              }
            ]
          }
        },
        {
          slug: 'acme-homepage-v1/about',
          component: 'hts_acme_homepage_v1_template_page',
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: [
              {
                component: 'hts_acme_homepage_v1_hero',
                cta_link: {
                  linktype: 'story',
                  cached_url: 'acme-homepage-v1/home'
                }
              }
            ]
          }
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.deepEqual(result.map((entry) => entry.link_resolution), ['story_uuid_hydrated', 'story_uuid_hydrated']);
  assert.equal(putPayloads.length, 2);
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 2);
  restoreFetch();
});

test('createDraftStories repairs existing integration draft links that only have cached_url', async () => {
  const homeContent = {
    component: 'hts_acme_homepage_v1_template_page',
    body: [
      {
        component: 'hts_acme_homepage_v1_hero',
        cta_link: {
          linktype: 'story',
          cached_url: 'acme-homepage-v1/about'
        }
      }
    ]
  };
  const aboutContent = {
    component: 'hts_acme_homepage_v1_template_page',
    body: []
  };
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fhome')) {
      return {
        stories: [
          {
            id: 101,
            uuid: 'home-story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            parent_id: 22,
            published_at: null,
            content: homeContent
          }
        ]
      };
    }
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fabout')) {
      return {
        stories: [
          {
            id: 102,
            uuid: 'about-story-uuid',
            slug: 'about',
            full_slug: 'acme-homepage-v1/about',
            parent_id: 22,
            published_at: null,
            content: aboutContent
          }
        ]
      };
    }
    if (url.endsWith('/stories/101') && options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.story.content.body[0].cta_link.id, 'about-story-uuid');
      assert.equal(payload.story.content.body[0].cta_link.fieldtype, 'multilink');
      return {
        story: {
          id: 101,
          uuid: 'home-story-uuid',
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          parent_id: 22,
          published_at: null,
          content: payload.story.content
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createDraftStories({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          component: 'hts_acme_homepage_v1_template_page',
          content: homeContent
        },
        {
          slug: 'acme-homepage-v1/about',
          component: 'hts_acme_homepage_v1_template_page',
          content: aboutContent
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'updated_link_metadata');
  assert.equal(result[0].link_resolution, 'story_uuid_hydrated');
  assert.equal(result[1].status, 'already_exists');
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
  restoreFetch();
});

test('createStoryblokAssetFolders creates only missing namespaced folders', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
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
    if (url.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
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

test('uploadStoryblokAssets ignores basename-only asset collisions outside the integration folder', async () => {
  const assetRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-storyblok-asset-collision-'));
  const assetPath = path.join(assetRoot, 'logo.svg');
  await writeFile(assetPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return {
        asset_folders: [
          {
            id: 77,
            name: 'acme-homepage-v1',
            parent_id: 0
          }
        ]
      };
    }
    if (url.includes('/assets?search=')) {
      return {
        assets: [
          {
            id: 66,
            filename: 'https://a.storyblok.com/f/space/shared-assets/logo.svg',
            short_filename: 'logo.svg',
            asset_folder_id: 44
          }
        ]
      };
    }
    if (url.endsWith('/assets/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.asset_folder_id, 77);
      assert.equal(payload.filename, 'acme-homepage-v1/logo.svg');
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
          filename: 'https://a.storyblok.com/f/space/acme-homepage-v1/logo.svg',
          short_filename: 'logo.svg',
          asset_folder_id: 77
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
          filename: 'acme-homepage-v1/logo.svg',
          asset_folder_path: 'acme-homepage-v1'
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.ok(calls.some((call) => call.url.endsWith('/assets/') && call.options.method === 'POST'));
  assert.ok(!calls.some((call) => call.url.endsWith('/assets/66/finish_upload')));
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
    if (url.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
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
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') {
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

test('deleteStoryblokIntegrationResources deletes integration-owned story folders after route stories', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=acme-homepage-v1%2Fhome')) {
      return {
        stories: [
          {
            id: 11,
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            published_at: null,
            content: {
              component: 'hts_acme_homepage_v1_template_page'
            }
          }
        ]
      };
    }
    if (url.endsWith('/stories/11') && options.method === 'DELETE') return { story: { id: 11 } };
    if (url.includes('/stories?per_page=100')) {
      return {
        stories: [
          {
            id: 23,
            slug: 'acme-homepage-v1',
            full_slug: 'acme-homepage-v1',
            is_folder: true,
            parent_id: 0
          }
        ]
      };
    }
    if (url.endsWith('/stories/23') && options.method === 'DELETE') return { story: { id: 23 } };
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') return { components: [] };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await deleteStoryblokIntegrationResources({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        { slug: 'acme-homepage-v1/home' }
      ]
    }
  }, {
    env: storyblokEnv(),
    confirmIntegrationId: 'acme-homepage-v1',
    confirmRemoteDelete: true
  });

  assert.equal(result.stories[0].status, 'deleted');
  assert.equal(result.story_folders[0].status, 'deleted');
  assert.equal(result.story_folders[0].slug, 'acme-homepage-v1');
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
