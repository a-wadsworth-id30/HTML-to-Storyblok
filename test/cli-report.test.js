import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import { writeArtifact } from '../src/evidence.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createReport, renderHtmlReport, renderMarkdownReport } from '../src/reporter.js';

test('report summarizes manifest, validation, and command failure evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-'));
  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'plan',
      '--integration-id',
      'acme-homepage-v1',
      '--storyblok-prefix',
      'hts_acme_homepage_v1_',
      '--template',
      'test/fixtures/basic-template',
      '--framework',
      'static',
      '--work-dir',
      workDir
    ]);
  });
  assert.match(output, /acme-homepage-v1/);

  await assert.rejects(
    captureStdout(() => main(['node', 'html-to-storyblok', 'unknown-command', '--token', 'secret-token', '--work-dir', workDir])),
    /unknown command/
  );

  const reportOutput = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'report', '--work-dir', workDir]);
  });
  const report = JSON.parse(reportOutput);

  assert.equal(report.commands_completed >= 1, true);
  assert.equal(report.commands_failed.length, 1);
  assert.equal(report.latest_validation.status, 'passed');
  assert.ok(report.artifacts.some((artifact) => artifact.type === 'integration_manifest'));
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);

  const htmlReportOutput = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'report', '--html', '--work-dir', workDir]);
  });
  const htmlReport = JSON.parse(htmlReportOutput);
  assert.match(htmlReport.html_report, /report\.html$/);
  assert.match(await readFile(htmlReport.html_report, 'utf8'), /HTML-to-Storyblok Report/);
});

test('report surfaces skipped duplication diagnostics from the manifest', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-skips-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  manifest.duplication_inference = {
    enabled: true,
    repository_components: 0,
    repository_dependency_files: 0,
    repository_asset_files: 0,
    storyblok_components: 0,
    skipped_repository_candidates: [
      {
        source_path: 'src/components/Hero.jsx',
        confidence: 'medium',
        matched_signal: 'hero',
        blockers: ['local import could not be resolved from src/components/Hero.jsx: ../legacy/Button.jsx']
      }
    ]
  };
  await writeArtifact(workDir, 'integration-manifest.json', manifest);

  const report = await createReport(workDir);
  const manifestSummary = report.artifacts.find((artifact) => artifact.type === 'integration_manifest');
  const markdown = renderMarkdownReport(report);

  assert.equal(manifestSummary.duplication_inference.skipped_repository_candidates, 1);
  assert.equal(manifestSummary.duplication_inference.skipped_candidates[0].source_path, 'src/components/Hero.jsx');
  assert.match(markdown, /## Duplication Diagnostics/);
  assert.match(markdown, /local import could not be resolved/);
});

test('report surfaces Storyblok Management API content drift verification', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-storyblok-management-'));
  await writeArtifact(workDir, 'storyblok-management-verification.json', {
    action: 'verify_storyblok_management_state',
    status: 'failed',
    summary: {
      resources: 7,
      matching: 6,
      missing: 0,
      drifted: 0,
      blocked: 0,
      story_checks: 5,
      failed_story_checks: 1,
      unresolved_generated_story_links: 0,
      unresolved_asset_fields: 0,
      content_drifted_stories: 1
    },
    stories: [
      {
        slug: 'acme-homepage-v1/home',
        status: 'failed',
        content_drift: ['headline changed']
      }
    ]
  });

  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);
  const html = renderHtmlReport(report);

  assert.equal(report.latest_storyblok_management_verification.status, 'failed');
  assert.equal(report.latest_storyblok_management_verification.content_drifted_stories, 1);
  assert.equal(report.safety_confirmation.storyblok_management_valid, false);
  assert.match(markdown, /Latest Storyblok management verification: failed/);
  assert.match(markdown, /Content drifted stories: 1/);
  assert.match(html, /Storyblok management valid: no/);
  assert.match(html, /Content drifted stories: 1/);
});

