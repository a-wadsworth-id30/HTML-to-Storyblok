import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from './utils.js';

export async function launchDesktopApp({ args = {}, cwd = process.cwd(), env = process.env } = {}) {
  const root = packageRoot();
  const electronBinary = electronBinaryPath(root);
  const entry = path.join(root, 'desktop/main.js');
  const result = {
    action: 'launch_desktop_app',
    status: 'ready',
    dry_run: Boolean(args.dry_run || args.print),
    cwd,
    entry,
    electron_binary: electronBinary,
    command: [electronBinary, entry]
  };

  if (args.dry_run || args.print) return result;

  if (!(await pathExists(electronBinary))) {
    throw new Error('Desktop app requires Electron. Run `npm install` first, then `html-to-storyblok desktop` or `npm run desktop`.');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [entry], {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({
        ...result,
        status: exitCode === 0 ? 'closed' : 'failed',
        exit_code: exitCode ?? (signal ? 1 : 0),
        signal: signal || null
      });
    });
  });
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function electronBinaryPath(root) {
  const executable = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(root, 'node_modules', '.bin', executable);
}
