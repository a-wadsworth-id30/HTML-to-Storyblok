import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envValue } from './utils.js';

const execFileAsync = promisify(execFile);

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
  wait = false,
  timeoutMs = 120_000,
  intervalMs = 5_000,
  includeLogs = false,
  logsSince = '1h',
  logsSource = 'deploy',
  repoPath = process.cwd(),
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
  const initialDeploy = selectDeploy(deployResult.deploys, { branch, deployId });
  const polling = wait && initialDeploy
    ? await pollDeployPreview({
      config,
      siteId: resolvedSiteId,
      branch,
      deployId: deployId || initialDeploy.id,
      initialDeploy,
      timeoutMs,
      intervalMs
    })
    : {
      waited: false,
      attempts: initialDeploy ? [initialDeploy] : [],
      timed_out: false
    };
  const deploy = polling.attempts.at(-1) || initialDeploy;
  const checks = [];
  addCheck(checks, 'deploy_found', Boolean(deploy), deploy ? 'Deploy preview found.' : 'No matching deploy preview found.');
  if (deploy) {
    addCheck(checks, 'branch_matches', !branch || deploy.branch === branch, branch ? `Expected branch ${branch}.` : 'No branch expectation supplied.', deploy.branch);
    addCheck(checks, 'context_matches', !expectedContext || deploy.context === expectedContext, `Expected context ${expectedContext}.`, deploy.context);
    addCheck(checks, 'deploy_terminal', !wait || isTerminalDeployState(deploy.state), 'Deploy should reach a terminal state before timeout.', deploy.state);
    addCheck(checks, 'deploy_ready', deploy.state === 'ready', 'Deploy state should be ready.', deploy.state);
    addCheck(checks, 'deploy_url_available', Boolean(deploy.deploy_url || deploy.url || deploy.review_url), 'Deploy preview URL should be present.', deploy.deploy_url || deploy.url || deploy.review_url || null);
    if (polling.timed_out) addCheck(checks, 'deploy_polling_timeout', false, `Deploy did not complete within ${timeoutMs}ms.`, deploy.state);
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
  const cliLogs = includeLogs && deploy
    ? await fetchNetlifyDeployLogsWithCli({
      deployUrl: deploy.deploy_url || deploy.url || deploy.review_url,
      source: logsSource,
      since: logsSince,
      repoPath,
      env
    })
    : {
      status: 'skipped',
      reason: 'Pass --include-logs to fetch a redacted Netlify CLI log snapshot.'
    };
  const failed = checks.filter((check) => check.status === 'failed');
  return {
    action: 'verify_netlify_deploy_preview',
    status: failed.length === 0 ? 'passed' : 'failed',
    site: summarizeSite(site),
    deploy,
    deploy_log: deploy ? summarizeDeployLog(site, deploy) : null,
    cli_logs: cliLogs,
    polling: summarizePolling(polling),
    checks,
    failed_checks: failed.length
  };
}

export async function fetchNetlifyDeployLogsWithCli({
  deployUrl,
  source = 'deploy',
  since = '1h',
  repoPath = process.cwd(),
  env = process.env,
  execFileImpl = execFileAsync
} = {}) {
  const config = getNetlifyConfig(env);
  if (!deployUrl) {
    return {
      action: 'fetch_netlify_deploy_logs',
      status: 'unavailable',
      reason: 'A deploy URL is required to fetch Netlify CLI logs.'
    };
  }
  if (!config.token) {
    return {
      action: 'fetch_netlify_deploy_logs',
      status: 'unavailable',
      reason: 'Set NETLIFY_AUTH_TOKEN to fetch Netlify CLI logs.'
    };
  }

  const sources = String(source || 'deploy').split(',').map((entry) => entry.trim()).filter(Boolean);
  const args = [
    'logs',
    ...sources.flatMap((entry) => ['--source', entry]),
    '--url',
    deployUrl,
    '--since',
    since || '1h',
    '--json'
  ];
  try {
    const { stdout, stderr } = await execFileImpl('netlify', args, {
      cwd: repoPath,
      env: {
        ...process.env,
        ...env,
        NETLIFY_AUTH_TOKEN: config.token
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000
    });
    const lines = parseJsonLines(stdout).map(redactLogEntry);
    return {
      action: 'fetch_netlify_deploy_logs',
      status: 'ok',
      source: sources,
      since,
      deploy_url: deployUrl,
      lines_returned: lines.length,
      lines: lines.slice(0, 100),
      truncated: lines.length > 100,
      stderr: redactText(stderr)
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        action: 'fetch_netlify_deploy_logs',
        status: 'unavailable',
        reason: 'Netlify CLI is not installed. Install netlify-cli to enable --include-logs.'
      };
    }
    return {
      action: 'fetch_netlify_deploy_logs',
      status: 'failed',
      reason: redactText(error.stderr || error.message || 'Netlify CLI logs command failed.'),
      exit_code: error.code ?? 1
    };
  }
}

