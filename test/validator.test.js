import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { diffIntegration, runRepositoryScript, validateIntegration } from '../src/validator.js';

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