test('report summarizes route handoff evidence artifacts', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-route-handoff-'));
  await writeArtifact(workDir, 'route-handoff-result.json', {
    action: 'wire_repository_routes',
    status: 'skipped',
    dry_run: true,
    summary: {
      total: 2,
      created: 0,
      would_create: 0,
      blocked: 0,
      skipped: 2
    },
    routes: [
      { slug: 'home', manual_handoff: { framework: 'react' } },
      { slug: 'services', manual_handoff: { framework: 'react' } }
    ],
    markdown_report: path.join(workDir, 'route-handoff-report.md')
  });

  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);

  assert.equal(report.latest_route_handoff.status, 'skipped');
  assert.equal(report.latest_route_handoff.manual_handoff_routes, 2);
  assert.match(markdown, /Latest route handoff: skipped/);
});

test('report summarizes template quality scoring artifacts', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-quality-'));
  await writeArtifact(workDir, 'template-quality.json', {
    status: 'review_required',
    score: 72,
    grade: 'C',
    categories: [
      { id: 'editorial_model', score: 35 }
    ],
    risks: [
      { id: 'editorial_model', score: 35 }
    ]
  });

  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);
  const html = renderHtmlReport(report);

  assert.equal(report.latest_template_quality.score, 72);
  assert.equal(report.latest_template_quality.grade, 'C');
  assert.match(markdown, /Latest template quality: C \(72\/100\)/);
  assert.match(html, /Latest template quality/);
});

test('report and asset-dashboard surface asset integrity evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-report-assets-'));
  const assetPath = path.join(workDir, 'hero.svg');
  await writeFile(assetPath, '<svg><title>Hero</title></svg>');

  await writeArtifact(workDir, 'integration-manifest.json', {
    integration_id: 'acme-homepage-v1',
    repository: {
      assets_to_create: [
        {
          source_path: assetPath,
          target_path: 'src/integrations/acme-homepage-v1/assets/hero.svg'
        }
      ]
    },
    storyblok: {
      assets_to_create: [
        {
          local_path: assetPath,
          filename: 'acme-homepage-v1/hero.svg',
          asset_folder_path: 'acme-homepage-v1'
        }
      ]
    }
  });
  await writeArtifact(workDir, 'apply-result.json', {
    status: 'complete',
    dry_run: false,
    steps: [
      {
        action: 'storyblok_assets',
        results: [
          {
            action: 'upload_asset',
            dry_run: false,
            status: 'created',
            local_path: assetPath,
            filename: 'acme-homepage-v1/hero.svg',
            asset_folder_path: 'acme-homepage-v1',
            bytes: 29,
            source_sha256: 'a'.repeat(64),
            id: 123,
            verification: {
              id: 123,
              filename: 'https://a.storyblok.com/f/123/hash/hero.svg'
            }
          }
        ]
      }
    ]
  });
  await writeArtifact(workDir, 'storyblok-management-verification.json', {
    status: 'passed',
    summary: {
      unresolved_asset_fields: 0,
      asset_fields: 3
    }
  });

  const report = await createReport(workDir);
  const markdown = renderMarkdownReport(report);
  const html = renderHtmlReport(report);
  const dashboardOutput = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'asset-dashboard', '--work-dir', workDir]);
  });
  const dashboard = JSON.parse(dashboardOutput);

  assert.equal(report.asset_integrity.status, 'passed');
  assert.equal(report.asset_integrity.planned_storyblok_assets, 1);
  assert.equal(report.asset_integrity.uploaded_or_reused, 1);
  assert.equal(report.asset_integrity.unresolved_asset_fields, 0);
  assert.equal(report.safety_confirmation.asset_integrity_valid, true);
  assert.match(markdown, /## Asset Integrity/);
  assert.match(markdown, /Uploaded or reused: 1/);
  assert.match(html, /Asset Integrity/);
  assert.equal(dashboard.status, 'passed');
  assert.equal(dashboard.assets[0].id, 123);
});

test('apply dry-run executes the import pipeline without copying template assets as repository duplicates', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-repo-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-apply-dry-run-work-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'apply',
      '--manifest',
      manifestPath,
      '--repo',
      repoPath,
      '--template',
      'test/fixtures/basic-template',
      '--framework',
      'static',
      '--dry-run',
      '--work-dir',
      workDir
    ]);
  });
  const result = JSON.parse(output);
  const duplicateStep = result.steps.find((step) => step.action === 'duplicate');
  const localValidationStep = result.steps.find((step) => step.action === 'local_validation');

  assert.equal(result.dry_run, true);
  assert.deepEqual(duplicateStep.repository_assets, []);
  assert.equal(localValidationStep.results.status, 'skipped');
});

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
