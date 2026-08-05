import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replaceAll('-', '_');
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function commandName(argv) {
  return argv[2] || 'help';
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmpPath, filePath);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function relativeTo(base, filePath) {
  return path.relative(base, filePath).split(path.sep).join('/');
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function requireOption(args, name) {
  if (!args[name]) {
    throw new Error(`missing required option --${name.replaceAll('_', '-')}`);
  }
  return String(args[name]);
}

export function nowIso() {
  return new Date().toISOString();
}
