import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('full demo-site runner lists framework validation targets', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/test-demo-sites-full.mjs', '--list'], {
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(stdout);

  assert.equal(result.action, 'test_demo_sites_full');
  assert.ok(result.sites.some((site) => site.site === 'astro' && site.framework_build));
  assert.ok(result.sites.some((site) => site.site === 'next' && site.preview_url === 'http://127.0.0.1:4402/'));
  assert.ok(result.sites.some((site) => site.site === 'static' && !site.framework_build));
});

test('full demo-site runner keeps static validation dependency-free', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/test-demo-sites-full.mjs', '--site', 'static'], {
    maxBuffer: 1024 * 1024
  });

  assert.match(stdout, /demo build check passed: hts-demo-static/);
  assert.match(stdout, /"site": "static"/);
  assert.match(stdout, /"status": "lightweight_only"/);
});
