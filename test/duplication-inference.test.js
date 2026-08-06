import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inferDuplicationCandidates } from '../src/duplication-inference.js';
import { duplicateFrontendComponents } from '../src/duplicator.js';
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

test('inferDuplicationCandidates includes local dependency graph and import rewrites', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-infer-graph-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await mkdir(path.join(repoPath, 'src/utils'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/components/Hero.jsx'),
    [
      "import { Icon } from './Icon.jsx';",
      "import { formatLabel } from '../utils/format.js';",
      'export function Hero(){ return <section className="hero"><Icon label={formatLabel("Hero")} /></section>; }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoPath, 'src/components/Icon.jsx'),
    'export function Icon({ label }){ return <span className="icon">{label}</span>; }\n'
  );
  await writeFile(
    path.join(repoPath, 'src/utils/format.js'),
    'export function formatLabel(value){ return String(value).toUpperCase(); }\n'
  );
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const inference = await inferDuplicationCandidates(manifest, { repoPath });
  const entries = inference.repository.components_to_duplicate;
  const root = entries.find((entry) => entry.source_path === 'src/components/Hero.jsx');
  const icon = entries.find((entry) => entry.source_path === 'src/components/Icon.jsx');
  const util = entries.find((entry) => entry.source_path === 'src/utils/format.js');

  assert.equal(inference.summary.frontend_components, 1);
  assert.equal(inference.summary.frontend_dependency_files, 2);
  assert.equal(root.import_rewrites['./Icon.jsx'], './dependencies/src/components/Icon.jsx');
  assert.equal(root.import_rewrites['../utils/format.js'], './dependencies/src/utils/format.js');
  assert.equal(icon.dependency_of, 'src/components/Hero.jsx');
  assert.equal(util.dependency_of, 'src/components/Hero.jsx');

  manifest.repository.components_to_duplicate.push(...entries);
  await duplicateFrontendComponents(manifest, { repoPath });
  const duplicated = await readFile(path.join(repoPath, root.target_path), 'utf8');

  assert.match(duplicated, /from '\.\/dependencies\/src\/components\/Icon\.jsx'/);
  assert.match(duplicated, /from '\.\/dependencies\/src\/utils\/format\.js'/);
  assert.match(duplicated, /HtsAcmeHomepageV1Hero/);
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
