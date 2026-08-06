import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathExists } from './utils.js';

const execFileAsync = promisify(execFile);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.astro', '.tmp']);

export async function discoverTemplates({
  templatesFolder = 'templates',
  cwd = process.cwd()
} = {}) {
  const root = path.resolve(cwd, templatesFolder);
  if (!(await pathExists(root))) return [];
  const entries = await safeReaddir(root);
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolutePath = path.join(root, entry.name);
    if (await containsHtmlFile(absolutePath)) {
      templates.push({
        name: entry.name,
        path: absolutePath,
        label: path.relative(cwd, absolutePath) || entry.name
      });
    }
  }
  return templates.sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverRepositories({
  cwd = process.cwd(),
  maxSiblings = 30
} = {}) {
  const root = path.resolve(cwd);
  const candidates = uniquePaths([
    root,
    path.dirname(root),
    ...(await siblingDirectories(path.dirname(root), maxSiblings))
  ]);
  const repositories = [];
  for (const candidate of candidates) {
    if (await isRepository(candidate)) {
      repositories.push({
        path: candidate,
        label: path.relative(root, candidate) || '.'
      });
    }
  }
  return repositories.sort((left, right) => scoreRepository(left.label) - scoreRepository(right.label) || left.label.localeCompare(right.label));
}

export async function isRepository(targetPath) {
  const absolutePath = path.resolve(targetPath);
  return Boolean(
    await pathExists(path.join(absolutePath, '.git')) ||
    await pathExists(path.join(absolutePath, 'package.json'))
  );
}

export async function getGitStatus(repoPath) {
  if (!(await pathExists(path.join(repoPath, '.git')))) {
    return {
      available: false,
      clean: true,
      changed_files: [],
      reason: 'No .git directory found.'
    };
  }
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: repoPath });
    const changedFiles = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      available: true,
      clean: changedFiles.length === 0,
      changed_files: changedFiles
    };
  } catch (error) {
    return {
      available: false,
      clean: false,
      changed_files: [],
      reason: error.message
    };
  }
}

async function siblingDirectories(parent, limit) {
  const entries = await safeReaddir(parent);
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .slice(0, limit)
    .map((entry) => path.join(parent, entry.name));
}

async function containsHtmlFile(root) {
  const entries = await safeReaddir(root);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) return true;
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      if (await containsHtmlFile(path.join(root, entry.name))) return true;
    }
  }
  return false;
}

async function safeReaddir(targetPath) {
  try {
    return await readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function uniquePaths(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function scoreRepository(label) {
  if (label === '.') return 0;
  if (label === '..') return 1;
  if (label.startsWith('../')) return 2;
  return 3;
}

export async function pathKind(targetPath) {
  try {
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) return 'directory';
    if (targetStat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}
