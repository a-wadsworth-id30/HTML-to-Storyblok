import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftStories, createStoryblokComponents, inspectStoryblokContentStory } from '../src/storyblok.js';

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

function restoreFetch() {
  global.fetch = originalFetch;
}

function storyblokEnv() {
  return {
    STORYBLOK_MANAGEMENT_TOKEN: 'management-token',
    STORYBLOK_SPACE_ID: '12345'
  };
}
