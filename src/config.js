import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists, writeJson } from './utils.js';

export const DEFAULT_CONFIG = {
  default_repository: '',
  templates_folder: 'templates',
  storyblok_region: 'eu',
  preferred_framework: 'auto',
  default_output_folder: '.tmp/html-to-storyblok',
  color_mode: 'auto',
  verbose_logging: false
};

export function defaultConfigPath(env = process.env) {
  const home = env.HTML_TO_STORYBLOK_HOME || os.homedir();
  return path.join(home, '.html-to-storyblok', 'config.json');
}

export async function loadConfig({ configPath = defaultConfigPath() } = {}) {
  if (!(await pathExists(configPath))) {
    return { ...DEFAULT_CONFIG, config_path: configPath };
  }
  const content = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(content);
  return sanitizeConfig({ ...DEFAULT_CONFIG, ...parsed, config_path: configPath });
}

export async function saveConfig(config, { configPath = config.config_path || defaultConfigPath() } = {}) {
  const sanitized = sanitizeConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeJson(configPath, withoutRuntimeFields(sanitized));
  return { ...sanitized, config_path: configPath };
}

export function updateConfigValue(config, key, value) {
  if (!Object.hasOwn(DEFAULT_CONFIG, key)) {
    throw new Error(`unknown setting: ${key}`);
  }
  return sanitizeConfig({
    ...config,
    [key]: coerceSettingValue(key, value)
  });
}

export function parseSettingAssignment(value) {
  const [key, ...rest] = String(value).split('=');
  if (!key || rest.length === 0) {
    throw new Error('settings --set expects key=value');
  }
  return { key: key.trim(), value: rest.join('=').trim() };
}

function sanitizeConfig(config) {
  const sanitized = {
    ...DEFAULT_CONFIG,
    ...config
  };
  for (const key of Object.keys(sanitized)) {
    if (/token|secret|password|key/i.test(key)) delete sanitized[key];
  }
  if (!['auto', 'always', 'never'].includes(sanitized.color_mode)) sanitized.color_mode = 'auto';
  if (!['auto', 'astro', 'react', 'next', 'vue', 'nuxt', 'static'].includes(sanitized.preferred_framework)) sanitized.preferred_framework = 'auto';
  if (!['eu', 'us', 'ca', 'ap', 'cn'].includes(sanitized.storyblok_region)) sanitized.storyblok_region = 'eu';
  sanitized.verbose_logging = Boolean(sanitized.verbose_logging);
  return sanitized;
}

function withoutRuntimeFields(config) {
  const { config_path: _configPath, ...persisted } = config;
  return persisted;
}

function coerceSettingValue(key, value) {
  if (key === 'verbose_logging') return /^(1|true|yes|on)$/i.test(String(value));
  return String(value);
}
