import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyNetlifyDeployPreview } from '../src/netlify.js';

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
