import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGeneratedFiles } from '../src/generator.js';
import { createDefaultManifest, storyblokPrefixForIntegrationId, validatePlan } from '../src/policy.js';

test('Storyblok prefix is derived from the integration ID', () => {
  assert.equal(storyblokPrefixForIntegrationId('summer-campaign-home-v2'), 'hts_summer_campaign_home_v2_');
});

test('default manifest passes additive-only policy', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
});

test('existing file modifications are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.repository.files_to_modify.push('src/storyblok/components.ts');

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations[0].reason, /cannot be modified/);
});

test('unnamespaced Storyblok technical names are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push({ technical_name: 'hero' });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.equal(result.violations.at(-1).resource, 'hero');
});

test('Storyblok prefix must match the integration ID namespace', () => {
  const manifest = createDefaultManifest({
    integrationId: 'winter-sale-v1',
    storyblokPrefix: 'hts_summer_sale_v1_',
    repositoryNamespace: 'src/integrations/winter-sale-v1'
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /Expected hts_winter_sale_v1_/);
});

test('repository file creation outside the integration namespace is rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.repository.files_to_create.push('src/components/Existing.js');

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /inside the integration namespace/);
});

test('unnamespaced nested Storyblok component whitelists are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push({
    technical_name: 'hts_acme_homepage_v1_template_page',
    schema: {
      body: {
        type: 'bloks',
        component_whitelist: ['hero']
      }
    }
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /unnamespaced/);
});

test('unsafe draft story slugs are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.stories_to_create.push({ slug: '../home', component: 'hts_acme_homepage_v1_template_page' });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /safe relative slug/);
});

test('draft story slugs must remain inside the integration story folder', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.stories_to_create.push({
    slug: 'client-visible-page',
    content: {
      component: 'hts_acme_homepage_v1_template_page',
      body: []
    }
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /acme-homepage-v1\//);
});

test('legacy integration preview draft story slugs remain valid for existing manifests', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.stories_to_create.push({
    slug: 'integration-preview/acme-homepage-v1/home',
    content: {
      component: 'hts_acme_homepage_v1_template_page',
      body: []
    }
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, true);
});

test('draft story content components must use the integration prefix', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.stories_to_create.push({
    slug: 'acme-homepage-v1/home',
    content: {
      component: 'hts_acme_homepage_v1_template_page',
      body: [
        {
          component: 'shared_hero'
        }
      ]
    }
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /unnamespaced component: shared_hero/);
});

test('unnamespaced Storyblok asset folder paths are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.asset_folders_to_create.push({ path: 'shared-assets' });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.match(result.violations.at(-1).reason, /asset folder paths must be safe and namespaced/);
});

test('generator produces isolated files inside repository namespace', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push(
    { technical_name: 'hts_acme_homepage_v1_template_page', component_type: 'content_type' },
    { technical_name: 'hts_acme_homepage_v1_hero', component_type: 'nestable' }
  );

  const files = buildGeneratedFiles(manifest);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.path.startsWith('src/integrations/acme-homepage-v1/')));
  assert.ok(files.some((file) => file.path.endsWith('/components.js')));
});
