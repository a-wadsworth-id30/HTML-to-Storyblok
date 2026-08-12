import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';

test('global help advertises focused command guides', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-help-global-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    '--help',
    '--work-dir',
    workDir
  ]));

  assert.match(output, /html-to-storyblok help <topic>/);
  assert.match(output, /Available help topics:/);
  assert.match(output, /storyblok/);
  assert.match(output, /repository/);
});

test('command --help prints contextual command guidance', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-help-plan-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'plan',
    '--help',
    '--work-dir',
    workDir
  ]));

  assert.match(output, /Plan/);
  assert.match(output, /Creates the additive integration manifest/);
  assert.match(output, /Next Commands/);
  assert.match(output, /validate-plan/);
  assert.doesNotMatch(output, /unknown command/);
});

test('help command prints workflow topic guidance', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-help-storyblok-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'help',
    'storyblok',
    '--work-dir',
    workDir
  ]));

  assert.match(output, /Storyblok Workflow/);
  assert.match(output, /storyblok-preflight/);
  assert.match(output, /storyblok-apply --manifest <path> --dry-run/);
  assert.match(output, /draft-only/);
});

test('help command lists available topics for unknown guides', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-help-unknown-'));
  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'help',
    'not-a-guide',
    '--work-dir',
    workDir
  ]));

  assert.match(output, /No dedicated help guide exists for "not-a-guide"/);
  assert.match(output, /Available help topics:/);
  assert.match(output, /demo-sites-live-preview/);
});

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
