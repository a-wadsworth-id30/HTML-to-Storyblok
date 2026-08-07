import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOTS = ['bin', 'src', 'test', 'scripts', 'demo-sites/scripts'];
const CHECKED_EXTENSIONS = new Set(['.js', '.mjs']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.tmp', 'dist', 'build', '.next', '.nuxt', '.astro']);

const root = process.cwd();
const files = [];
for (const entry of ROOTS) {
  await collectCheckableFiles(path.join(root, entry), files);
}

for (const file of files.sort()) {
  await execFileAsync(process.execPath, ['--check', file], {
    cwd: root,
    maxBuffer: 1024 * 1024
  });
}

console.log(`syntax check passed: ${files.length} files`);

async function collectCheckableFiles(current, output) {
  let entries = [];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectCheckableFiles(absolute, output);
    } else if (entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name))) {
      output.push(path.relative(root, absolute));
    }
  }
}
