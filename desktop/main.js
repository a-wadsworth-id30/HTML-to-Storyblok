import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import {
  buildDesktopCommand,
  createDefaultDesktopState,
  desktopArtifactHints,
  getDesktopActions,
  redactDesktopOutput,
  sanitizeSessionEnv,
  visibleSessionEnvKeys
} from '../src/desktop-actions.js';
import { createDesktopCliSpawnConfig, createDesktopRuntime, isInsideDesktopRuntimePath, isInsideRendererAppPath } from '../src/desktop-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(root, 'bin/html-to-storyblok.js');
const rendererPath = path.join(root, 'desktop/renderer/index.html');
const preloadPath = path.join(root, 'desktop/preload.cjs');
const activeProcesses = new Map();
const ALLOWED_ARTIFACT_NAMES = new Set(desktopArtifactHints().map((hint) => hint.name));
const IPC_CHANNELS = new Set([
  'desktop:bootstrap',
  'desktop:select-directory',
  'desktop:preview-action',
  'desktop:run-action',
  'desktop:cancel-action',
  'desktop:read-artifacts',
  'desktop:open-artifact'
]);

let mainWindow = null;
let runtime = null;

app.whenReady().then(async () => {
  runtime = createDesktopRuntime({
    appRoot: root,
    userDataPath: app.getPath('userData')
  });
  await ensureRuntimeDirectories(runtime);
  configureSecurityPolicy();
  mainWindow = createWindow();
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const child of activeProcesses.values()) child.kill('SIGTERM');
  activeProcesses.clear();
  if (process.platform !== 'darwin') app.quit();
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    title: 'HTML-to-Storyblok',
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl)) event.preventDefault();
  });
  window.loadFile(rendererPath);
  return window;
}

function registerIpc() {
  ipcMain.handle('desktop:bootstrap', requireTrustedSender(async () => ({
    root,
    runtime,
    defaultState: createDefaultDesktopState({
      cwd: runtime.app_root,
      workDir: runtime.default_work_dir,
      manifestPath: runtime.default_manifest_path,
      templatePath: runtime.default_template_path
    }),
    actions: getDesktopActions()
  })));

  ipcMain.handle('desktop:select-directory', requireTrustedSender(async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose Folder',
      defaultPath: options.defaultPath || root,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('desktop:preview-action', requireTrustedSender(async (_event, payload = {}) => {
    const built = buildDesktopCommand(payload.actionId, payload.state);
    return {
      action: built.action,
      commandLine: built.commandLine,
      visibleSessionEnvKeys: visibleSessionEnvKeys(payload.sessionEnv || {})
    };
  }));

  ipcMain.handle('desktop:run-action', requireTrustedSender(async (event, payload = {}) => runAction(event, payload)));
  ipcMain.handle('desktop:cancel-action', requireTrustedSender(async (_event, requestId) => cancelAction(requestId)));
  ipcMain.handle('desktop:read-artifacts', requireTrustedSender(async (_event, payload = {}) => readArtifacts(payload.state)));
  ipcMain.handle('desktop:open-artifact', requireTrustedSender(async (_event, filePath) => openArtifact(filePath)));
}

function runAction(event, payload = {}) {
  const built = buildDesktopCommand(payload.actionId, payload.state);
  const sessionEnv = sanitizeSessionEnv(payload.sessionEnv || {});
  const secretValues = Object.values(sessionEnv);
  const requestId = randomUUID();
  const spawnConfig = createDesktopCliSpawnConfig({
    electronExecPath: process.execPath,
    binPath,
    builtCommand: built,
    runtime,
    sessionEnv,
    baseEnv: process.env
  });
  const child = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);

  activeProcesses.set(requestId, child);
  event.sender.send('desktop:cli-event', {
    type: 'started',
    requestId,
    action: built.action,
    commandLine: built.commandLine,
    envKeys: Object.keys(sessionEnv).sort()
  });

  child.stdout.on('data', (chunk) => {
    event.sender.send('desktop:cli-event', {
      type: 'stdout',
      requestId,
      text: redactDesktopOutput(chunk.toString(), secretValues)
    });
  });

  child.stderr.on('data', (chunk) => {
    event.sender.send('desktop:cli-event', {
      type: 'stderr',
      requestId,
      text: redactDesktopOutput(chunk.toString(), secretValues)
    });
  });

  child.on('error', (error) => {
    activeProcesses.delete(requestId);
    event.sender.send('desktop:cli-event', {
      type: 'error',
      requestId,
      text: redactDesktopOutput(error.message || String(error), secretValues)
    });
  });

  child.on('close', (exitCode, signal) => {
    activeProcesses.delete(requestId);
    event.sender.send('desktop:cli-event', {
      type: 'closed',
      requestId,
      exitCode: exitCode ?? (signal ? 1 : 0),
      signal: signal || null
    });
  });

  return {
    requestId,
    commandLine: built.commandLine
  };
}

function cancelAction(requestId) {
  const child = activeProcesses.get(requestId);
  if (!child) return { status: 'not-running' };
  child.kill('SIGTERM');
  activeProcesses.delete(requestId);
  return { status: 'cancelled' };
}

async function readArtifacts(rawState = {}) {
  const state = rawState || {};
  const hints = desktopArtifactHints(state.workDir);
  const artifacts = [];
  for (const hint of hints) {
    const absolute = path.resolve(runtime.app_root, hint.path);
    if (!isInsideDesktopRuntimePath(absolute, runtime) || !existsSync(absolute)) {
      artifacts.push({ ...hint, exists: false, content: '' });
      continue;
    }
    const content = await readFile(absolute, 'utf8');
    artifacts.push({
      ...hint,
      path: absolute,
      exists: true,
      content: truncateContent(content)
    });
  }
  return artifacts;
}

async function openArtifact(filePath) {
  const absolute = path.resolve(runtime.app_root, String(filePath || ''));
  if (!isAllowedArtifactPath(absolute) || !existsSync(absolute)) {
    return { status: 'missing' };
  }
  const error = await shell.openPath(absolute);
  return { status: error ? 'failed' : 'opened', error: error || null };
}

function configureSecurityPolicy() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isAllowedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ')
        ]
      }
    });
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedRendererUrl(navigationUrl)) event.preventDefault();
    });
  });
}

function requireTrustedSender(handler) {
  return async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Blocked untrusted desktop IPC sender');
    }
    return handler(event, ...args);
  };
}

function isTrustedSender(event) {
  const channel = event?.channel;
  if (channel && !IPC_CHANNELS.has(channel)) return false;
  return isAllowedRendererUrl(event.senderFrame?.url || event.sender?.getURL?.() || '');
}

function isAllowedRendererUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'file:') return false;
    return isInsideRendererAppPath(fileURLToPath(parsed), runtime);
  } catch {
    return false;
  }
}

function isAllowedArtifactPath(filePath) {
  if (!isInsideDesktopRuntimePath(filePath, runtime)) return false;
  return ALLOWED_ARTIFACT_NAMES.has(path.basename(filePath));
}

async function ensureRuntimeDirectories(nextRuntime) {
  await mkdir(nextRuntime.default_work_dir, { recursive: true });
}

function truncateContent(content, limit = 14000) {
  const value = String(content || '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}
