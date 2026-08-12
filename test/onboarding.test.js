import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { createOnboardingGuide } from '../src/onboarding.js';

test('onboarding guide reports a ready full-import setup without exposing secrets', async () => {
  const root = await createOnboardingWorkspace();
  const config = {
    config_path: path.join(root, 'config.json'),
    templates_folder: 'templates',
    default_repository: 'client-site',
    storyblok_region: 'eu',
    default_output_folder: 'work'
  };
  const guide = await createOnboardingGuide({
    cwd: root,
    config,
    configExists: true,
    workDir: 'work',
    env: {
      STORYBLOK_MANAGEMENT_TOKEN: 'management-secret',
      STORYBLOK_SPACE_ID: '12345',
      STORYBLOK_PREVIEW_TOKEN: 'preview-secret',
      NETLIFY_AUTH_TOKEN: 'netlify-secret',
      NETLIFY_SITE_ID: 'site-123',
      GITHUB_TOKEN: 'github-secret'
    }
  });

  assert.equal(guide.status, 'ready');
  assert.equal(guide.recommended_action, 'Import Template Into Existing Site');
  assert.equal(guide.discovery.templates_found, 1);
  assert.equal(guide.discovery.default_repository_detected, true);
  assert.equal(guide.credentials.storyblok_management_ready, true);
  assert.equal(guide.credentials.storyblok_preview_ready, true);
  assert.equal(guide.credentials.netlify_ready, true);
  assert.equal(guide.workflows.find((workflow) => workflow.id === 'full_import').ready, true);
  const serialized = JSON.stringify(guide);
  assert.doesNotMatch(serialized, /management-secret|preview-secret|netlify-secret|github-secret/);
});

test('onboarding guide gives setup steps when the workstation is incomplete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-onboarding-empty-'));
  const guide = await createOnboardingGuide({
    cwd: root,
    config: {
      config_path: path.join(root, 'config.json'),
      templates_folder: 'templates',
      default_output_folder: 'work'
    },
    configExists: false,
    workDir: 'work',
    env: {}
  });

  assert.equal(guide.status, 'needs_setup');
  assert.equal(guide.first_run, true);
  assert.equal(guide.recommended_action, 'Set Up Credentials And Defaults');
  assert.equal(guide.discovery.templates_found, 0);
  assert.equal(guide.credentials.storyblok_management_ready, false);
  assert.ok(guide.next_steps.some((step) => step.includes('html-to-storyblok env --init')));
  assert.ok(guide.next_steps.some((step) => step.includes('templates/<template-name>')));
});

test('onboarding command prints a redacted guide and writes evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-onboarding-command-'));
  const workDir = path.join(root, 'work');
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    templates_folder: 'templates',
    default_output_folder: workDir
  }, null, 2));

  const previousManagementToken = process.env.STORYBLOK_MANAGEMENT_TOKEN;
  const previousSpaceId = process.env.STORYBLOK_SPACE_ID;
  process.env.STORYBLOK_MANAGEMENT_TOKEN = 'command-management-secret';
  process.env.STORYBLOK_SPACE_ID = '12345';
  try {
    const output = await captureStdout(async () => {
      await main([
        'node',
        'html-to-storyblok',
        'onboarding',
        '--config',
        configPath,
        '--work-dir',
        workDir,
        '--no-interactive'
      ]);
    });

    assert.match(output, /HTML -> Storyblok Onboarding/);
    assert.match(output, /Secrets: omitted/);
    assert.doesNotMatch(output, /command-management-secret/);
    const artifact = JSON.parse(await readFile(path.join(workDir, 'onboarding-guide.json'), 'utf8'));
    assert.equal(artifact.action, 'onboarding');
    assert.doesNotMatch(JSON.stringify(artifact), /command-management-secret/);
  } finally {
    restoreEnv('STORYBLOK_MANAGEMENT_TOKEN', previousManagementToken);
    restoreEnv('STORYBLOK_SPACE_ID', previousSpaceId);
  }
});

async function createOnboardingWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-onboarding-'));
  const templatePath = path.join(root, 'templates/acme-homepage');
  const repoPath = path.join(root, 'client-site');
  await mkdir(templatePath, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(templatePath, 'index.html'), '<!doctype html><html><head><title>Acme</title></head><body><h1>Acme</h1></body></html>');
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'client-site',
    dependencies: {
      astro: '^5.0.0',
      '@storyblok/astro': '^6.0.0'
    }
  }, null, 2));
  return root;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function captureStdout(callback) {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  process.stdout.write = (chunk, encoding, callback_) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback_ === 'function') callback_();
    return true;
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return output.trim();
}
