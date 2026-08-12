import path from 'node:path';
import { getEnvironmentSources } from './env.js';
import { getNetlifyConfig } from './netlify.js';
import { getStoryblokConfig, getStoryblokContentConfig } from './storyblok.js';
import { envValue } from './utils.js';

export function checkLiveAccess(env = process.env) {
  const sources = getEnvironmentSources(env);
  const storyblok = getStoryblokConfig(env);
  const storyblokContent = getStoryblokContentConfig(env);
  const netlify = getNetlifyConfig(env);
  const githubToken = envValue(['GITHUB_TOKEN', 'GH_TOKEN'], env);
  const gitlabToken = envValue(['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN'], env);
  return {
    storyblok: {
      ready: Boolean(storyblok.token && storyblok.spaceId),
      required_variable_names: ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_SPACE_ID'],
      optional_variable_names: ['STORYBLOK_REGION'],
      available_variable_names: Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name)).sort(),
      credential_sources: credentialSources([
        ['Management token', ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_OAUTH_TOKEN', 'STORYBLOK_PERSONAL_ACCESS_TOKEN']],
        ['Space ID', ['STORYBLOK_SPACE_ID', 'SB_SPACE_ID']],
        ['Region', ['STORYBLOK_REGION']]
      ], env, sources)
    },
    storyblok_content: {
      ready: Boolean(storyblokContent.token),
      required_variable_names: ['STORYBLOK_PREVIEW_TOKEN'],
      alternative_variable_names: ['STORYBLOK_PUBLIC_TOKEN', 'STORYBLOK_DELIVERY_TOKEN'],
      optional_variable_names: ['STORYBLOK_REGION'],
      available_variable_names: Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name)).sort(),
      credential_sources: credentialSources([
        ['Preview token', ['STORYBLOK_PREVIEW_TOKEN', 'STORYBLOK_PUBLIC_TOKEN', 'STORYBLOK_DELIVERY_TOKEN']],
        ['Region', ['STORYBLOK_REGION']]
      ], env, sources)
    },
    netlify: {
      ready: Boolean(netlify.token && netlify.siteId),
      required_variable_names: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
      available_variable_names: Object.keys(env).filter((name) => /NETLIFY/i.test(name)).sort(),
      credential_sources: credentialSources([
        ['Auth token', ['NETLIFY_AUTH_TOKEN', 'NETLIFY_TOKEN']],
        ['Site ID', ['NETLIFY_SITE_ID']]
      ], env, sources)
    },
    github: {
      ready: Boolean(githubToken),
      required_variable_names: ['GITHUB_TOKEN'],
      alternative_variable_names: ['GH_TOKEN'],
      available_variable_names: Object.keys(env).filter((name) => /^GH_|^GITHUB_/i.test(name)).sort(),
      credential_sources: credentialSources([
        ['API token', ['GITHUB_TOKEN', 'GH_TOKEN']]
      ], env, sources)
    },
    gitlab: {
      ready: Boolean(gitlabToken),
      required_variable_names: ['GITLAB_TOKEN'],
      alternative_variable_names: ['GITLAB_PRIVATE_TOKEN'],
      optional_variable_names: ['GITLAB_BASE_URL'],
      available_variable_names: Object.keys(env).filter((name) => /^GITLAB_/i.test(name)).sort(),
      credential_sources: credentialSources([
        ['API token', ['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN']],
        ['Base URL', ['GITLAB_BASE_URL']]
      ], env, sources)
    },
    note: 'Secret values are intentionally omitted.'
  };
}

function credentialSources(entries, env, sources) {
  return entries.map(([label, names]) => {
    const variable = resolvedVariableName(names, env);
    const configured = Boolean(variable && env[variable]);
    return {
      label,
      variable: variable || names[0],
      configured,
      source: variable ? sourceLabel(sources[variable]) : 'not configured'
    };
  });
}

function resolvedVariableName(names, env) {
  return names.find((name) => env[name]) || names.find((name) => env[name] !== undefined) || null;
}

function sourceLabel(source) {
  if (!source) return 'unknown';
  if (source.source === 'env_file') return `env file ${path.basename(source.file || '.env')}`;
  if (source.source === 'profile') return 'settings profile';
  if (source.source === 'session') return 'session prompt';
  if (source.source === 'shell') return 'shell';
  return source.source || 'unknown';
}
