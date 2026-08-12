import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { writeArtifact, writeTextArtifact } from '../src/evidence.js';
import { createHandoffEvidenceIndex, renderHandoffEvidenceIndexMarkdown } from '../src/handoff-evidence-index.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReport, renderMarkdownReport } from '../src/reporter.js';
import { pathExists } from '../src/utils.js';

test('handoff evidence index summarizes available sign-off evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-evidence-index-ready-'));
  const manifest = await createManifest(workDir);
  await writeCoreEvidence(workDir, manifest);

  const index = await createHandoffEvidenceIndex({
    manifest,
    workDir,
    repoPath: '../client-site'
  });
  const markdown = renderHandoffEvidenceIndexMarkdown(index);

  assert.equal(index.status, 'ready');
  assert.equal(index.summary.required_missing, 0);
  assert.equal(index.summary.storyblok_draft_links, 1);
  assert.equal(index.summary.route_previews, 1);
  assert.ok(index.evidence_files.some((entry) => entry.key === 'platform_readiness' && entry.status === 'available'));
  assert.ok(index.sign_off_checklist.some((entry) => entry.label === 'Platform readiness reviewed' && entry.status === 'done'));
  assert.match(markdown, /Handoff Evidence Index/);
  assert.match(markdown, /Storyblok draft acme-v1\/home/);
});

test('handoff evidence index flags missing required evidence as attention', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-evidence-index-missing-'));
  const manifest = await createManifest(workDir);

  const index = await createHandoffEvidenceIndex({ manifest, workDir });

  assert.equal(index.status, 'attention');
  assert.ok(index.summary.required_missing > 0);
  assert.ok(index.sign_off_checklist.some((entry) => entry.status === 'blocked'));
  assert.ok(index.next_commands.some((entry) => entry.command.includes('rollback-preview')));
});

test('evidence-index CLI writes markdown and report summarizes it', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-evidence-index-cli-'));
  const manifest = await createManifest(workDir);
  await writeCoreEvidence(workDir, manifest);
  const manifestPath = path.join(workDir, 'integration-manifest.json');

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'evidence-index',
      '--manifest',
      manifestPath,
      '--repo',
      '../client-site',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);

  assert.equal(result.action, 'handoff_evidence_index');
  assert.match(result.markdown_report, /handoff-evidence-index\.md$/);
  assert.equal(await pathExists(path.join(workDir, 'handoff-evidence-index.json')), true);
  assert.match(await readFile(result.markdown_report, 'utf8'), /Sign-Off Checklist/);
  assert.equal(report.latest_evidence_index.status, 'ready');
  assert.match(markdown, /Latest handoff evidence index: ready/);
});

async function createManifest(workDir) {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'astro'
  });
  await writeArtifact(workDir, 'integration-manifest.json', manifest);
  await writeArtifact(workDir, 'plan-validation.json', {
    valid: true,
    violations: []
  });
  return manifest;
}

async function writeCoreEvidence(workDir, manifest) {
  await writeArtifact(workDir, 'apply-result.json', {
    action: 'apply_manifest',
    status: 'complete',
    dry_run: false,
    steps: [
      {
        route_previews: [
          {
            slug: 'home',
            suggested_site_path: '/',
            preview_file: `${manifest.repository_namespace}/routes/home/TemplatePage.astro`,
            route_proposal_file: `${manifest.repository_namespace}/route-proposals/home/page.astro`
          }
        ],
        results: [
          {
            action: 'create_draft_story',
            slug: `${manifest.integration_id}/home`,
            editor_url: 'https://app.storyblok.com/#/me/spaces/123/stories/0/0/456'
          }
        ]
      }
    ]
  });
  await writeTextArtifact(workDir, 'report.md', '# Report\n');
  await writeArtifact(workDir, 'rollback-preview.json', {
    action: 'rollback_preview',
    validation: { valid: true },
    repository_files_to_remove: []
  });
  await writeArtifact(workDir, 'storyblok-management-verification.json', {
    action: 'verify_storyblok_management_state',
    status: 'passed',
    summary: {
      resources: 4,
      failed_story_checks: 0
    }
  });
  await writeArtifact(workDir, 'storyblok-content-validation.json', {
    action: 'validate_storyblok_draft_content',
    status: 'passed',
    summary: {
      stories: 1,
      failed: 0
    }
  });
  await writeArtifact(workDir, 'asset-reference-graph.json', {
    action: 'asset_reference_graph',
    status: 'passed',
    summary: {
      story_asset_fields: 1,
      resolved_story_asset_fields: 1,
      unresolved_story_asset_fields: 0
    }
  });
  await writeArtifact(workDir, 'platform-readiness.json', {
    action: 'platform_readiness',
    status: 'passed',
    framework: 'astro',
    summary: {
      routes: 1
    }
  });
  await writeArtifact(workDir, 'route-handoff-result.json', {
    action: 'wire_repository_routes',
    status: 'passed',
    summary: {
      total: 1,
      created: 1
    },
    routes: [
      {
        slug: 'home',
        status: 'created'
      }
    ]
  });
  await writeArtifact(workDir, 'demo-sites-e2e-result.json', {
    action: 'test_demo_sites_e2e',
    status: 'passed',
    markdown_report: path.join(workDir, 'demo-sites-e2e-report.md')
  });
}

async function captureStdout(callback) {
  const originalLog = console.log;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return output.trim();
}
