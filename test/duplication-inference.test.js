import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inferDuplicationCandidates } from '../src/duplication-inference.js';
import { duplicateFrontendComponents, duplicateRepositoryAssets } from '../src/duplicator.js';
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

test('inferDuplicationCandidates includes local style dependencies with scoped duplicate output', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-infer-style-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/components/Hero.jsx'),
    [
      "import './Hero.css';",
      'export function Hero(){ return <section className="hero"><h1>Hero</h1></section>; }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoPath, 'src/components/Hero.css'),
    [
      "@import './HeroBase.css';",
      'body { margin: 0; }',
      '.hero { animation: fade 1s ease; }',
      '@media (min-width: 48rem) {',
      '  .hero h1 { font-size: 4rem; }',
      '}',
      '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoPath, 'src/components/HeroBase.css'),
    '.hero-base { color: black; }\n'
  );
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const inference = await inferDuplicationCandidates(manifest, { repoPath });
  const entries = inference.repository.components_to_duplicate;
  const root = entries.find((entry) => entry.source_path === 'src/components/Hero.jsx');
  const heroCss = entries.find((entry) => entry.source_path === 'src/components/Hero.css');
  const baseCss = entries.find((entry) => entry.source_path === 'src/components/HeroBase.css');

  assert.equal(inference.summary.frontend_components, 1);
  assert.equal(inference.summary.frontend_dependency_files, 2);
  assert.equal(root.import_rewrites['./Hero.css'], '../styles/dependencies/src/components/Hero.css');
  assert.equal(heroCss.content_kind, 'style');
  assert.equal(baseCss.content_kind, 'style');

  manifest.repository.components_to_duplicate.push(...entries);
  await duplicateFrontendComponents(manifest, { repoPath });
  const duplicatedComponent = await readFile(path.join(repoPath, root.target_path), 'utf8');
  const duplicatedCss = await readFile(path.join(repoPath, heroCss.target_path), 'utf8');

  assert.match(duplicatedComponent, /import '\.\.\/styles\/dependencies\/src\/components\/Hero\.css'/);
  assert.match(duplicatedCss, /@import '\.\/HeroBase\.css';/);
  assert.match(duplicatedCss, /\.hts-acme-homepage-v1-root \{/);
  assert.match(duplicatedCss, /\.hts-acme-homepage-v1-root \.hts-acme-homepage-v1-hero \{/);
  assert.match(duplicatedCss, /hts-acme-homepage-v1-fade/);
});

test('inferDuplicationCandidates plans local style asset copies and CSS URL rewrites', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-infer-style-assets-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await mkdir(path.join(repoPath, 'src/assets'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/components/Hero.jsx'),
    [
      "import './Hero.css';",
      'export function Hero(){ return <section className="hero">Hero</section>; }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoPath, 'src/components/Hero.css'),
    '.hero { background-image: url("../assets/hero.jpg?v=1"); }\n'
  );
  await writeFile(path.join(repoPath, 'src/assets/hero.jpg'), 'fake image');
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const inference = await inferDuplicationCandidates(manifest, { repoPath });
  const entries = inference.repository.components_to_duplicate;
  const root = entries.find((entry) => entry.source_path === 'src/components/Hero.jsx');
  const heroCss = entries.find((entry) => entry.source_path === 'src/components/Hero.css');
  const asset = inference.repository.assets_to_create[0];

  assert.equal(inference.summary.frontend_components, 1);
  assert.equal(inference.summary.frontend_asset_files, 1);
  assert.equal(asset.source_path, 'src/assets/hero.jpg');
  assert.equal(asset.target_path, 'src/integrations/acme-homepage-v1/assets/dependencies/src/assets/hero.jpg');
  assert.equal(heroCss.asset_rewrites['../assets/hero.jpg?v=1'], '../../../../assets/dependencies/src/assets/hero.jpg?v=1');

  manifest.repository.components_to_duplicate.push(...entries);
  manifest.repository.assets_to_create.push(...inference.repository.assets_to_create);
  await duplicateFrontendComponents(manifest, { repoPath });
  await duplicateRepositoryAssets(manifest, { repoPath });
  const duplicatedComponent = await readFile(path.join(repoPath, root.target_path), 'utf8');
  const duplicatedCss = await readFile(path.join(repoPath, heroCss.target_path), 'utf8');
  const copiedAsset = await readFile(path.join(repoPath, asset.target_path), 'utf8');

  assert.match(duplicatedComponent, /import '\.\.\/styles\/dependencies\/src\/components\/Hero\.css'/);
  assert.match(duplicatedCss, /url\("\.\.\/\.\.\/\.\.\/\.\.\/assets\/dependencies\/src\/assets\/hero\.jpg\?v=1"\)/);
  assert.equal(copiedAsset, 'fake image');
});

test('inferDuplicationCandidates reports skipped frontend candidates with blockers', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-infer-skip-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/components/Hero.jsx'),
    [
      "import './Hero.css';",
      'export function Hero(){ return <section className="hero">Hero</section>; }',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(repoPath, 'src/components/Hero.css'),
    ".hero { background-image: url('../assets/hero.jpg'); }\n"
  );
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const inference = await inferDuplicationCandidates(manifest, { repoPath });

  assert.equal(inference.summary.frontend_components, 0);
  assert.equal(inference.summary.skipped_frontend_candidates, 1);
  assert.equal(inference.repository.skipped_candidates[0].source_path, 'src/components/Hero.jsx');
  assert.ok(inference.repository.skipped_candidates[0].blockers.some((blocker) =>
    blocker.includes('style asset reference could not be resolved')
  ));
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
