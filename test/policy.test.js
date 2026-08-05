import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultManifest, validatePlan } from '../src/policy.js';

test('default manifest passes additive-only policy', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });

  const result = validatePlan(manifest);
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
});

test('existing file modifications are rejected', () => {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_v1_',
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
    storyblokPrefix: 'hts_acme_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push({ technical_name: 'hero' });

  const result = validatePlan(manifest);
  assert.equal(result.valid, false);
  assert.equal(result.violations.at(-1).resource, 'hero');
});

