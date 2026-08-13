import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  buildDesktopCommand,
  createDefaultDesktopState,
  desktopArtifactHints,
  getDesktopActions,
  redactDesktopOutput,
  sanitizeSessionEnv,
  visibleSessionEnvKeys
} from '../src/desktop-actions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(root, 'bin/html-to-storyblok.js');
const rendererPath = path.join(root, 'desktop/renderer/index.html');
const activeProcesses = new Map();

let mainWindow = null;

app.whenReady().then(() => {
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
      preload: path.join(root, 'desktop/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.loadFile(rendererPath);
  return window;
}

function registerIpc() {
  ipcMain.handle('desktop:bootstrap', async () => ({
    root,
    defaultState: createDefaultDesktopState({ cwd: root }),
    actions: getDesktopActions()
  }));

  ipcMain.handle('desktop:select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose Folder',
      defaultPath: options.defaultPath || root,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('desktop:preview-action', async (_event, payload = {}) => {
    const built = buildDesktopCommand(payload.actionId, payload.state);
    return {
      action: built.action,
      commandLine: built.commandLine,
      visibleSessionEnvKeys: visibleSessionEnvKeys(payload.sessionEnv || {})
    };
  });

  ipcMain.handle('desktop:run-action', async (event, payload = {}) => runAction(event, payload));
  ipcMain.handle('desktop:cancel-action', async (_event, requestId) => cancelAction(requestId));
  ipcMain.handle('desktop:read-artifacts', async (_event, payload = {}) => readArtifacts(payload.state));
  ipcMain.handle('desktop:open-artifact', async (_event, filePath) => openArtifact(filePath));
}

function runAction(event, payload = {}) {
  const built = buildDesktopCommand(payload.actionId, payload.state);
  const sessionEnv = sanitizeSessionEnv(payload.sessionEnv || {});
  const secretValues = Object.values(sessionEnv);
  const requestId = randomUUID();
  const child = spawn(process.execPath, [binPath, ...built.args], {
    cwd: built.cwd || root,
    env: {
      ...process.env,
      ...sessionEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

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
    const absolute = path.resolve(root, hint.path);
    if (!isSafeLocalPath(absolute) || !existsSync(absolute)) {
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
  const absolute = path.resolve(root, String(filePath || ''));
  if (!isSafeLocalPath(absolute) || !existsSync(absolute)) {
    return { status: 'missing' };
  }
  const error = await shell.openPath(absolute);
  return { status: error ? 'failed' : 'opened', error: error || null };
}

function isSafeLocalPath(filePath) {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function truncateContent(content, limit = 14000) {
  const value = String(content || '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}
