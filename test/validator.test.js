import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { diffIntegration, preflightRepositoryIntegration, runRepositoryScript, validateIntegration } from '../src/validator.js';

test('validateIntegration passes for a generated isolated integration', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-validate-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const result = await validateIntegration(manifest, { repoPath });

  assert.equal(result.status, 'passed');
  assert.equal(result.failed_checks, 0);
});

test('validateIntegration allows only generated Storyblok HTML renderers', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-validate-renderer-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'react-renderer-v1',
    storyblokPrefix: 'hts_react_renderer_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'react'
  });

  const generatedResult = await validateIntegration(manifest, { repoPath });
  assert.equal(generatedResult.status, 'passed');

  const previewPath = path.join(repoPath, 'src/integrations/react-renderer-v1/TemplatePage.jsx');
  await writeFile(previewPath, 'export function HtsTemplatePage({ html = "" }) { return <main dangerouslySetInnerHTML={{ __html: html }} />; }\n');

  const unsafeResult = await validateIntegration(manifest, { repoPath });
  assert.equal(unsafeResult.status, 'failed');
  assert.ok(unsafeResult.checks.some((check) =>
    check.name === 'forbidden_coupling:src/integrations/react-renderer-v1/TemplatePage.jsx' &&
    check.status === 'failed' &&
    check.details.includes('dangerouslySetInnerHTML')
  ));
});

test('validateIntegration fails when a generated file imports an existing presentation component', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-validate-fail-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const badFile = path.join(repoPath, 'src/integrations/acme-homepage-v1/components.js');
  await writeFile(badFile, "import Button from '../../components/Button.js';\nexport { Button };\n");

  const result = await validateIntegration(manifest, { repoPath });

  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check) => check.name.endsWith('components.js') && check.status === 'failed'));
});

test('validateIntegration ignores Markdown guide import examples for runtime coupling', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-validate-guide-import-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-guide-v1',
    templatePath: 'test/fixtures/basic-template',
    framework: 'astro'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'astro'
  });
  const guidePath = path.join(repoPath, 'src/integrations/acme-guide-v1/INTEGRATION_GUIDE.md');
  await writeFile(guidePath, "```js\nimport ImportedRoute from '../integrations/acme-guide-v1/route-proposals/home/page.astro';\n```\n");

  const result = await validateIntegration(manifest, { repoPath });

  assert.equal(result.status, 'passed');
});

test('validateIntegration checks duplicated component targets for forbidden coupling', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-validate-duplicate-fail-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  manifest.repository.components_to_duplicate.push({
    source_path: 'src/components/Hero.js',
    target_path: 'src/integrations/acme-homepage-v1/components/HtsHero.js'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1/components'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'src/integrations/acme-homepage-v1/components/HtsHero.js'),
    "import Button from '../../../components/Button.js';\nexport { Button };\n"
  );

  const result = await validateIntegration(manifest, { repoPath });

  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check) =>
    check.name === 'forbidden_coupling:src/integrations/acme-homepage-v1/components/HtsHero.js' &&
    check.status === 'failed'
  ));
});

test('validateIntegration rejects adapter plans that claim host route mutation', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-adapter-validation-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });
  const adapterPath = path.join(repoPath, 'src/integrations/acme-campaign-v1/adapter-plan.json');
  const adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
  adapter.host_routes_modified = true;
  await writeFile(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`);

  const result = await validateIntegration(manifest, { repoPath });

  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check) => check.name === 'repository_adapter_plan' && check.status === 'failed'));
});

test('diffIntegration reports duplicated component targets separately from generated files', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-diff-duplicates-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  manifest.repository.components_to_duplicate.push({
    source_path: 'src/components/Hero.js',
    target_path: 'src/integrations/acme-homepage-v1/components/HtsHero.js'
  });

  const diff = await diffIntegration(manifest, { repoPath });
  const duplicated = diff.repository_files.find((file) => file.path === 'src/integrations/acme-homepage-v1/components/HtsHero.js');

  assert.equal(duplicated.planned_action, 'duplicate');
  assert.equal(duplicated.status, 'missing');
});

test('diffIntegration reports local file existence against the manifest', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-diff-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const before = await diffIntegration(manifest, { repoPath });
  assert.ok(before.repository_files.every((file) => file.status === 'missing'));

  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const after = await diffIntegration(manifest, { repoPath });
  assert.ok(after.repository_files.every((file) => file.status === 'exists'));
});

test('preflightRepositoryIntegration refuses planned target collisions', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-preflight-collision-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'existing file\n');

  const preflight = await preflightRepositoryIntegration(manifest, { repoPath });

  assert.equal(preflight.status, 'failed');
  assert.ok(preflight.collisions.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(preflight.checks.some((check) => check.name === 'planned_targets_available' && check.status === 'failed'));
});

test('preflightRepositoryIntegration reports collisions as warnings during dry run', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-preflight-dry-run-collision-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'existing file\n');

  const preflight = await preflightRepositoryIntegration(manifest, { repoPath, mode: 'dry-run' });

  assert.equal(preflight.status, 'passed');
  assert.ok(preflight.collisions.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(preflight.checks.some((check) => check.name === 'planned_targets_available' && check.status === 'warning'));
});

test('preflightRepositoryIntegration reuses generated targets that match the hash ledger', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-preflight-resume-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const preflight = await preflightRepositoryIntegration(manifest, { repoPath });

  assert.equal(preflight.status, 'passed');
  assert.equal(preflight.blocking_collisions.length, 0);
  assert.ok(preflight.reusable_targets.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(preflight.checks.some((check) => check.name === 'generated_targets_reusable' && check.status === 'passed'));
});

test('preflightRepositoryIntegration blocks drifted generated targets during resume', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-preflight-resume-drift-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'changed generated file\n');

  const preflight = await preflightRepositoryIntegration(manifest, { repoPath });

  assert.equal(preflight.status, 'failed');
  assert.deepEqual(preflight.blocking_collisions, ['src/integrations/acme-homepage-v1/template.html']);
  assert.ok(preflight.checks.some((check) => check.name === 'planned_targets_available' && check.status === 'failed'));
});

test('preflightRepositoryIntegration refuses missing duplicate sources before writes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-preflight-missing-source-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  manifest.repository.components_to_duplicate.push({
    source_path: 'src/components/MissingHero.jsx',
    target_path: 'src/integrations/acme-homepage-v1/components/HtsMissingHero.jsx'
  });

  const preflight = await preflightRepositoryIntegration(manifest, { repoPath });

  assert.equal(preflight.status, 'failed');
  assert.deepEqual(preflight.missing_sources, ['src/components/MissingHero.jsx']);
  assert.ok(preflight.checks.some((check) => check.name === 'duplicate_sources_available' && check.status === 'failed'));
});

test('runRepositoryScript supports dry-run build command discovery', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-build-'));
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node --version'
    }
  }));
  await writeFile(path.join(repoPath, 'package-lock.json'), '');

  const result = await runRepositoryScript({ repoPath, script: 'build', dryRun: true });

  assert.equal(result.dry_run, true);
  assert.equal(result.command, 'npm run build');
});
