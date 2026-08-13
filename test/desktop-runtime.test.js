import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createDesktopCliSpawnConfig,
  createDesktopRuntime,
  isInsideDesktopRuntimePath,
  isInsideRendererAppPath
} from '../src/desktop-runtime.js';

test('desktop runtime defaults writable work output to Electron userData', () => {
  const runtime = createDesktopRuntime({
    appRoot: '/Applications/HTML-to-Storyblok.app/Contents/Resources/app.asar',
    userDataPath: '/Users/adam/Library/Application Support/HTML-to-Storyblok'
  });

  assert.equal(runtime.app_root, '/Applications/HTML-to-Storyblok.app/Contents/Resources/app.asar');
  assert.equal(runtime.user_data_path, '/Users/adam/Library/Application Support/HTML-to-Storyblok');
  assert.equal(
    runtime.default_work_dir,
    '/Users/adam/Library/Application Support/HTML-to-Storyblok/workspaces/default/html-to-storyblok'
  );
  assert.equal(
    runtime.default_manifest_path,
    path.join(runtime.default_work_dir, 'integration-manifest.json')
  );
});

test('desktop runtime path checks allow app files and userData artifacts only', () => {
  const runtime = createDesktopRuntime({
    appRoot: '/app/root',
    userDataPath: '/user/data'
  });

  assert.equal(isInsideRendererAppPath('/app/root/desktop/renderer/index.html', runtime), true);
  assert.equal(isInsideRendererAppPath('/user/data/workspaces/default/html-to-storyblok/report.md', runtime), false);
  assert.equal(isInsideDesktopRuntimePath('/app/root/desktop/renderer/index.html', runtime), true);
  assert.equal(isInsideDesktopRuntimePath('/user/data/workspaces/default/html-to-storyblok/report.md', runtime), true);
  assert.equal(isInsideDesktopRuntimePath('/tmp/report.md', runtime), false);
});

test('desktop CLI spawn config runs Electron as Node for packaged runtime compatibility', () => {
  const runtime = createDesktopRuntime({
    appRoot: '/app/root',
    userDataPath: '/user/data'
  });
  const config = createDesktopCliSpawnConfig({
    electronExecPath: '/Applications/HTML-to-Storyblok.app/Contents/MacOS/HTML-to-Storyblok',
    binPath: '/app/root/bin/html-to-storyblok.js',
    builtCommand: {
      args: ['doctor', '--for', 'full-import', '--work-dir', runtime.default_work_dir],
      cwd: runtime.app_root
    },
    runtime,
    sessionEnv: {
      STORYBLOK_SPACE_ID: '12345'
    },
    baseEnv: {
      PATH: '/usr/bin'
    }
  });

  assert.equal(config.command, '/Applications/HTML-to-Storyblok.app/Contents/MacOS/HTML-to-Storyblok');
  assert.deepEqual(config.args, [
    '/app/root/bin/html-to-storyblok.js',
    'doctor',
    '--for',
    'full-import',
    '--work-dir',
    runtime.default_work_dir
  ]);
  assert.equal(config.options.cwd, runtime.app_root);
  assert.equal(config.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.options.env.STORYBLOK_SPACE_ID, '12345');
  assert.equal(config.options.env.PATH, '/usr/bin');
});
