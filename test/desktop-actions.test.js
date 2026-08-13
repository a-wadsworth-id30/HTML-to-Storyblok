import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDesktopCommand,
  createDefaultDesktopState,
  getDesktopActions,
  missingRequirements,
  redactDesktopOutput,
  sanitizeSessionEnv,
  visibleSessionEnvKeys
} from '../src/desktop-actions.js';

test('desktop actions expose safe grouped metadata without arbitrary shell commands', () => {
  const actions = getDesktopActions();
  assert.ok(actions.length >= 20);
  assert.ok(actions.some((action) => action.id === 'fullApply'));
  assert.ok(actions.some((action) => action.id === 'storyblokApply'));
  assert.ok(actions.every((action) => action.command && !/[;&|]/.test(action.command)));
  assert.deepEqual(missingRequirements('inspectTemplate', { templatePath: '' }), ['templatePath']);
});

test('desktop command builder creates full plan arguments from structured state', () => {
  const command = buildDesktopCommand('planFull', {
    ...createDefaultDesktopState({ cwd: '/project' }),
    workDir: '.tmp/html-to-storyblok',
    templatePath: 'templates/acme-campaign',
    repoPath: '../client-site',
    integrationId: 'Acme-Campaign-V1',
    framework: 'auto'
  });

  assert.deepEqual(command.args, [
    'plan',
    '--integration-id',
    'acme-campaign-v1',
    '--template',
    'templates/acme-campaign',
    '--repo',
    '../client-site',
    '--framework',
    'auto',
    '--work-dir',
    '.tmp/html-to-storyblok'
  ]);
  assert.match(command.commandLine, /html-to-storyblok plan/);
});

test('desktop default state accepts a portable runtime work directory', () => {
  const state = createDefaultDesktopState({
    cwd: '/app/root',
    workDir: '/user/data/workspaces/default/html-to-storyblok',
    templatePath: '/app/root/templates/acme-campaign'
  });

  assert.equal(state.cwd, '/app/root');
  assert.equal(state.workDir, '/user/data/workspaces/default/html-to-storyblok');
  assert.equal(state.manifestPath, '/user/data/workspaces/default/html-to-storyblok/integration-manifest.json');
  assert.equal(state.templatePath, '/app/root/templates/acme-campaign');
});

test('desktop command builder requires repository for full apply but not Storyblok-only dry run', () => {
  assert.throws(() => buildDesktopCommand('fullDryRun', {
    manifestPath: '.tmp/html-to-storyblok/integration-manifest.json'
  }), /target repository/);

  const command = buildDesktopCommand('storyblokDryRun', {
    manifestPath: '.tmp/html-to-storyblok/integration-manifest.json',
    workDir: '.tmp/html-to-storyblok'
  });
  assert.deepEqual(command.args, [
    'storyblok-apply',
    '--manifest',
    '.tmp/html-to-storyblok/integration-manifest.json',
    '--dry-run',
    '--work-dir',
    '.tmp/html-to-storyblok'
  ]);
});

test('desktop session env allows known credentials only and redacts output', () => {
  const env = sanitizeSessionEnv({
    storyblokManagementToken: 'management-secret',
    storyblokSpaceId: '12345',
    storyblokPreviewToken: 'preview-secret',
    storyblokRegion: 'eu',
    arbitrary: 'nope'
  });

  assert.deepEqual(Object.keys(env).sort(), [
    'STORYBLOK_MANAGEMENT_TOKEN',
    'STORYBLOK_PREVIEW_TOKEN',
    'STORYBLOK_REGION',
    'STORYBLOK_SPACE_ID'
  ]);
  assert.equal(env.arbitrary, undefined);
  assert.deepEqual(visibleSessionEnvKeys({ storyblokManagementToken: 'abc12345' }), ['STORYBLOK_MANAGEMENT_TOKEN']);
  assert.equal(
    redactDesktopOutput('token=management-secret Bearer preview-secret', Object.values(env)),
    'token=[REDACTED] Bearer [REDACTED]'
  );
});
