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
  verbose_logging: false,
  active_profile: '',
  project_profiles: {}
};

const PROFILE_SETTING_KEYS = [
  'default_repository',
  'templates_folder',
  'storyblok_region',
  'preferred_framework',
  'default_output_folder',
  'color_mode',
  'verbose_logging'
];

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
  return applyActiveProfile(sanitizeConfig({ ...DEFAULT_CONFIG, ...parsed, config_path: configPath }));
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
  if (key === 'project_profiles') {
    throw new Error('project_profiles must be edited through profile settings');
  }
  return sanitizeConfig({
    ...config,
    [key]: coerceSettingValue(key, value)
  });
}

export function updateProfileValue(config, profileName, key, value) {
  const normalizedProfile = normalizeProfileName(profileName);
  if (!normalizedProfile) throw new Error('profile name is required');
  if (!PROFILE_SETTING_KEYS.includes(key)) {
    throw new Error(`unknown profile setting: ${key}`);
  }
  const profiles = sanitizeProfiles(config.project_profiles);
  const existing = profiles[normalizedProfile] || {};
  return sanitizeConfig({
    ...config,
    project_profiles: {
      ...profiles,
      [normalizedProfile]: sanitizeProfile({
        ...existing,
        [key]: coerceSettingValue(key, value)
      })
    }
  });
}

export function profileNames(config) {
  return Object.keys(sanitizeProfiles(config.project_profiles)).sort();
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
  sanitized.active_profile = normalizeProfileName(sanitized.active_profile);
  sanitized.project_profiles = sanitizeProfiles(sanitized.project_profiles);
  return sanitized;
}

function withoutRuntimeFields(config) {
  const { config_path: _configPath, profile_applied: _profileApplied, ...persisted } = config;
  return persisted;
}

function coerceSettingValue(key, value) {
  if (key === 'verbose_logging') return /^(1|true|yes|on)$/i.test(String(value));
  return String(value);
}

function applyActiveProfile(config) {
  const profiles = sanitizeProfiles(config.project_profiles);
  const active = config.active_profile && profiles[config.active_profile] ? config.active_profile : '';
  if (!active) {
    return {
      ...config,
      active_profile: ''
    };
  }
  return sanitizeConfig({
    ...config,
    ...profiles[active],
    active_profile: active,
    project_profiles: profiles,
    profile_applied: active
  });
}

function sanitizeProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return {};
  const sanitized = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const profileName = normalizeProfileName(name);
    if (!profileName || !profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    sanitized[profileName] = sanitizeProfile(profile);
  }
  return sanitized;
}

function sanitizeProfile(profile) {
  const sanitized = {};
  for (const key of PROFILE_SETTING_KEYS) {
    if (!Object.hasOwn(profile, key)) continue;
    if (/token|secret|password|key/i.test(key)) continue;
    sanitized[key] = coerceSettingValue(key, profile[key]);
  }
  if (sanitized.color_mode && !['auto', 'always', 'never'].includes(sanitized.color_mode)) delete sanitized.color_mode;
  if (sanitized.preferred_framework && !['auto', 'astro', 'react', 'next', 'vue', 'nuxt', 'static'].includes(sanitized.preferred_framework)) delete sanitized.preferred_framework;
  if (sanitized.storyblok_region && !['eu', 'us', 'ca', 'ap', 'cn'].includes(sanitized.storyblok_region)) delete sanitized.storyblok_region;
  return sanitized;
}

function normalizeProfileName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
