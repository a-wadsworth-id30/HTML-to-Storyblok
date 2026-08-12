import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectStoryblokActivityEvidence, createDraftStories, createStoryblokAssetFolders, createStoryblokComponentGroups, createStoryblokComponents, createStoryblokInternalTags, createStoryblokPresets, createStoryblokStateCache, deleteStoryblokIntegrationResources, inspectStoryblokContentStory, inspectStoryblokSpace, preflightStoryblokIntegration, reconcileStoryblokManifest, uploadStoryblokAssets, validateStoryblokDraftContent, verifyStoryblokManagementState } from '../src/storyblok.js';

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

test('createStoryblokComponentGroups creates and reuses namespaced component folders', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/component_groups/') && (options.method || 'GET') === 'GET') {
      return { component_groups: [] };
    }
    if (url.endsWith('/component_groups/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, {
        component_group: {
          name: 'acme-homepage-v1'
        }
      });
      return {
        component_group: {
          id: 55,
          uuid: 'component-folder-uuid',
          name: 'acme-homepage-v1',
          parent_id: 0
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokComponentGroups({
    storyblok: {
      component_groups_to_create: [
        { path: 'acme-homepage-v1', name: 'acme-homepage-v1', parent_id: 0 }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].uuid, 'component-folder-uuid');
  assert.equal(calls.length, 2);
  restoreFetch();
});

test('createStoryblokComponents assigns resolved component folder UUIDs', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/component_groups/') && (options.method || 'GET') === 'GET') {
      return {
        component_groups: [
          {
            id: 55,
            uuid: 'component-folder-uuid',
            name: 'acme-homepage-v1',
            parent_id: 0
          }
        ]
      };
    }
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') {
      return { components: [] };
    }
    if (url.endsWith('/components/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.component.component_group_uuid, 'component-folder-uuid');
      return {
        component: {
          id: 124,
          name: payload.component.name,
          display_name: payload.component.display_name,
          is_root: payload.component.is_root,
          is_nestable: payload.component.is_nestable,
          component_group_uuid: payload.component.component_group_uuid,
          schema: payload.component.schema,
          preview_field: payload.component.preview_field
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokComponents({
    storyblok: {
      component_groups_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }],
      components_to_create: [
        {
          technical_name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          component_type: 'nestable',
          component_group_path: 'acme-homepage-v1',
          schema: {
            headline: {
              type: 'text'
            }
          }
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.ok(calls.some((call) => call.url.includes('/component_groups/')));
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

test('createDraftStories treats Storyblok editor metadata as idempotent on retry', async () => {
  const plannedContent = {
    component: 'hts_acme_homepage_v1_template_page',
    body: [
      {
        _uid: 'hero-block',
        component: 'hts_acme_homepage_v1_hero',
        headline: 'Welcome',
        body: {
          type: 'doc',
          content: []
        },
        cta_link: {
          linktype: 'story',
          cached_url: 'acme-homepage-v1/home'
        },
        image: {
          id: 88,
          filename: 'https://a.storyblok.com/f/123/acme-homepage-v1/hero.svg',
          alt: 'Hero image',
          title: '',
          fieldtype: 'asset'
        }
      }
    ]
  };
  const existingContent = {
    ...plannedContent,
    _editable: '<!--#storyblok#root-->',
    body: [
      {
        ...plannedContent.body[0],
        _uid: 'storyblok-generated-hero-uid',
        _editable: '<!--#storyblok#hero-->',
        cta_link: {
          linktype: 'story',
          cached_url: 'acme-homepage-v1/home',
          id: 'home-story-uuid',
          url: '',
          fieldtype: 'multilink'
        },
        image: {
          ...plannedContent.body[0].image,
          focus: '',
          source: '',
          copyright: '',
          meta_data: {}
        }
      }
    ]
  };
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/stories?by_slugs=')) {
      return {
        stories: [
          {
            id: 456,
            uuid: 'home-story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            published_at: null,
            content: existingContent
          }
        ]
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
          content: plannedContent
        }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'already_exists');
  assert.equal(result[0].link_resolution, 'already_hydrated');
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 0);
  restoreFetch();
});

test('createDraftStories reports the first real Storyblok draft drift path', async () => {
  const plannedContent = {
    component: 'hts_acme_homepage_v1_template_page',
    body: [
      {
        component: 'hts_acme_homepage_v1_hero',
        headline: 'Welcome'
      }
    ]
  };
  const existingContent = {
    component: 'hts_acme_homepage_v1_template_page',
    body: [
      {
        component: 'hts_acme_homepage_v1_hero',
        headline: 'Changed in Storyblok'
      }
    ]
  };
  mockFetch((url) => {
    if (url.includes('/stories?by_slugs=')) {
      return {
        stories: [
          {
            id: 456,
            uuid: 'home-story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            published_at: null,
            content: existingContent
          }
        ]
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  await assert.rejects(
    () => createDraftStories({
      integration_id: 'acme-homepage-v1',
      storyblok_prefix: 'hts_acme_homepage_v1_',
      storyblok: {
        stories_to_create: [
          {
            slug: 'acme-homepage-v1/home',
            component: 'hts_acme_homepage_v1_template_page',
            content: plannedContent
          }
        ]
      }
    }, { env: storyblokEnv() }),
    /content\.body\[0\]\.headline/
  );
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
  assert.equal(result[0].editor_url, 'https://app.storyblok.com/#/me/spaces/12345/stories/0/0/457');
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
  assert.match(result[0].source_sha256, /^[a-f0-9]{64}$/);
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

test('uploadStoryblokAssets serializes duplicate remote asset targets', async () => {
  const assetRoot = await mkdtemp(path.join(os.tmpdir(), 'hts-storyblok-asset-duplicate-'));
  const assetPath = path.join(assetRoot, 'logo.svg');
  await writeFile(assetPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  originalFetch = global.fetch;
  let searchAttempts = 0;
  let signAttempts = 0;

  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/asset_folders/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({
        asset_folders: [
          {
            id: 77,
            name: 'acme-homepage-v1',
            parent_id: 0
          }
        ]
      });
    }
    if (href.includes('/assets?search=')) {
      searchAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ assets: [] });
    }
    if (href.endsWith('/assets/') && options.method === 'POST') {
      signAttempts += 1;
      return jsonResponse({
        id: 88,
        post_url: 'https://storyblok-upload.example/upload',
        fields: {
          key: 'upload-key'
        }
      });
    }
    if (href === 'https://storyblok-upload.example/upload') {
      return jsonResponse({});
    }
    if (href.endsWith('/assets/88/finish_upload')) {
      return jsonResponse({
        asset: {
          id: 88,
          filename: 'https://a.storyblok.com/f/space/acme-homepage-v1/logo.svg',
          short_filename: 'logo.svg',
          asset_folder_id: 77,
          content_length: 47
        }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

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
          asset_folder_path: 'acme-homepage-v1',
          source_ref: 'first-logo'
        },
        {
          local_path: assetPath,
          filename: 'acme-homepage-v1/logo.svg',
          asset_folder_path: 'acme-homepage-v1',
          source_ref: 'second-logo'
        }
      ]
    }
  }, {
    env: {
      ...storyblokEnv(),
      STORYBLOK_READ_CONCURRENCY: '2'
    }
  });

  assert.equal(result[0].status, 'created');
  assert.equal(result[1].status, 'already_exists');
  assert.equal(result[1].duplicate_target, true);
  assert.equal(result[1].id, 88);
  assert.equal(searchAttempts, 1);
  assert.equal(signAttempts, 1);
  restoreFetch();
});

test('createStoryblokInternalTags creates missing namespaced tags', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/internal_tags/') && (options.method || 'GET') === 'GET') {
      return { internal_tags: [] };
    }
    if (url.endsWith('/internal_tags/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, {
        internal_tag: {
          name: 'hts_acme_homepage_v1_components',
          object_type: 'component'
        }
      });
      return {
        internal_tag: {
          id: 91,
          name: 'hts_acme_homepage_v1_components',
          object_type: 'component'
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokInternalTags({
    storyblok: {
      internal_tags_to_create: [
        { name: 'hts_acme_homepage_v1_components', object_type: 'component' }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'created');
  assert.equal(result[0].id, 91);
  assert.equal(calls.length, 2);
  restoreFetch();
});

test('createStoryblokInternalTags skips optional tags when the endpoint is unavailable', async () => {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/internal_tags/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await createStoryblokInternalTags({
    storyblok: {
      internal_tags_to_create: [
        { name: 'hts_acme_homepage_v1_components', object_type: 'component' }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result[0].status, 'skipped_optional');
  assert.match(result[0].reason, /internal tags are unavailable/);
  assert.equal(calls.length, 1);
  restoreFetch();
});

test('createStoryblokPresets creates component presets with hydrated asset fields', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/presets/') && (options.method || 'GET') === 'GET') {
      return { presets: [] };
    }
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') {
      return {
        components: [
          {
            id: 44,
            name: 'hts_acme_homepage_v1_hero',
            is_nestable: true,
            schema: {}
          }
        ]
      };
    }
    if (url.endsWith('/presets/') && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.preset.component_id, 44);
      assert.equal(payload.preset.name, 'hts_acme_homepage_v1_hero_default');
      assert.equal(payload.preset.preset.image.id, 88);
      assert.equal(payload.preset.preset.image.filename, 'https://a.storyblok.com/f/space/acme-homepage-v1/hero.svg');
      return {
        preset: {
          id: 101,
          name: payload.preset.name,
          component_id: 44,
          preset: payload.preset.preset
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await createStoryblokPresets({
    storyblok: {
      assets_to_create: [
        {
          source_ref: './assets/hero.svg',
          filename: 'acme-homepage-v1/hero.svg'
        }
      ],
      presets_to_create: [
        {
          name: 'hts_acme_homepage_v1_hero_default',
          component_technical_name: 'hts_acme_homepage_v1_hero',
          preset: {
            component: 'hts_acme_homepage_v1_hero',
            image: {
              filename: './assets/hero.svg',
              alt: 'Hero'
            }
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
          filename: 'https://a.storyblok.com/f/space/acme-homepage-v1/hero.svg'
        }
      }
    ]
  });

  assert.equal(result[0].status, 'created');
  assert.ok(calls.some((call) => call.url.endsWith('/presets/') && call.options.method === 'POST'));
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

test('preflightStoryblokIntegration performs non-mutating Storyblok readiness checks', async () => {
  const calls = mockFetch((url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET');
    if (url.endsWith('/spaces/12345')) return { space: { id: 12345, name: 'Demo' } };
    if (url.includes('/component_groups/')) return { component_groups: [] };
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/components/')) return { components: [] };
    if (url.includes('/stories?per_page=1')) return { stories: [] };
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets?per_page=1')) return { assets: [] };
    if (url.includes('/presets/')) return { presets: [] };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await preflightStoryblokIntegration({
    storyblok: {
      component_groups_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }],
      internal_tags_to_create: [{ name: 'hts_acme_homepage_v1_components', object_type: 'component' }],
      components_to_create: [{ technical_name: 'hts_acme_homepage_v1_hero' }],
      presets_to_create: [{
        name: 'hts_acme_homepage_v1_hero_default',
        component_technical_name: 'hts_acme_homepage_v1_hero',
        preset: { component: 'hts_acme_homepage_v1_hero' }
      }],
      asset_folders_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }],
      assets_to_create: [{ filename: 'acme-homepage-v1/hero.svg' }],
      stories_to_create: [{ slug: 'acme-homepage-v1/home' }]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'passed');
  assert.equal(result.capabilities.content_api, 'not_configured');
  assert.equal(result.permission_matrix.components.read, 'passed');
  assert.match(result.permission_matrix.components.additive_create, /verified_during_create_call/);
  assert.ok(calls.every((call) => (call.options.method || 'GET') === 'GET'));
  restoreFetch();
});

test('preflightStoryblokIntegration treats unavailable internal tags as optional', async () => {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(options.method || 'GET', 'GET');
    if (String(url).endsWith('/spaces/12345')) return jsonResponse({ space: { id: 12345, name: 'Demo' } });
    if (String(url).includes('/internal_tags/')) return jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 });
    if (String(url).includes('/components/')) return jsonResponse({ components: [] });
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await preflightStoryblokIntegration({
    storyblok: {
      internal_tags_to_create: [{ name: 'hts_acme_homepage_v1_components', object_type: 'component' }],
      components_to_create: [{ technical_name: 'hts_acme_homepage_v1_hero' }]
    }
  }, { env: storyblokEnv() });

  const internalTagsCheck = result.checks.find((check) => check.name === 'internal_tags_read');
  assert.equal(result.status, 'passed');
  assert.equal(internalTagsCheck.status, 'warning');
  assert.equal(internalTagsCheck.required, false);
  assert.equal(internalTagsCheck.optional, true);
  assert.equal(result.permission_matrix.internal_tags.additive_create, 'optional_skipped_when_unavailable');
  assert.equal(result.permission_matrix.components.additive_create, 'component_create_verified_during_create_call');
  assert.ok(calls.every((call) => (call.options.method || 'GET') === 'GET'));
  restoreFetch();
});

test('inspectStoryblokSpace continues when internal tags are unavailable', async () => {
  originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET');
    const href = String(url);
    if (href.endsWith('/spaces/12345')) return jsonResponse({ space: { id: 12345, name: 'Demo' } });
    if (href.includes('/components/')) return jsonResponse({ components: [] });
    if (href.includes('/component_groups/')) return jsonResponse({ component_groups: [] });
    if (href.includes('/stories')) return jsonResponse({ stories: [] });
    if (href.includes('/asset_folders/')) return jsonResponse({ asset_folders: [] });
    if (href.includes('/assets')) return jsonResponse({ assets: [] });
    if (href.includes('/internal_tags/')) return jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 });
    if (href.includes('/presets/')) return jsonResponse({ presets: [] });
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await inspectStoryblokSpace({ env: storyblokEnv() });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.internal_tags, []);
  assert.equal(result.optional_unavailable[0].name, 'internal_tags');
  assert.equal(result.readiness.core_counts.internal_tags, 0);
  restoreFetch();
});

test('reconcileStoryblokManifest treats unavailable internal tags as present unverified', async () => {
  originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET');
    const href = String(url);
    if (href.includes('/component_groups/')) return jsonResponse({ component_groups: [] });
    if (href.includes('/internal_tags/')) return jsonResponse({ message: 'Not Found' }, { ok: false, status: 404 });
    if (href.includes('/components/')) return jsonResponse({ components: [] });
    if (href.includes('/asset_folders/')) return jsonResponse({ asset_folders: [] });
    if (href.includes('/assets')) return jsonResponse({ assets: [] });
    if (href.includes('/presets/')) return jsonResponse({ presets: [] });
    if (href.includes('/stories')) return jsonResponse({ stories: [] });
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await reconcileStoryblokManifest({
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      internal_tags_to_create: [
        { name: 'hts_acme_homepage_v1_components', object_type: 'component' }
      ]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'passed');
  assert.equal(result.resources[0].resource_type, 'storyblok_internal_tag');
  assert.equal(result.resources[0].status, 'present_unverified');
  assert.equal(result.resources[0].optional, true);
  restoreFetch();
});

test('reconcileStoryblokManifest reuses cached remote management state', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/component_groups/')) return { component_groups: [] };
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/components/')) return { components: [] };
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets')) return { assets: [] };
    if (url.includes('/presets/')) return { presets: [] };
    if (url.includes('/stories')) return { stories: [] };
    throw new Error(`unexpected request: ${url}`);
  });

  const stateCache = createStoryblokStateCache();
  const manifest = {
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      component_groups_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }]
    }
  };
  const firstResult = await reconcileStoryblokManifest(manifest, { env: storyblokEnv(), stateCache });
  const secondResult = await reconcileStoryblokManifest(manifest, { env: storyblokEnv(), stateCache });

  assert.equal(firstResult.status, 'incomplete');
  assert.equal(secondResult.status, 'incomplete');
  assert.equal(calls.filter((call) => call.url.includes('/component_groups/')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('/stories')).length, 1);
  restoreFetch();
});

test('inspectStoryblokSpace audit reads optional Storyblok management collections', async () => {
  mockFetch((url) => {
    if (url.endsWith('/spaces/12345')) return { space: { id: 12345, name: 'Demo' } };
    if (url.includes('/component_groups/')) return { component_groups: [] };
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/presets/')) return { presets: [] };
    if (url.includes('/components/')) return { components: [] };
    if (url.includes('/stories?')) return { stories: [] };
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets?')) return { assets: [] };
    if (url.includes('/workflows')) return { workflows: [{ id: 1, name: 'Editorial' }] };
    if (url.includes('/workflow_stages/')) return { workflow_stages: [{ id: 2, name: 'Review', workflow_id: 1 }] };
    if (url.includes('/releases')) return { releases: [{ id: 3, name: 'Import review' }] };
    if (url.includes('/webhook_endpoints/')) return { webhook_endpoints: [{ id: 4, endpoint: 'https://hooks.example/run?token=secret' }] };
    if (url.includes('/datasources/')) return { datasources: [{ id: 5, name: 'Services' }] };
    if (url.includes('/datasource_entries/')) return { datasource_entries: [{ id: 6, name: 'Starter', value: 'starter', datasource_id: 5 }] };
    if (url.includes('/collaborators/')) return { collaborators: [{ id: 7, role: 'admin' }] };
    if (url.includes('/space_roles/')) return { space_roles: [{ id: 8, name: 'Editor' }] };
    if (url.includes('/activities')) return { activities: [{ id: 9, action: 'created' }] };
    if (url.includes('/tasks/')) return { tasks: [{ id: 10, name: 'Review import' }] };
    if (url.includes('/tags')) return { tags: [{ id: 11, name: 'campaign' }] };
    if (url.includes('/branches/')) return { branches: [{ id: 12, name: 'main' }] };
    if (url.includes('/approvals/')) return { approvals: [{ id: 13, status: 'pending' }] };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await inspectStoryblokSpace({
    env: storyblokEnv(),
    audit: true
  });

  assert.equal(result.audit.status, 'ok');
  assert.equal(result.audit.collections.workflows.count, 1);
  assert.equal(result.audit.collections.webhook_endpoints.items[0].endpoint, 'https://hooks.example/run?token=%5BREDACTED%5D');
  assert.equal(result.readiness.automation.webhook_impact_review_recommended, true);
  restoreFetch();
});

test('inspectStoryblokSpace caps remote list scans by default', async () => {
  const calls = mockFetch((url) => {
    if (url.endsWith('/spaces/12345')) return { space: { id: 12345, name: 'Demo' } };
    if (url.includes('/component_groups/')) {
      return { component_groups: [{ id: 7, uuid: 'folder-one', name: 'one' }, { id: 8, uuid: 'folder-two', name: 'two' }] };
    }
    if (url.includes('/internal_tags/')) {
      return { internal_tags: [{ id: 9, name: 'one', object_type: 'component' }, { id: 10, name: 'two', object_type: 'asset' }] };
    }
    if (url.includes('/presets/')) {
      return { presets: [{ id: 11, name: 'one', component_id: 1, preset: {} }, { id: 12, name: 'two', component_id: 2, preset: {} }] };
    }
    if (url.includes('/components/')) {
      return { components: [{ id: 1, name: 'one', schema: {} }, { id: 2, name: 'two', schema: {} }] };
    }
    if (url.includes('/stories?')) {
      return { stories: [{ id: 3, full_slug: 'one', content: {} }, { id: 4, full_slug: 'two', content: {} }] };
    }
    if (url.includes('/asset_folders/')) {
      return { asset_folders: [{ id: 13, name: 'one' }, { id: 14, name: 'two' }] };
    }
    if (url.includes('/assets?')) {
      return { assets: [{ id: 5, filename: 'one.svg' }, { id: 6, filename: 'two.svg' }] };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await inspectStoryblokSpace({
    env: {
      ...storyblokEnv(),
      STORYBLOK_INSPECT_MAX_ITEMS: '1'
    }
  });

  assert.equal(result.inspection_limit, 1);
  assert.equal(result.component_groups.length, 1);
  assert.equal(result.components.length, 1);
  assert.equal(result.stories.length, 1);
  assert.equal(result.asset_folders.length, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(result.internal_tags.length, 1);
  assert.equal(result.presets.length, 1);
  assert.equal(calls.filter((call) => call.url.includes('page=2')).length, 0);
  restoreFetch();
});

test('reconcileStoryblokManifest classifies matching Storyblok resources', async () => {
  mockFetch((url) => {
    if (url.includes('/component_groups/')) {
      return { component_groups: [{ id: 55, uuid: 'component-folder-uuid', name: 'acme-homepage-v1', parent_id: 0 }] };
    }
    if (url.includes('/internal_tags/')) {
      return { internal_tags: [{ id: 56, name: 'hts_acme_homepage_v1_components', object_type: 'component' }] };
    }
    if (url.includes('/components/')) {
      return {
        components: [
          {
            id: 57,
            name: 'hts_acme_homepage_v1_hero',
            display_name: 'Hero',
            is_root: false,
            is_nestable: true,
            component_group_uuid: 'component-folder-uuid',
            preview_field: 'headline',
            schema: { headline: { type: 'text' } }
          }
        ]
      };
    }
    if (url.includes('/asset_folders/')) {
      return { asset_folders: [{ id: 77, name: 'acme-homepage-v1', parent_id: 0 }] };
    }
    if (url.includes('/assets?')) {
      return { assets: [{ id: 88, filename: 'https://a.storyblok.com/f/space/acme-homepage-v1/hero.svg', short_filename: 'hero.svg', asset_folder_id: 77 }] };
    }
    if (url.includes('/presets/')) {
      return { presets: [] };
    }
    if (url.includes('/stories')) {
      return {
        stories: [
          {
            id: 99,
            uuid: 'story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            published_at: null,
            content: { component: 'hts_acme_homepage_v1_hero' }
          }
        ]
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await reconcileStoryblokManifest({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      component_groups_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }],
      internal_tags_to_create: [{ name: 'hts_acme_homepage_v1_components', object_type: 'component' }],
      components_to_create: [{
        technical_name: 'hts_acme_homepage_v1_hero',
        display_name: 'Hero',
        component_type: 'nestable',
        component_group_path: 'acme-homepage-v1',
        preview_field: 'headline',
        schema: { headline: { type: 'text' } }
      }],
      asset_folders_to_create: [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1' }],
      assets_to_create: [{ filename: 'acme-homepage-v1/hero.svg', asset_folder_path: 'acme-homepage-v1' }],
      stories_to_create: [{ slug: 'acme-homepage-v1/home' }]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'passed');
  assert.equal(result.summary.missing, 0);
  assert.ok(result.resources.every((entry) => entry.status === 'matching'));
  restoreFetch();
});

test('reconcileStoryblokManifest hydrates component summaries and ignores Storyblok schema metadata', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/component_groups/')) {
      return { component_groups: [{ id: 55, uuid: 'component-folder-uuid', name: 'acme-homepage-v1', parent_id: 0 }] };
    }
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/components/57')) {
      return {
        component: {
          id: 57,
          name: 'hts_acme_homepage_v1_hero',
          display_name: 'Hero',
          is_root: false,
          is_nestable: true,
          component_group_uuid: 'component-folder-uuid',
          preview_field: 'headline',
          schema: {
            headline: {
              id: 101,
              pos: 0,
              type: 'text',
              translatable: true,
              description: 'Section headline',
              required: false
            },
            cards: {
              id: 102,
              pos: 1,
              type: 'bloks',
              restrict_components: true,
              component_whitelist: ['hts_acme_homepage_v1_feature_item'],
              maximum: 3
            }
          }
        }
      };
    }
    if (url.includes('/components/')) {
      return {
        components: [
          {
            id: 57,
            name: 'hts_acme_homepage_v1_hero'
          }
        ]
      };
    }
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets?')) return { assets: [] };
    if (url.includes('/presets/')) return { presets: [] };
    if (url.includes('/stories')) return { stories: [] };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await reconcileStoryblokManifest({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      components_to_create: [{
        technical_name: 'hts_acme_homepage_v1_hero',
        display_name: 'Hero',
        component_type: 'nestable',
        component_group_path: 'acme-homepage-v1',
        preview_field: 'headline',
        schema: {
          headline: {
            type: 'text',
            translatable: true,
            description: 'Section headline'
          },
          cards: {
            type: 'bloks',
            restrict_components: true,
            component_whitelist: ['hts_acme_homepage_v1_feature_item'],
            maximum: 3
          }
        }
      }]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'passed');
  assert.equal(result.summary.drifted, 0);
  assert.equal(calls.filter((call) => call.url.includes('/components/57')).length, 1);
  restoreFetch();
});

test('verifyStoryblokManagementState hydrates story summaries before root component checks', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/component_groups/')) return { component_groups: [] };
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/components/')) return { components: [] };
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets?')) return { assets: [] };
    if (url.includes('/presets/')) return { presets: [] };
    if (url.includes('/stories/99')) {
      return {
        story: {
          id: 99,
          uuid: 'story-uuid',
          slug: 'home',
          full_slug: 'acme-homepage-v1/home',
          published_at: null,
          content: {
            component: 'hts_acme_homepage_v1_template_page',
            body: [
              { component: 'hts_acme_homepage_v1_hero' }
            ]
          }
        }
      };
    }
    if (url.includes('/stories?by_slugs=') || url.includes('/stories?')) {
      return {
        stories: [
          {
            id: 99,
            uuid: 'story-uuid',
            slug: 'home',
            full_slug: 'acme-homepage-v1/home',
            published_at: null
          }
        ]
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await verifyStoryblokManagementState({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [{ slug: 'acme-homepage-v1/home' }]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'passed');
  assert.equal(result.summary.failed_story_checks, 0);
  assert.equal(calls.filter((call) => call.url.includes('/stories/99')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('/stories?by_slugs=')).length, 0);
  restoreFetch();
});

test('verifyStoryblokManagementState detects unresolved generated links and local asset fields', async () => {
  mockFetch((url) => {
    const story = {
      id: 99,
      uuid: 'story-uuid',
      slug: 'home',
      full_slug: 'acme-homepage-v1/home',
      published_at: null,
      content: {
        component: 'hts_acme_homepage_v1_template_page',
        body: [
          {
            component: 'hts_acme_homepage_v1_hero',
            cta_link: { linktype: 'story', cached_url: 'acme-homepage-v1/home' },
            image: { id: null, filename: './assets/hero.svg', fieldtype: 'asset' }
          }
        ]
      }
    };
    if (url.includes('/component_groups/')) return { component_groups: [] };
    if (url.includes('/internal_tags/')) return { internal_tags: [] };
    if (url.includes('/components/')) {
      return { components: [{ id: 57, name: 'hts_acme_homepage_v1_template_page', is_root: true, schema: {}, preview_field: 'headline' }] };
    }
    if (url.includes('/asset_folders/')) return { asset_folders: [] };
    if (url.includes('/assets?')) return { assets: [] };
    if (url.includes('/presets/')) return { presets: [] };
    if (url.includes('/stories?by_slugs=')) return { stories: [story] };
    if (url.includes('/stories')) return { stories: [story] };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await verifyStoryblokManagementState({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      components_to_create: [{ technical_name: 'hts_acme_homepage_v1_template_page', component_type: 'content_type', schema: {} }],
      stories_to_create: [{ slug: 'acme-homepage-v1/home' }]
    }
  }, { env: storyblokEnv() });

  assert.equal(result.status, 'failed');
  assert.equal(result.summary.unresolved_generated_story_links, 1);
  assert.equal(result.summary.unresolved_asset_fields, 1);
  restoreFetch();
});

test('collectStoryblokActivityEvidence filters activity evidence to the integration', async () => {
  mockFetch((url) => {
    if (url.includes('/activities')) {
      return {
        activities: [
          { id: 1, action: 'created', item_type: 'story', item_id: 99, created_at: '2026-08-07T10:00:00.000Z', description: 'created acme-homepage-v1/home' },
          { id: 2, action: 'updated', item_type: 'story', item_id: 100, created_at: '2026-08-07T10:00:00.000Z', description: 'updated unrelated' }
        ]
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await collectStoryblokActivityEvidence({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [{ slug: 'acme-homepage-v1/home' }]
    }
  }, { env: storyblokEnv(), since: '2026-08-07T09:00:00.000Z' });

  assert.equal(result.status, 'recorded');
  assert.equal(result.summary.related, 1);
  assert.equal(result.activities[0].id, 1);
  restoreFetch();
});

test('validateStoryblokDraftContent verifies generated draft stories through Content API', async () => {
  mockFetch((url) => {
    assert.match(url, /token=preview-token/);
    return {
      story: {
        id: 789,
        uuid: 'home-story-uuid',
        name: 'Home',
        slug: 'home',
        full_slug: 'acme-homepage-v1/home',
        content: {
          component: 'hts_acme_homepage_v1_template_page',
          body: [
            {
              component: 'hts_acme_homepage_v1_hero',
              image: {
                id: 88,
                filename: 'https://a.storyblok.com/f/123/acme-homepage-v1/hero.svg',
                fieldtype: 'asset'
              },
              cta_link: {
                id: 'home-story-uuid',
                linktype: 'story',
                cached_url: 'acme-homepage-v1/home',
                fieldtype: 'multilink'
              }
            }
          ]
        },
        published_at: null
      }
    };
  });

  const result = await validateStoryblokDraftContent({
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        {
          slug: 'acme-homepage-v1/home',
          content: {
            component: 'hts_acme_homepage_v1_template_page'
          }
        }
      ]
    }
  }, {
    env: {
      STORYBLOK_PREVIEW_TOKEN: 'preview-token'
    }
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.summary.assets, 1);
  assert.equal(result.summary.story_links, 1);
  restoreFetch();
});

test('validateStoryblokDraftContent fails generated story links without UUIDs', async () => {
  mockFetch(() => ({
    story: {
      id: 789,
      uuid: 'home-story-uuid',
      name: 'Home',
      slug: 'home',
      full_slug: 'acme-homepage-v1/home',
      content: {
        component: 'hts_acme_homepage_v1_template_page',
        body: [
          {
            component: 'hts_acme_homepage_v1_hero',
            cta_link: {
              linktype: 'story',
              cached_url: 'acme-homepage-v1/about',
              fieldtype: 'multilink'
            }
          }
        ]
      },
      published_at: null
    }
  }));

  const result = await validateStoryblokDraftContent({
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        { slug: 'acme-homepage-v1/home', content: { component: 'hts_acme_homepage_v1_template_page' } },
        { slug: 'acme-homepage-v1/about', content: { component: 'hts_acme_homepage_v1_template_page' } }
      ]
    }
  }, {
    env: {
      STORYBLOK_PREVIEW_TOKEN: 'preview-token'
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.summary.unresolved_generated_story_links, 2);
  restoreFetch();
});

test('validateStoryblokDraftContent preserves story order with concurrent reads', async () => {
  originalFetch = global.fetch;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const delays = new Map([
    ['acme-homepage-v1/home', 20],
    ['acme-homepage-v1/about', 0],
    ['acme-homepage-v1/contact', 5]
  ]);

  global.fetch = async (url) => {
    const slug = new URL(String(url)).pathname.split('/stories/')[1];
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, delays.get(slug) || 0));
    activeRequests -= 1;
    return jsonResponse({
      story: {
        id: slug,
        uuid: `${slug}-uuid`,
        name: slug,
        slug: slug.split('/').at(-1),
        full_slug: slug,
        content: {
          component: 'hts_acme_homepage_v1_template_page'
        },
        published_at: null
      }
    });
  };

  const result = await validateStoryblokDraftContent({
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      stories_to_create: [
        { slug: 'acme-homepage-v1/home', content: { component: 'hts_acme_homepage_v1_template_page' } },
        { slug: 'acme-homepage-v1/about', content: { component: 'hts_acme_homepage_v1_template_page' } },
        { slug: 'acme-homepage-v1/contact', content: { component: 'hts_acme_homepage_v1_template_page' } }
      ]
    }
  }, {
    env: {
      STORYBLOK_PREVIEW_TOKEN: 'preview-token',
      STORYBLOK_CONTENT_READ_CONCURRENCY: '2'
    }
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.stories.map((story) => story.slug), [
    'acme-homepage-v1/home',
    'acme-homepage-v1/about',
    'acme-homepage-v1/contact'
  ]);
  assert.equal(maxActiveRequests, 2);
  restoreFetch();
});

test('Storyblok Management API calls fail fast when request timeout is reached', async () => {
  originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });

  await assert.rejects(
    createStoryblokComponents({
      storyblok: {
        components_to_create: [{ technical_name: 'hts_acme_homepage_v1_hero' }]
      }
    }, {
      env: {
        ...storyblokEnv(),
        STORYBLOK_TIMEOUT_MS: '1',
        STORYBLOK_RETRY_LIMIT: '0'
      }
    }),
    /timed out/
  );
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

test('deleteStoryblokIntegrationResources deletes namespaced presets, tags, and component folders', async () => {
  const calls = mockFetch((url, options = {}) => {
    if (url.includes('/components/') && (options.method || 'GET') === 'GET') {
      return {
        components: [
          {
            id: 44,
            name: 'hts_acme_homepage_v1_hero',
            is_nestable: true,
            schema: {}
          }
        ]
      };
    }
    if (url.includes('/presets/') && (options.method || 'GET') === 'GET') {
      return {
        presets: [
          {
            id: 66,
            name: 'hts_acme_homepage_v1_hero_default',
            component_id: 44,
            preset: {
              component: 'hts_acme_homepage_v1_hero'
            }
          }
        ]
      };
    }
    if (url.endsWith('/presets/66') && options.method === 'DELETE') return { preset: { id: 66 } };
    if (url.endsWith('/components/44') && options.method === 'DELETE') return { component: { id: 44 } };
    if (url.includes('/internal_tags/') && (options.method || 'GET') === 'GET') {
      return {
        internal_tags: [
          {
            id: 77,
            name: 'hts_acme_homepage_v1_components',
            object_type: 'component'
          }
        ]
      };
    }
    if (url.endsWith('/internal_tags/77') && options.method === 'DELETE') return { internal_tag: { id: 77 } };
    if (url.includes('/component_groups/') && (options.method || 'GET') === 'GET') {
      return {
        component_groups: [
          {
            id: 55,
            uuid: 'component-folder-uuid',
            name: 'acme-homepage-v1',
            parent_id: 0
          }
        ]
      };
    }
    if (url.endsWith('/component_groups/55') && options.method === 'DELETE') return { component_group: { id: 55 } };
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await deleteStoryblokIntegrationResources({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      component_groups_to_create: [
        { path: 'acme-homepage-v1', name: 'acme-homepage-v1' }
      ],
      internal_tags_to_create: [
        { name: 'hts_acme_homepage_v1_components', object_type: 'component' }
      ],
      components_to_create: [
        { technical_name: 'hts_acme_homepage_v1_hero', component_group_path: 'acme-homepage-v1' }
      ],
      presets_to_create: [
        {
          name: 'hts_acme_homepage_v1_hero_default',
          component_technical_name: 'hts_acme_homepage_v1_hero',
          preset: {
            component: 'hts_acme_homepage_v1_hero'
          }
        }
      ]
    }
  }, {
    env: storyblokEnv(),
    confirmIntegrationId: 'acme-homepage-v1',
    confirmRemoteDelete: true
  });

  assert.equal(result.presets[0].status, 'deleted');
  assert.equal(result.internal_tags[0].status, 'deleted');
  assert.equal(result.component_groups[0].status, 'deleted');
  assert.ok(calls.some((call) => call.url.endsWith('/presets/66') && call.options.method === 'DELETE'));
  assert.ok(calls.some((call) => call.url.endsWith('/component_groups/55') && call.options.method === 'DELETE'));
  restoreFetch();
});

test('deleteStoryblokIntegrationResources skips optional internal tags when unavailable', async () => {
  originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/internal_tags/') && (options.method || 'GET') === 'GET') {
      return jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await deleteStoryblokIntegrationResources({
    integration_id: 'acme-homepage-v1',
    storyblok_prefix: 'hts_acme_homepage_v1_',
    storyblok: {
      internal_tags_to_create: [
        { name: 'hts_acme_homepage_v1_components', object_type: 'component' }
      ]
    }
  }, {
    env: storyblokEnv(),
    confirmIntegrationId: 'acme-homepage-v1',
    confirmRemoteDelete: true
  });

  assert.equal(result.internal_tags[0].status, 'skipped_optional');
  assert.match(result.internal_tags[0].reason, /internal tags are unavailable/);
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
