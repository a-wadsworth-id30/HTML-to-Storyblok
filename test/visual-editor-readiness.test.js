import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createVisualEditorReadiness } from '../src/visual-editor-readiness.js';

test('createVisualEditorReadiness checks generated renderer, route, bridge, and preview evidence', async () => {
  const repoPath = await createVisualEditorRepo();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-visual-editor-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    repoPath,
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  const result = await createVisualEditorReadiness({
    manifest,
    repoPath,
    previewUrl: 'https://preview.example.com',
    workDir
  });
  const markdown = await readFile(result.markdown_report, 'utf8');

  assert.equal(result.action, 'visual_editor_readiness');
  assert.equal(result.status, 'warning');
  assert.ok(result.checks.some((check) => check.name === 'preview_url' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'editable_marker_preservation' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'integration_preview_root' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'route_handoff_preview' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'preview_bridge' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'iframe_security' && check.status === 'passed'));
  assert.ok(result.checks.some((check) => check.name === 'block_identity' && check.status === 'warning'));
  assert.match(markdown, /Storyblok Visual Editor Readiness/);
  assert.match(markdown, /Expected Handoff/);
});

test('visual-editor-readiness CLI command writes result and report artifacts', async () => {
  const repoPath = await createVisualEditorRepo();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-visual-editor-cli-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-cli-v1',
    templatePath: 'test/fixtures/basic-template',
    repoPath,
    framework: 'static'
  });
  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'visual-editor-readiness',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--preview-url',
    'https://preview.example.com',
    '--work-dir',
    workDir,
    '--json-summary',
    '--no-interactive'
  ]));
  const summary = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'visual-editor-readiness-result.json'), 'utf8'));

  assert.equal(summary.command, 'visual-editor-readiness');
  assert.equal(summary.status, 'warning');
  assert.equal(summary.warning_checks, 1);
  assert.equal(artifact.markdown_report, path.join(workDir, 'visual-editor-readiness-report.md'));
  assert.match(await readFile(path.join(workDir, 'visual-editor-readiness-report.md'), 'utf8'), /preview_bridge/);
});

test('createVisualEditorReadiness fails required non-HTTPS preview URLs', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const result = await createVisualEditorReadiness({
    manifest,
    previewUrl: 'http://preview.example.com',
    requirePreviewUrl: true
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check) => check.name === 'preview_url' && check.status === 'failed'));
});

async function createVisualEditorRepo() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-visual-editor-repo-'));
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await mkdir(path.join(repoPath, 'public'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'visual-editor-fixture',
    type: 'module',
    dependencies: {
      '@storyblok/js': '^3.0.0'
    }
  }, null, 2));
  await writeFile(path.join(repoPath, 'src/storyblok-preview.js'), 'import { useStoryblokBridge } from "@storyblok/js";\nuseStoryblokBridge("123");\n');
  await writeFile(path.join(repoPath, 'public/_headers'), '/*\n  Content-Security-Policy: frame-ancestors https://app.storyblok.com\n');
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
