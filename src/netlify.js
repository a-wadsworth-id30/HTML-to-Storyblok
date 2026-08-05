import { envValue } from './utils.js';

export function getNetlifyConfig(env = process.env) {
  return {
    token: envValue(['NETLIFY_AUTH_TOKEN', 'NETLIFY_TOKEN'], env),
    siteId: envValue(['NETLIFY_SITE_ID'], env),
    baseUrl: 'https://api.netlify.com/api/v1'
  };
}

export async function queryNetlifyDeployPreviews({ siteId, branch, deployId, env = process.env } = {}) {
  const config = getNetlifyConfig(env);
  const resolvedSiteId = siteId || config.siteId;
  if (!config.token) {
    return {
      status: 'unavailable',
      reason: 'Set NETLIFY_AUTH_TOKEN to query Netlify deploy previews.'
    };
  }
  if (!resolvedSiteId) {
    return {
      status: 'unavailable',
      reason: 'Pass --site-id or set NETLIFY_SITE_ID.'
    };
  }

  if (deployId) {
    const deploy = await netlifyRequest(config, `/sites/${resolvedSiteId}/deploys/${deployId}`);
    return {
      status: 'ok',
      site_id: resolvedSiteId,
      deploys: [summarizeDeploy(deploy)]
    };
  }

  const params = new URLSearchParams({ 'deploy-previews': 'true', per_page: '20' });
  if (branch) params.set('branch', branch);
  const deploys = await netlifyRequest(config, `/sites/${resolvedSiteId}/deploys?${params}`);
  return {
    status: 'ok',
    site_id: resolvedSiteId,
    deploys: deploys.map(summarizeDeploy)
  };
}

async function netlifyRequest(config, endpoint) {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Netlify GET ${endpoint} failed with ${response.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

function summarizeDeploy(deploy) {
  return {
    id: deploy.id,
    site_id: deploy.site_id,
    state: deploy.state,
    branch: deploy.branch,
    context: deploy.context,
    title: deploy.title,
    deploy_url: deploy.deploy_ssl_url || deploy.deploy_url,
    url: deploy.ssl_url || deploy.url,
    review_url: deploy.review_url,
    commit_ref: deploy.commit_ref,
    created_at: deploy.created_at,
    updated_at: deploy.updated_at,
    error_message: deploy.error_message || null
  };
}

