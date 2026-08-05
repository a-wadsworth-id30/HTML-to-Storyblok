import { getNetlifyConfig } from './netlify.js';
import { getStoryblokConfig } from './storyblok.js';
import { envValue } from './utils.js';

export function checkLiveAccess(env = process.env) {
  const storyblok = getStoryblokConfig(env);
  const netlify = getNetlifyConfig(env);
  const githubToken = envValue(['GITHUB_TOKEN', 'GH_TOKEN'], env);
  return {
    storyblok: {
      ready: Boolean(storyblok.token && storyblok.spaceId),
      required_variable_names: ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_SPACE_ID'],
      optional_variable_names: ['STORYBLOK_REGION'],
      available_variable_names: Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name)).sort()
    },
    netlify: {
      ready: Boolean(netlify.token && netlify.siteId),
      required_variable_names: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
      available_variable_names: Object.keys(env).filter((name) => /NETLIFY/i.test(name)).sort()
    },
    github: {
      ready: Boolean(githubToken),
      required_variable_names: ['GITHUB_TOKEN'],
      alternative_variable_names: ['GH_TOKEN'],
      available_variable_names: Object.keys(env).filter((name) => /^GH_|^GITHUB_/i.test(name)).sort()
    },
    note: 'Secret values are intentionally omitted.'
  };
}
