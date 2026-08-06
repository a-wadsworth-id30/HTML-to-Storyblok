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

export async function verifyNetlifyDeployPreview({
  siteId,
  branch,
  deployId,
  expectedBuildCommand,
  expectedPublishDirectory,
  expectedContext = 'deploy-preview',
  env = process.env
} = {}) {
  const config = getNetlifyConfig(env);
  const resolvedSiteId = siteId || config.siteId;
  if (!config.token) {
    return {
      status: 'unavailable',
      reason: 'Set NETLIFY_AUTH_TOKEN to verify Netlify deploy previews.'
    };
  }
  if (!resolvedSiteId) {
    return {
      status: 'unavailable',
      reason: 'Pass --site-id or set NETLIFY_SITE_ID.'
    };
  }

  const [site, deployResult] = await Promise.all([
    netlifyRequest(config, `/sites/${resolvedSiteId}`),
    queryNetlifyDeployPreviews({ siteId: resolvedSiteId, branch, deployId, env })
  ]);
  const deploy = selectDeploy(deployResult.deploys, { branch, deployId });
  const checks = [];
  addCheck(checks, 'deploy_found', Boolean(deploy), deploy ? 'Deploy preview found.' : 'No matching deploy preview found.');
  if (deploy) {
    addCheck(checks, 'branch_matches', !branch || deploy.branch === branch, branch ? `Expected branch ${branch}.` : 'No branch expectation supplied.', deploy.branch);
    addCheck(checks, 'context_matches', !expectedContext || deploy.context === expectedContext, `Expected context ${expectedContext}.`, deploy.context);
    addCheck(checks, 'deploy_ready', deploy.state === 'ready', 'Deploy state should be ready.', deploy.state);
    addCheck(checks, 'deploy_url_available', Boolean(deploy.deploy_url || deploy.url || deploy.review_url), 'Deploy preview URL should be present.', deploy.deploy_url || deploy.url || deploy.review_url || null);
  }
  const buildSettings = site.build_settings || {};
  const observedBuildCommand = buildSettings.cmd || site.build_command || null;
  const observedPublishDirectory = buildSettings.dir || buildSettings.publish || site.publish || null;
  if (expectedBuildCommand) {
    addCheck(checks, 'build_command_matches', observedBuildCommand === expectedBuildCommand, `Expected build command ${expectedBuildCommand}.`, observedBuildCommand);
  }
  if (expectedPublishDirectory) {
    addCheck(checks, 'publish_directory_matches', observedPublishDirectory === expectedPublishDirectory, `Expected publish directory ${expectedPublishDirectory}.`, observedPublishDirectory);
  }
  const failed = checks.filter((check) => check.status === 'failed');
  return {
    action: 'verify_netlify_deploy_preview',
    status: failed.length === 0 ? 'passed' : 'failed',
    site: summarizeSite(site),
    deploy,
    checks,
    failed_checks: failed.length
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

function summarizeSite(site) {
  const buildSettings = site.build_settings || {};
  return {
    id: site.id,
    name: site.name,
    url: site.ssl_url || site.url,
    account_slug: site.account_slug || null,
    repo_url: buildSettings.repo_url || null,
    production_branch: buildSettings.repo_branch || site.repo_branch || null,
    build_command: buildSettings.cmd || site.build_command || null,
    publish_directory: buildSettings.dir || buildSettings.publish || site.publish || null
  };
}

function selectDeploy(deploys, { branch, deployId }) {
  if (deployId) return deploys.find((deploy) => deploy.id === deployId) || null;
  if (branch) return deploys.find((deploy) => deploy.branch === branch) || null;
  return deploys[0] || null;
}

function addCheck(checks, name, passed, message, observed = null) {
  checks.push({
    name,
    status: passed ? 'passed' : 'failed',
    message,
    observed
  });
}
