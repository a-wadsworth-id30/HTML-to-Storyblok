import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchNetlifyDeployLogsWithCli, verifyNetlifyDeployPreview } from '../src/netlify.js';

test('verifyNetlifyDeployPreview validates deploy state and build settings', async () => {
  mockFetch((url) => {
    if (url.endsWith('/sites/site-123')) {
      return {
        id: 'site-123',
        name: 'client-site',
        ssl_url: 'https://client-site.netlify.app',
        build_settings: {
          repo_branch: 'main',
          cmd: 'npm run build',
          dir: 'dist',
          repo_url: 'https://github.com/example/client-site'
        }
      };
    }
    assert.match(url, /deploys/);
    return [
      {
        id: 'deploy-1',
        site_id: 'site-123',
        state: 'ready',
        branch: 'feature/html-template',
        context: 'deploy-preview',
        deploy_ssl_url: 'https://deploy-preview-1.netlify.app'
      }
    ];
  });

  const result = await verifyNetlifyDeployPreview({
    siteId: 'site-123',
    branch: 'feature/html-template',
    expectedBuildCommand: 'npm run build',
    expectedPublishDirectory: 'dist',
    env: {
      NETLIFY_AUTH_TOKEN: 'netlify-token'
    }
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.deploy.id, 'deploy-1');
  assert.equal(result.failed_checks, 0);
  assert.doesNotMatch(JSON.stringify(result), /netlify-token/);
  restoreFetch();
});

test('verifyNetlifyDeployPreview fails when the deploy preview is not ready', async () => {
  mockFetch((url) => {
    if (url.endsWith('/sites/site-123')) return { id: 'site-123', build_settings: {} };
    return [
      {
        id: 'deploy-1',
        site_id: 'site-123',
        state: 'error',
        branch: 'feature/html-template',
        context: 'deploy-preview'
      }
    ];
  });

  const result = await verifyNetlifyDeployPreview({
    siteId: 'site-123',
    branch: 'feature/html-template',
    env: {
      NETLIFY_AUTH_TOKEN: 'netlify-token'
    }
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check) => check.name === 'deploy_ready' && check.status === 'failed'));
  restoreFetch();
});

test('verifyNetlifyDeployPreview can poll until the deploy preview is ready', async () => {
  let deployReads = 0;
  mockFetch((url) => {
    if (url.endsWith('/sites/site-123')) {
      return {
        id: 'site-123',
        name: 'client-site',
        build_settings: {}
      };
    }
    if (url.includes('/deploys?')) {
      return [
        {
          id: 'deploy-1',
          site_id: 'site-123',
          state: 'building',
          branch: 'feature/html-template',
          context: 'deploy-preview',
          deploy_ssl_url: 'https://deploy-preview-1.netlify.app',
          log_access_attributes: {
            token: 'log-token'
          }
        }
      ];
    }
    if (url.endsWith('/deploys/deploy-1')) {
      deployReads += 1;
      return {
        id: 'deploy-1',
        site_id: 'site-123',
        state: deployReads > 1 ? 'ready' : 'building',
        branch: 'feature/html-template',
        context: 'deploy-preview',
        deploy_ssl_url: 'https://deploy-preview-1.netlify.app',
        updated_at: `2026-08-06T12:00:0${deployReads}Z`,
        log_access_attributes: {
          token: 'log-token'
        }
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const result = await verifyNetlifyDeployPreview({
    siteId: 'site-123',
    branch: 'feature/html-template',
    wait: true,
    intervalMs: 0,
    timeoutMs: 1_000,
    env: {
      NETLIFY_AUTH_TOKEN: 'netlify-token'
    }
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.polling.waited, true);
  assert.equal(result.polling.timed_out, false);
  assert.deepEqual(result.polling.attempts.map((attempt) => attempt.state), ['building', 'building', 'ready']);
  assert.equal(result.deploy_log.deploy_log_url, 'https://app.netlify.com/sites/client-site/deploys/deploy-1');
  assert.equal(result.deploy.log_access_metadata_present, true);
  assert.doesNotMatch(JSON.stringify(result), /log-token|netlify-token/);
  restoreFetch();
});

test('fetchNetlifyDeployLogsWithCli reads and redacts JSONL logs', async () => {
  const result = await fetchNetlifyDeployLogsWithCli({
    deployUrl: 'https://deploy-preview-1.netlify.app',
    source: 'deploy',
    since: '1h',
    env: {
      NETLIFY_AUTH_TOKEN: 'netlify-token'
    },
    execFileImpl: async (command, args, options) => {
      assert.equal(command, 'netlify');
      assert.deepEqual(args, [
        'logs',
        '--source',
        'deploy',
        '--url',
        'https://deploy-preview-1.netlify.app',
        '--since',
        '1h',
        '--json'
      ]);
      assert.equal(options.env.NETLIFY_AUTH_TOKEN, 'netlify-token');
      return {
        stdout: '{"message":"Deploy failed with Bearer abc123","token":"secret"}\nplain token=abc123\n',
        stderr: 'debug token=abc123'
      };
    }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.lines_returned, 2);
  assert.equal(result.lines[0].message, 'Deploy failed with Bearer [REDACTED]');
  assert.equal(result.lines[0].token, '[REDACTED]');
  assert.equal(result.lines[1].message, 'plain token=[REDACTED]');
  assert.equal(result.stderr, 'debug token=[REDACTED]');
  assert.doesNotMatch(JSON.stringify(result), /abc123|secret|netlify-token/);
});

let originalFetch;

function mockFetch(handler) {
  originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(handler(String(url)))
  });
}

function restoreFetch() {
  global.fetch = originalFetch;
}
