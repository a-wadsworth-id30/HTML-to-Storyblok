import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { writeArtifact } from '../src/evidence.js';
import { createProductionHandoffPack } from '../src/handoff-pack.js';
import { createIntegrationPlan } from '../src/planner.js';

test('createProductionHandoffPack writes review-ready markdown and JSON evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-handoff-pack-'));
  const repoPath = await createRepositoryFixture();
  const manifest = await createManifest();
  await writeArtifact(workDir, 'integration-manifest.json', manifest);
  await writeArtifact(workDir, 'apply-result.json', createApplyResult());

  const pack = await createProductionHandoffPack({
    manifest,
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    workDir,
    env: {}
  });
  const markdown = await readFile(pack.markdown_report, 'utf8');
  const json = JSON.parse(await readFile(pack.json_report, 'utf8'));

  assert.equal(pack.action, 'production_handoff_pack');
  assert.equal(pack.integration_id, 'acme-homepage-v1');
  assert.equal(pack.status, 'warning');
  assert.equal(pack.storyblok.draft_editor_links[0].slug, 'acme-homepage-v1/home');
  assert.equal(pack.repository.route_previews[0].suggested_site_path, '/');
  assert.equal(json.action, 'production_handoff_pack');
  assert.match(markdown, /Production Handoff Pack/);
  assert.match(markdown, /Storyblok Review/);
  assert.match(markdown, /https:\/\/app\.storyblok\.com\/#\/me\/spaces\/12345\/stories\/0\/0\/456/);
  assert.match(markdown, /Rollback Scope/);
  assert.match(markdown, /Client\/editor visual QA completed/);
});

test('handoff-pack CLI command outputs pack JSON and writes markdown', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-handoff-pack-cli-'));
  const repoPath = await createRepositoryFixture();
  const manifest = await createManifest();
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeArtifact(workDir, 'apply-result.json', createApplyResult());

  const output = await captureStdout(() => main([
    'node',
    'html-to-storyblok',
    'handoff-pack',
    '--manifest',
    manifestPath,
    '--repo',
    repoPath,
    '--template',
    'test/fixtures/basic-template',
    '--work-dir',
    workDir,
    '--no-interactive'
  ]));
  const result = JSON.parse(output);

  assert.equal(result.action, 'production_handoff_pack');
  assert.equal(result.json_report, path.join(workDir, 'production-handoff-pack.json'));
  assert.match(await readFile(path.join(workDir, 'production-handoff-pack.md'), 'utf8'), /Review Links/);
});

async function createManifest() {
  return createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
}

function createApplyResult() {
  return {
    action: 'apply_manifest',
    status: 'complete',
    dry_run: false,
    steps: [
      {
        name: 'Creating Frontend',
        status: 'passed',
        route_previews: [
          {
            slug: 'home',
            suggested_site_path: '/',
            preview_file: 'src/integrations/acme-homepage-v1/routes/home/template.html',
            route_proposal_file: 'src/integrations/acme-homepage-v1/route-proposals/home/route.js'
          }
        ]
      },
      {
        name: 'Creating Draft Stories',
        status: 'passed',
        results: [
          {
            action: 'create_draft_story',
            slug: 'acme-homepage-v1/home',
            editor_url: 'https://app.storyblok.com/#/me/spaces/12345/stories/0/0/456',
            link_summary: {
              total_links: 1,
              story_links: 1,
              resolved_story_links: 1,
              unresolved_story_links: 0
            }
          }
        ]
      }
    ]
  };
}

async function createRepositoryFixture() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-handoff-pack-repo-'));
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'handoff-pack-fixture',
    type: 'module',
    scripts: {
      build: 'node -e "process.exit(0)"'
    },
    dependencies: {
      '@storyblok/astro': '^6.0.0'
    }
  }, null, 2));
  await writeFile(path.join(repoPath, 'src/storyblok.js'), 'export const STORYBLOK_TOKEN = import.meta.env.STORYBLOK_TOKEN;\n');
  return repoPath;
}

async function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, done) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof done === 'function') done();
    return true;
  };
  try {
    await callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
