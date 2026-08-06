import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
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

test('plan command applies schema override files into the generated manifest', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-plan-overrides-work-'));
  const overridesPath = path.join(workDir, 'schema-overrides.json');
  await writeFile(overridesPath, JSON.stringify({
    components: {
      hero: {
        fields: {
          campaign_code: 'text'
        },
        draft: {
          campaign_code: 'spring-launch'
        }
      }
    }
  }, null, 2));

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'plan',
    '--integration-id',
    'acme-homepage-v1',
    '--template',
    'test/fixtures/basic-template',
    '--framework',
    'static',
    '--schema-overrides',
    overridesPath,
    '--work-dir',
    workDir
  ]));
  const manifest = JSON.parse(output);
  const hero = manifest.storyblok.components_to_create.find((component) => component.technical_name === 'hts_acme_homepage_v1_hero');
  const draftHero = manifest.storyblok.stories_to_create[0].content.body.find((block) => block.component === 'hts_acme_homepage_v1_hero');

  assert.equal(manifest.validation.valid, true);
  assert.equal(manifest.schema_overrides.source_path, overridesPath);
  assert.equal(hero.schema.campaign_code.type, 'text');
  assert.equal(draftHero.campaign_code, 'spring-launch');
});

test('createIntegrationPlan creates one namespaced draft story per template route', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });

  assert.equal(manifest.validation.valid, true);
  assert.deepEqual(manifest.template.pages, [
    'about.html',
    'contact.html',
    'gallery.html',
    'index.html',
    'services.html'
  ]);
  assert.deepEqual(manifest.storyblok.stories_to_create.map((story) => story.slug), [
    'acme-campaign-v1/home',
    'acme-campaign-v1/about',
    'acme-campaign-v1/contact',
    'acme-campaign-v1/gallery',
    'acme-campaign-v1/services'
  ]);
  assert.equal(manifest.storyblok.stories_to_create[0].source_page, 'index.html');
});

async function captureStdout(callback) {
  const originalLog = console.log;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return output.trim();
}
