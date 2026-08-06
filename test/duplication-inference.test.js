import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inferDuplicationCandidates } from '../src/duplication-inference.js';
import { createIntegrationPlan } from '../src/planner.js';

test('inferDuplicationCandidates finds isolated frontend component targets', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-infer-frontend-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/components/Hero.jsx'),
    'export function Hero(){ return <section className="hero primary">Hero</section>; }\n'
  );
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const inference = await inferDuplicationCandidates(manifest, { repoPath });
  const candidate = inference.repository.components_to_duplicate[0];

  assert.equal(inference.summary.frontend_components, 1);
  assert.equal(candidate.source_path, 'src/components/Hero.jsx');
  assert.equal(candidate.target_path, 'src/integrations/acme-homepage-v1/components/HtsAcmeHomepageV1Hero.jsx');
  assert.equal(candidate.export_name, 'Hero');
  assert.equal(candidate.new_export_name, 'HtsAcmeHomepageV1Hero');
});

test('createIntegrationPlan can apply inferred Storyblok duplicate candidates without collisions', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static',
    inferDuplicates: true,
    storyblokInspection: {
      components: [
        {
          technical_name: 'hero',
          display_name: 'Hero',
          type: 'nestable'
        }
      ]
    }
  });

  assert.equal(manifest.validation.valid, true);
  assert.ok(manifest.storyblok.components_to_duplicate.some((component) =>
    component.source_technical_name === 'hero' &&
    component.technical_name === 'hts_acme_homepage_v1_hero'
  ));
  assert.ok(!manifest.storyblok.components_to_create.some((component) =>
    component.technical_name === 'hts_acme_homepage_v1_hero'
  ));
  assert.ok(manifest.operations.some((operation) =>
    operation.type === 'duplicate_existing_resource' &&
    operation.resource_type === 'storyblok_component' &&
    operation.resource === 'hts_acme_homepage_v1_hero'
  ));
});
