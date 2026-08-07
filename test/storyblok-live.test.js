import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationPlan } from '../src/planner.js';
import {
  createDraftStories,
  createStoryblokAssetFolders,
  createStoryblokComponents,
  deleteStoryblokIntegrationResources,
  preflightStoryblokIntegration,
  uploadStoryblokAssets,
  validateStoryblokDraftContent
} from '../src/storyblok.js';

const liveEnabled = process.env.STORYBLOK_LIVE_TESTS === '1' &&
  process.env.STORYBLOK_MANAGEMENT_TOKEN &&
  process.env.STORYBLOK_SPACE_ID;

test('live Storyblok sandbox apply validates and rolls back generated drafts', {
  skip: liveEnabled ? false : 'Set STORYBLOK_LIVE_TESTS=1 with Storyblok credentials to run the live sandbox test.'
}, async () => {
  const integrationId = `hts-live-${Date.now()}-${process.pid}`;
  const manifest = await createIntegrationPlan({
    integrationId,
    templatePath: process.env.STORYBLOK_LIVE_TEST_TEMPLATE || 'test/fixtures/basic-template',
    framework: 'static'
  });

  try {
    const preflight = await preflightStoryblokIntegration(manifest);
    assert.equal(preflight.status, 'passed');

    const components = await createStoryblokComponents(manifest);
    assert.equal(components.length > 0, true);

    const folders = await createStoryblokAssetFolders(manifest);
    assert.equal(folders.length > 0, true);

    const assets = await uploadStoryblokAssets(manifest);
    assert.equal(assets.length > 0, true);

    const stories = await createDraftStories(manifest, { assetResults: assets });
    assert.equal(stories.length > 0, true);
    assert.ok(stories.every((story) => story.published === false));

    const validation = await validateStoryblokDraftContent(manifest);
    if (process.env.STORYBLOK_PREVIEW_TOKEN || process.env.STORYBLOK_PUBLIC_TOKEN || process.env.STORYBLOK_DELIVERY_TOKEN) {
      assert.equal(validation.status, 'passed');
    } else {
      assert.equal(validation.status, 'skipped');
    }
  } finally {
    await deleteStoryblokIntegrationResources(manifest, {
      confirmIntegrationId: integrationId,
      confirmRemoteDelete: true
    });
  }
});
