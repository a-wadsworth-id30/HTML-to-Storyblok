import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReadinessHandoff } from '../src/readiness.js';

test('createReadinessHandoff writes a consolidated agency handoff report', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-work-'));
  const repoPath = await createRepositoryFixture();
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const result = await createReadinessHandoff({
    manifest,
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    workDir,
    env: {}
  });
  const markdown = await readFile(result.markdown_report, 'utf8');

  assert.equal(result.action, 'readiness_handoff');
  assert.equal(result.status, 'warning');
  assert.equal(result.integration_id, 'acme-homepage-v1');
  assert.ok(result.sections.some((section) => section.name === 'Plan Validation' && section.status === 'passed'));
  assert.ok(result.sections.some((section) => section.name === 'Credential Readiness' && section.status === 'warning'));
  assert.match(markdown, /HTML-to-Storyblok Readiness Handoff/);
  assert.match(markdown, /Rollback Command/);
});

test('readiness CLI command writes result and markdown report artifacts', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-cli-work-'));
  const repoPath = await createRepositoryFixture();
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'readiness',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--template',
    'test/fixtures/basic-template',
    '--work-dir',
    workDir,
    '--no-interactive'
  ]));
  const result = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'readiness-result.json'), 'utf8'));

  assert.equal(result.action, 'readiness_handoff');
  assert.equal(artifact.action, 'readiness_handoff');
  assert.equal(artifact.markdown_report, path.join(workDir, 'readiness-report.md'));
  assert.match(await readFile(path.join(workDir, 'readiness-report.md'), 'utf8'), /Repository Safety/);
});

async function createRepositoryFixture() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-repo-'));
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'readiness-fixture',
    type: 'module',
    scripts: {
      build: 'node -e "process.exit(0)"'
    },
    dependencies: {
      '@storyblok/astro': '^6.0.0'
    }
  }, null, 2));
  await writeFile(path.join(repoPath, 'src/storyblok.js'), 'export const STORYBLOK_TOKEN = import.meta.env.STORYBLOK_TOKEN;\n');
  return repoPath;
}

async function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, done) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof done === 'function') done();
    return true;
  };
  try {
    await callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
