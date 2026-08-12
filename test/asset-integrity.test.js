import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAssetIntegrityDashboard, renderAssetIntegrityMarkdown, summarizeManifestAssets } from '../src/asset-integrity.js';

test('summarizeManifestAssets records local asset source hashes and missing sources', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-asset-integrity-'));
  const logoPath = path.join(workDir, 'logo.svg');
  await writeFile(logoPath, '<svg><title>Logo</title></svg>');

  const result = await summarizeManifestAssets({
    repository: {
      assets_to_create: [
        {
          source_path: logoPath,
          target_path: 'src/integrations/acme/assets/logo.svg'
        }
      ]
    },
    storyblok: {
      assets_to_create: [
        {
          local_path: logoPath,
          filename: 'acme/logo.svg',
          asset_folder_path: 'acme'
        },
        {
          local_path: path.join(workDir, 'missing.svg'),
          filename: 'acme/missing.svg',
          asset_folder_path: 'acme'
        }
      ]
    }
  });

  assert.equal(result.planned_repository_assets, 1);
  assert.equal(result.planned_storyblok_assets, 2);
  assert.equal(result.summary.local_sources_checked, 3);
  assert.equal(result.summary.local_sources_hashed, 2);
  assert.equal(result.summary.missing_sources, 1);
  assert.match(result.storyblok_assets[0].source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.storyblok_assets[1].source_status, 'missing');
});

test('buildAssetIntegrityDashboard distinguishes dry-run evidence from real uploaded assets', async () => {
  const manifestSummary = {
    type: 'integration_manifest',
    asset_integrity: {
      planned_repository_assets: 0,
      planned_storyblok_assets: 1,
      repository_assets: [],
      storyblok_assets: [
        {
          type: 'storyblok',
          filename: 'acme/hero.svg',
          local_path: '/tmp/hero.svg',
          source_status: 'available',
          source_sha256: 'a'.repeat(64),
          bytes: 123
        }
      ],
      summary: {
        local_sources_checked: 1,
        missing_sources: 0,
        local_sources_hashed: 1,
        total_local_bytes: 123
      }
    }
  };

  const dryRunDashboard = buildAssetIntegrityDashboard([
    manifestSummary,
    {
      type: 'apply_result',
      asset_results: [
        {
          dry_run: true,
          status: 'dry_run',
          filename: 'acme/hero.svg',
          local_path: '/tmp/hero.svg',
          source_sha256: 'a'.repeat(64),
          bytes: 123
        }
      ]
    }
  ]);

  assert.equal(dryRunDashboard.status, 'pending');
  assert.equal(dryRunDashboard.dry_run_upload_results, 1);
  assert.equal(dryRunDashboard.uploaded_or_reused, 0);
  assert.ok(dryRunDashboard.warnings.some((warning) => /dry-run/.test(warning)));

  const realDashboard = buildAssetIntegrityDashboard([
    manifestSummary,
    {
      type: 'apply_result',
      asset_results: [
        {
          dry_run: false,
          status: 'created',
          filename: 'acme/hero.svg',
          local_path: '/tmp/hero.svg',
          source_sha256: 'a'.repeat(64),
          bytes: 123,
          id: 101,
          verification: {
            id: 101,
            filename: 'https://a.storyblok.com/f/123/hash/hero.svg'
          }
        }
      ]
    },
    {
      type: 'storyblok_management_verification',
      status: 'passed',
      unresolved_asset_fields: 0,
      asset_fields: 4
    }
  ]);

  assert.equal(realDashboard.status, 'passed');
  assert.equal(realDashboard.uploaded_or_reused, 1);
  assert.equal(realDashboard.management_asset_fields, 4);
  assert.equal(realDashboard.assets[0].id, 101);
  assert.match(renderAssetIntegrityMarkdown(realDashboard), /Asset Integrity/);
});
