import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { inspectTemplate } from '../src/inspectors.js';

test('template readiness classifies review warnings without blocking import', async () => {
  const inventory = await inspectTemplate('test/fixtures/basic-template');
  const readiness = inventory.template_readiness;

  assert.equal(readiness.action, 'template_readiness');
  assert.equal(readiness.status, 'warning');
  assert.equal(readiness.readiness_level, 'needs_review');
  assert.equal(readiness.summary.pages, 1);
  assert.equal(readiness.summary.missing_assets, 0);
  assert.ok(readiness.summary.external_scripts > 0);
  assert.ok(readiness.warnings.some((warning) => warning.id === 'editorial_field_hints'));
  assert.ok(readiness.warnings.some((warning) => warning.id === 'external_dependencies_reviewed'));
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.quality_profile.categories.length, 8);
  assert.match(readiness.quality_grade, /^[A-F]$/);
  assert.ok(readiness.quality_profile.risks.some((risk) => risk.id === 'editorial_model'));
});

test('template readiness blocks missing assets and unsafe local scripts', async () => {
  const templatePath = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-blocked-'));
  await writeFile(path.join(templatePath, 'index.html'), `
    <!doctype html>
    <html>
      <body>
        <main>
          <img src="./missing/hero.jpg">
          <script src="./behaviour.js"></script>
        </main>
      </body>
    </html>
  `);
  await writeFile(path.join(templatePath, 'behaviour.js'), 'eval("window.__unsafe = true");\n');

  const inventory = await inspectTemplate(templatePath);
  const readiness = inventory.template_readiness;

  assert.equal(readiness.status, 'failed');
  assert.equal(readiness.readiness_level, 'blocked');
  assert.equal(readiness.summary.missing_assets, 1);
  assert.equal(readiness.summary.unsafe_script_patterns, 1);
  assert.ok(readiness.quality_profile.categories.find((category) => category.id === 'asset_health').score < 75);
  assert.ok(readiness.quality_profile.categories.find((category) => category.id === 'javascript_safety').score < 75);
  assert.ok(readiness.blockers.some((blocker) => blocker.id === 'local_assets_resolved'));
  assert.ok(readiness.blockers.some((blocker) => blocker.id === 'script_behaviour_reviewed'));
  assert.ok(readiness.next_steps.some((step) => /missing assets/i.test(step)));
});

test('template-readiness command writes a dedicated readiness artifact', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-work-'));
  const output = await captureStdout(() => runCli([
    'template-readiness',
    '--template',
    'test/fixtures/basic-template',
    '--work-dir',
    workDir
  ]));
  const readiness = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'template-readiness.json'), 'utf8'));

  assert.equal(readiness.action, 'template_readiness');
  assert.equal(readiness.status, 'warning');
  assert.equal(artifact.summary.pages, 1);
  assert.equal(process.exitCode, undefined);
});

test('template-quality command writes category scoring and can enforce a minimum score', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-quality-work-'));
  const output = await captureStdout(() => runCli([
    'template-quality',
    '--template',
    'test/fixtures/basic-template',
    '--minimum-score',
    '10',
    '--work-dir',
    workDir
  ]));
  const quality = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'template-quality.json'), 'utf8'));

  assert.equal(quality.categories.length, 8);
  assert.equal(artifact.score, quality.score);
  assert.match(quality.grade, /^[A-F]$/);
  assert.equal(process.exitCode, undefined);
});

test('template-quality command exits nonzero below the required score', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-quality-minimum-work-'));
  await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'template-quality',
    '--template',
    'test/fixtures/basic-template',
    '--minimum-score',
    '100',
    '--work-dir',
    workDir
  ]));

  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

test('template-readiness command exits nonzero for blocked templates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-readiness-cli-blocked-'));
  const workDir = path.join(root, 'work');
  const templatePath = path.join(root, 'template');
  await mkdir(templatePath, { recursive: true });
  await writeFile(path.join(templatePath, 'index.html'), '<img src="./missing.svg"><script src="./unsafe.js"></script>');
  await writeFile(path.join(templatePath, 'unsafe.js'), 'document.write("<p>unsafe</p>");\n');

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'template-readiness',
    '--template',
    templatePath,
    '--work-dir',
    workDir
  ]));
  const readiness = JSON.parse(output);

  assert.equal(readiness.status, 'failed');
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

async function runCli(args) {
  process.exitCode = undefined;
  await main(['node', 'html-to-storyblok', ...args]);
  assert.equal(process.exitCode, undefined);
}

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
