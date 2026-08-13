import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('desktop BrowserWindow keeps renderer privileges constrained', async () => {
  const mainSource = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');

  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.match(mainSource, /sandbox:\s*true/);
  assert.match(mainSource, /webSecurity:\s*true/);
  assert.match(mainSource, /allowRunningInsecureContent:\s*false/);
  assert.match(mainSource, /webviewTag:\s*false/);
});

test('desktop main process blocks unexpected navigation, windows, permissions, and untrusted IPC', async () => {
  const mainSource = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');

  assert.match(mainSource, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
  assert.match(mainSource, /setPermissionRequestHandler/);
  assert.match(mainSource, /callback\(false\)/);
  assert.match(mainSource, /will-navigate/);
  assert.match(mainSource, /requireTrustedSender/);
  assert.match(mainSource, /isTrustedSender/);
});

test('desktop renderer declares a restrictive content security policy', async () => {
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
});

test('desktop preload exposes a narrow sandbox-compatible bridge', async () => {
  const preloadSource = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

  assert.match(preloadSource, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preloadSource, /node:fs|child_process|shell|remote/);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*ipcRenderer/);
});