async function pollDeployPreview({
  config,
  siteId,
  branch,
  deployId,
  initialDeploy,
  timeoutMs,
  intervalMs
}) {
  const attempts = [initialDeploy];
  const started = Date.now();
  while (!isTerminalDeployState(attempts.at(-1)?.state) && Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    const deploy = deployId
      ? summarizeDeploy(await netlifyRequest(config, `/sites/${siteId}/deploys/${deployId}`))
      : selectDeploy((await netlifyRequest(config, `/sites/${siteId}/deploys?${deployQuery(branch)}`)).map(summarizeDeploy), { branch });
    if (!deploy) break;
    attempts.push(deploy);
  }
  return {
    waited: true,
    attempts,
    timed_out: !isTerminalDeployState(attempts.at(-1)?.state)
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
    build_id: deploy.build_id || null,
    state: deploy.state,
    branch: deploy.branch,
    context: deploy.context,
    title: deploy.title,
    deploy_url: deploy.deploy_ssl_url || deploy.deploy_url,
    url: deploy.ssl_url || deploy.url,
    review_url: deploy.review_url,
    admin_url: deploy.admin_url || null,
    commit_ref: deploy.commit_ref,
    commit_url: deploy.commit_url || null,
    created_at: deploy.created_at,
    updated_at: deploy.updated_at,
    error_message: deploy.error_message || null,
    deploy_log_available_in_ui: Boolean(deploy.id),
    log_access_metadata_present: Boolean(deploy.log_access_attributes)
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

function summarizeDeployLog(site, deploy) {
  const siteName = site.name || deploy.name || null;
  return {
    deploy_log_url: siteName && deploy.id ? `https://app.netlify.com/sites/${siteName}/deploys/${deploy.id}` : deploy.admin_url || null,
    admin_url: deploy.admin_url || null,
    error_message: deploy.error_message || null,
    raw_log_api: 'not exposed by Netlify REST API; use Netlify UI or Netlify CLI logs for full deploy output',
    log_access_metadata_present: Boolean(deploy.log_access_metadata_present)
  };
}

function summarizePolling(polling) {
  return {
    waited: polling.waited,
    timed_out: polling.timed_out,
    attempts: polling.attempts.map((attempt) => ({
      deploy_id: attempt.id,
      state: attempt.state,
      updated_at: attempt.updated_at || null
    }))
  };
}

function deployQuery(branch) {
  const params = new URLSearchParams({ 'deploy-previews': 'true', per_page: '20' });
  if (branch) params.set('branch', branch);
  return params.toString();
}

function isTerminalDeployState(state) {
  return ['ready', 'error', 'failed', 'rejected', 'canceled', 'cancelled'].includes(String(state || '').toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function addCheck(checks, name, passed, message, observed = null) {
  checks.push({
    name,
    status: passed ? 'passed' : 'failed',
    message,
    observed
  });
}

function parseJsonLines(value) {
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { message: line };
    }
  });
}

function redactLogEntry(entry) {
  if (Array.isArray(entry)) return entry.map(redactLogEntry);
  if (entry && typeof entry === 'object') {
    return Object.fromEntries(Object.entries(entry).map(([key, value]) => [
      key,
      /token|secret|password|authorization|auth|key/i.test(key) ? '[REDACTED]' : redactLogEntry(value)
    ]));
  }
  if (typeof entry === 'string') return redactText(entry);
  return entry;
}

function redactText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|api[_-]?key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g, '[REDACTED]@')
    .slice(0, 12_000);
}
