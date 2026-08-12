import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';

test('demo-sites-e2e CLI command runs local and live phases with consolidated evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-demo-sites-e2e-'));
  const fixture = await writeFixture({
    '/': '<!doctype html><html><body><span data-hts-storyblok-source="storyblok-draft" data-hts-storyblok-slug="acme-campaign-v1/home" hidden></span><main>Home</main></body></html>'
  });

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'demo-sites-e2e',
    '--site',
    'static',
    '--base-url',
    'https://static-demo.example.test',
    '--routes',
    '/',
    '--integration-id',
    'acme-campaign-v1',
    '--require-live',
    '--require-storyblok-draft',
    '--visual',
    '--fixture',
    fixture,
    '--work-dir',
    workDir,
    '--no-interactive'
  ]));
  const result = parseE2EJson(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'demo-sites-e2e-result.json'), 'utf8'));
  const report = await readFile(path.join(workDir, 'demo-sites-e2e-report.md'), 'utf8');

  assert.equal(result.action, 'test_demo_sites_e2e');
  assert.equal(result.status, 'passed');
  assert.equal(artifact.status, 'passed');
  assert.equal(result.phases.length, 2);
  assert.equal(result.summary.local_sites_checked, 1);
  assert.equal(result.summary.live_routes_checked, 1);
  assert.equal(result.summary.storyblok_draft_routes, 1);
  assert.equal(result.live.visual_summary.snapshots, 1);
  assert.match(report, /Demo Site End-to-End Deployment Evidence/);
  assert.match(report, /local_demo_matrix: passed/);
  assert.match(report, /live_deployment_preview: passed/);
  assert.match(report, /source=storyblok-draft/);
});

test('demo-sites-e2e JSON summary stays compact for CI output', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-demo-sites-e2e-summary-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'demo-sites-e2e',
    '--skip-local',
    '--skip-live',
    '--work-dir',
    workDir,
    '--json-summary',
    '--no-interactive'
  ]));
  const summary = JSON.parse(output);
  const artifact = JSON.parse(await readFile(path.join(workDir, 'demo-sites-e2e-result.json'), 'utf8'));

  assert.equal(summary.command, 'demo-sites-e2e');
  assert.equal(summary.status, 'skipped');
  assert.equal(summary.phases, 0);
  assert.equal(artifact.action, 'test_demo_sites_e2e');
  assert.equal(artifact.status, 'skipped');
});

async function writeFixture(content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hts-e2e-live-fixture-'));
  const filePath = path.join(directory, 'responses.json');
  await writeFile(filePath, JSON.stringify(content));
  return filePath;
}

function parseE2EJson(output) {
  const marker = '{\n  "action": "test_demo_sites_e2e"';
  const index = output.lastIndexOf(marker);
  assert.notEqual(index, -1);
  return JSON.parse(output.slice(index));
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
