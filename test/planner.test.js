import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationPlan } from '../src/planner.js';

test('createIntegrationPlan derives schemas, draft content, assets, and mapping from a template', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'astro'
  });

  assert.equal(manifest.validation.valid, true);
  assert.equal(manifest.storyblok_prefix, 'hts_acme_homepage_v1_');
  assert.ok(manifest.repository.files_to_create.includes('src/integrations/acme-homepage-v1/TemplatePage.astro'));
  assert.ok(manifest.repository.assets_to_create.some((asset) => asset.target_path === 'src/integrations/acme-homepage-v1/assets/hero.svg'));
  assert.ok(manifest.storyblok.components_to_create.some((component) => component.technical_name === 'hts_acme_homepage_v1_template_page'));
  assert.ok(manifest.storyblok.components_to_create.some((component) => component.technical_name === 'hts_acme_homepage_v1_hero'));
  assert.deepEqual(manifest.storyblok.asset_folders_to_create, [{ path: 'acme-homepage-v1', name: 'acme-homepage-v1', parent_id: 0 }]);
  assert.equal(manifest.storyblok.stories_to_create[0].content.component, 'hts_acme_homepage_v1_template_page');
  assert.ok(manifest.storyblok.stories_to_create[0].content.body.every((block) => block.component.startsWith('hts_acme_homepage_v1_')));
  assert.ok(manifest.storyblok.assets_to_create[0].filename.startsWith('acme-homepage-v1/'));
  assert.equal(manifest.storyblok.assets_to_create[0].asset_folder_path, 'acme-homepage-v1');
  assert.ok(manifest.mapping.every((entry) => entry.new_storyblok_component.startsWith('hts_acme_homepage_v1_')));
});
