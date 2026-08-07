import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, unique } from './utils.js';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];

export async function loadEnvironment({
  cwd = process.cwd(),
  repoPath = null,
  env = process.env,
  config = {}
} = {}) {
  const fileEnv = {};
  const filesLoaded = [];
  const directories = unique([
    cwd ? path.resolve(cwd) : null,
    repoPath ? path.resolve(cwd, repoPath) : null
  ]);

  for (const directory of directories) {
    for (const name of DEFAULT_ENV_FILES) {
      const filePath = path.join(directory, name);
      if (!(await pathExists(filePath))) continue;
      Object.assign(fileEnv, parseDotEnv(await readFile(filePath, 'utf8')));
      filesLoaded.push(filePath);
    }
  }

  const merged = {
    ...fileEnv,
    ...env
  };
  if (!merged.STORYBLOK_REGION && config.storyblok_region) {
    merged.STORYBLOK_REGION = config.storyblok_region;
  }
  if (!merged.STORYBLOK_SPACE_ID && !merged.SB_SPACE_ID && config.storyblok_space_id) {
    merged.STORYBLOK_SPACE_ID = config.storyblok_space_id;
  }

  return {
    env: merged,
    files_loaded: filesLoaded,
    variables_loaded: Object.keys(fileEnv)
      .filter((key) => env[key] === undefined)
      .sort()
  };
}

export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

function parseDotEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    return quote === '"' ? unescapeDoubleQuoted(value) : value;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function unescapeDoubleQuoted(value) {
  return value
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}
