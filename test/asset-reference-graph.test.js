import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAssetReferenceGraph, renderAssetReferenceGraphMarkdown, summarizeManifestAssetReferenceGraph } from '../src/asset-reference-graph.js';
import { summarizeManifestAssets } from '../src/asset-integrity.js';

test('summarizeManifestAssetReferenceGraph maps story asset fields to planned assets', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-asset-graph-'));
  const heroPath = path.join(workDir, 'hero.svg');
  await writeFile(heroPath, '<svg><title>Hero</title></svg>');
  const manifest = createAssetGraphManifest({
    localPath: heroPath,
    storyImageFilename: './assets/hero.svg'
  });

  const graph = await summarizeManifestAssetReferenceGraph(manifest);

  assert.equal(graph.status, 'pending');
  assert.equal(graph.summary.asset_nodes, 1);
  assert.equal(graph.summary.story_asset_fields, 1);
  assert.equal(graph.summary.resolved_story_asset_fields, 1);
  assert.equal(graph.summary.unresolved_story_asset_fields, 0);
  assert.equal(graph.assets[0].usage_count, 1);
  assert.equal(graph.assets[0].fields[0].field_path, 'content.body[0].image');
  assert.equal(graph.story_usages[0].asset_key, graph.assets[0].asset_key);
});

test('summarizeManifestAssetReferenceGraph fails unresolved story asset fields', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-asset-graph-'));
  const heroPath = path.join(workDir, 'hero.svg');
  await writeFile(heroPath, '<svg><title>Hero</title></svg>');
  const manifest = createAssetGraphManifest({
    localPath: heroPath,
    storyImageFilename: './assets/missing.svg'
  });

  const graph = await summarizeManifestAssetReferenceGraph(manifest);

  assert.equal(graph.status, 'failed');
  assert.equal(graph.summary.unresolved_story_asset_fields, 1);
  assert.equal(graph.story_usages[0].status, 'unresolved_reference');
  assert.ok(graph.warnings.some((warning) => /could not be matched/.test(warning)));
});

test('buildAssetReferenceGraph enriches asset nodes and story usages with upload evidence', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-asset-graph-'));
  const heroPath = path.join(workDir, 'hero.svg');
  await writeFile(heroPath, '<svg><title>Hero</title></svg>');
  const manifest = createAssetGraphManifest({
    localPath: heroPath,
    storyImageFilename: './assets/hero.svg'
  });
  const assetIntegrity = await summarizeManifestAssets(manifest);
  const assetReferenceGraph = await summarizeManifestAssetReferenceGraph(manifest, { assetIntegrity });

  const graph = buildAssetReferenceGraph([
    {
      type: 'integration_manifest',
      asset_integrity: assetIntegrity,
      asset_reference_graph: assetReferenceGraph
    },
    {
      type: 'apply_result',
      asset_results: [
        {
          dry_run: false,
          status: 'created',
          filename: 'acme/hero.svg',
          local_path: heroPath,
          source_sha256: assetIntegrity.storyblok_assets[0].source_sha256,
          bytes: 30,
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
      asset_fields: 3
    }
  ]);

  assert.equal(graph.status, 'passed');
  assert.equal(graph.summary.uploaded_or_reused, 1);
  assert.equal(graph.assets[0].remote_id, 101);
  assert.equal(graph.story_usages[0].status, 'hydrated');
  assert.equal(graph.story_usages[0].remote_id, 101);
  assert.match(renderAssetReferenceGraphMarkdown(graph), /Asset Reference Graph/);
});

test('summarizeManifestAssetReferenceGraph marks ambiguous asset aliases', async () => {
  const manifest = {
    integration_id: 'acme',
    storyblok_prefix: 'hts_acme_',
    storyblok: {
      assets_to_create: [
        {
          filename: 'acme/team/logo.svg',
          source_ref: 'assets/team/logo.svg'
        },
        {
          filename: 'acme/brand/logo.svg',
          source_ref: 'assets/brand/logo.svg'
        }
      ],
      stories_to_create: [
        {
          slug: 'acme/home',
          content: {
            component: 'hts_acme_template_page',
            body: [
              {
                component: 'hts_acme_hero',
                image: {
                  filename: 'logo.svg',
                  fieldtype: 'asset'
                }
              }
            ]
          }
        }
      ]
    }
  };

  const graph = await summarizeManifestAssetReferenceGraph(manifest);

  assert.equal(graph.status, 'failed');
  assert.equal(graph.summary.ambiguous_story_asset_fields, 1);
  assert.equal(graph.story_usages[0].status, 'ambiguous_reference');
  assert.ok(graph.ambiguous_references.includes('logo.svg'));
});

function createAssetGraphManifest({ localPath, storyImageFilename }) {
  return {
    integration_id: 'acme',
    storyblok_prefix: 'hts_acme_',
    repository: {
      assets_to_create: [
        {
          source_path: localPath,
          target_path: 'src/integrations/acme/assets/hero.svg'
        }
      ]
    },
    storyblok: {
      assets_to_create: [
        {
          local_path: localPath,
          filename: 'acme/hero.svg',
          source_ref: 'assets/hero.svg',
          asset_folder_path: 'acme'
        }
      ],
      stories_to_create: [
        {
          slug: 'acme/home',
          content: {
            component: 'hts_acme_template_page',
            body: [
              {
                component: 'hts_acme_hero',
                image: {
                  filename: storyImageFilename,
                  alt: 'Hero',
                  fieldtype: 'asset'
                }
              }
            ]
          }
        }
      ]
    }
  };
}
