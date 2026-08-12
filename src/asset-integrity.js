import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { ensureArray, pathExists, sha256 } from './utils.js';

export async function summarizeManifestAssets(manifest = {}) {
  const repositoryAssets = await Promise.all(ensureArray(manifest.repository?.assets_to_create)
    .map((asset) => summarizePlannedAsset(asset, {
      type: 'repository',
      planned_filename: asset.target_path || asset.path || asset.filename || null,
      folder_path: path.dirname(asset.target_path || asset.path || '')
    })));
  const storyblokAssets = await Promise.all(ensureArray(manifest.storyblok?.assets_to_create)
    .map((asset) => summarizePlannedAsset(asset, {
      type: 'storyblok',
      planned_filename: asset.filename || asset.path || asset.local_path || null,
      folder_path: asset.asset_folder_path || asset.asset_folder || null
    })));

  return {
    planned_repository_assets: repositoryAssets.length,
    planned_storyblok_assets: storyblokAssets.length,
    repository_assets: repositoryAssets,
    storyblok_assets: storyblokAssets,
    summary: summarizeLocalSources([...repositoryAssets, ...storyblokAssets])
  };
}

export function buildAssetIntegrityDashboard(artifactSummaries = []) {
  const manifest = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'integration_manifest');
  const apply = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_apply_result' || artifact.type === 'apply_result');
  const managementVerification = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_management_verification');
  const contentValidation = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_content_validation');
  const manifestAssets = manifest?.asset_integrity || emptyManifestAssets();
  const uploadResults = ensureArray(apply?.asset_results);
  const rows = mergeAssetRows(manifestAssets, uploadResults);
  const uploadedOrReused = uploadResults.filter((asset) => !asset.dry_run && ['created', 'already_exists'].includes(asset.status || '')).length;
  const dryRunUploadResults = uploadResults.filter((asset) => asset.dry_run || asset.status === 'dry_run').length;
  const unresolvedAssetFields = Number(managementVerification?.unresolved_asset_fields || 0);
  const failedUploadResults = uploadResults.filter((asset) => asset.status === 'failed').length;
  const plannedStoryblokAssets = Number(manifestAssets.planned_storyblok_assets || 0);
  const missingSources = Number(manifestAssets.summary?.missing_sources || 0);
  const status = assetIntegrityStatus({
    plannedStoryblokAssets,
    uploadedOrReused,
    missingSources,
    unresolvedAssetFields,
    failedUploadResults
  });

  return {
    status,
    planned_repository_assets: Number(manifestAssets.planned_repository_assets || 0),
    planned_storyblok_assets: plannedStoryblokAssets,
    local_sources_checked: Number(manifestAssets.summary?.local_sources_checked || 0),
    local_sources_missing: missingSources,
    local_sources_hashed: Number(manifestAssets.summary?.local_sources_hashed || 0),
    total_local_bytes: Number(manifestAssets.summary?.total_local_bytes || 0),
    upload_results: uploadResults.length,
    dry_run_upload_results: dryRunUploadResults,
    uploaded_or_reused: uploadedOrReused,
    failed_upload_results: failedUploadResults,
    unresolved_asset_fields: unresolvedAssetFields,
    content_api_asset_fields: Number(contentValidation?.assets || 0),
    management_asset_fields: Number(managementVerification?.asset_fields || 0),
    assets: rows,
    warnings: assetIntegrityWarnings({
      plannedStoryblokAssets,
      uploadResults,
      uploadedOrReused,
      dryRunUploadResults,
      missingSources,
      unresolvedAssetFields,
      failedUploadResults
    })
  };
}

export function renderAssetIntegrityMarkdown(assetIntegrity = emptyDashboard()) {
  const rows = ensureArray(assetIntegrity.assets).slice(0, 20)
    .map((asset) => `- ${asset.filename || asset.local_path || 'asset'}: source ${asset.source_status || 'unknown'}, upload ${asset.upload_status || 'not_run'}${asset.id ? `, id ${asset.id}` : ''}`)
    .join('\n') || '- None';
  const warnings = ensureArray(assetIntegrity.warnings).map((warning) => `- ${warning}`).join('\n') || '- None';
  return `## Asset Integrity

- Status: ${assetIntegrity.status || 'not_run'}
- Planned repository assets: ${assetIntegrity.planned_repository_assets || 0}
- Planned Storyblok assets: ${assetIntegrity.planned_storyblok_assets || 0}
- Local sources checked: ${assetIntegrity.local_sources_checked || 0}
- Local sources missing: ${assetIntegrity.local_sources_missing || 0}
- Local sources hashed: ${assetIntegrity.local_sources_hashed || 0}
- Total local bytes: ${assetIntegrity.total_local_bytes || 0}
- Upload results: ${assetIntegrity.upload_results || 0}
- Uploaded or reused: ${assetIntegrity.uploaded_or_reused || 0}
- Unresolved asset fields: ${assetIntegrity.unresolved_asset_fields || 0}

### Asset Rows

${rows}

### Asset Warnings

${warnings}`;
}

async function summarizePlannedAsset(asset, defaults) {
  const localPath = asset.local_path || asset.source_path || asset.path || asset.file || null;
  const source = await summarizeLocalSource(localPath);
  return {
    type: defaults.type,
    filename: defaults.planned_filename,
    local_path: localPath,
    source_ref: asset.source_ref || asset.reference || null,
    folder_path: defaults.folder_path || null,
    bytes: Number(asset.bytes || source.bytes || 0),
    source_status: source.status,
    source_sha256: source.sha256 || asset.source_sha256 || null
  };
}

async function summarizeLocalSource(localPath) {
  if (!localPath) return { status: 'not_provided', bytes: 0, sha256: null };
  const resolved = path.resolve(localPath);
  if (!(await pathExists(resolved))) return { status: 'missing', bytes: 0, sha256: null };
  const fileStat = await stat(resolved);
  const buffer = await readFile(resolved);
  return {
    status: 'available',
    bytes: fileStat.size,
    sha256: sha256(buffer)
  };
}

function summarizeLocalSources(assets) {
  const checked = assets.filter((asset) => asset.source_status !== 'not_provided');
  const available = assets.filter((asset) => asset.source_status === 'available');
  return {
    local_sources_checked: checked.length,
    missing_sources: assets.filter((asset) => asset.source_status === 'missing').length,
    local_sources_hashed: available.filter((asset) => asset.source_sha256).length,
    total_local_bytes: available.reduce((total, asset) => total + Number(asset.bytes || 0), 0)
  };
}

function mergeAssetRows(manifestAssets, uploadResults) {
  const uploadsByKey = new Map(uploadResults.map((asset) => [assetKey(asset.filename, asset.local_path), asset]));
  const planned = [
    ...ensureArray(manifestAssets.repository_assets),
    ...ensureArray(manifestAssets.storyblok_assets)
  ];
  const rows = planned.map((asset) => {
    const upload = uploadsByKey.get(assetKey(asset.filename, asset.local_path)) ||
      uploadResults.find((entry) => entry.filename === asset.filename || entry.local_path === asset.local_path);
    return {
      ...asset,
      upload_status: upload?.status || (upload?.dry_run ? 'dry_run' : 'not_run'),
      dry_run: Boolean(upload?.dry_run),
      id: upload?.id || null,
      remote_filename: upload?.verification?.filename || upload?.filename || null,
      upload_sha256: upload?.source_sha256 || null
    };
  });
  for (const upload of uploadResults) {
    if (rows.some((asset) => asset.filename === upload.filename || asset.local_path === upload.local_path)) continue;
    rows.push({
      type: 'storyblok',
      filename: upload.filename || upload.verification?.filename || null,
      local_path: upload.local_path || null,
      folder_path: upload.asset_folder_path || null,
      bytes: Number(upload.bytes || 0),
      source_status: upload.source_sha256 ? 'available' : 'unknown',
      source_sha256: upload.source_sha256 || null,
      upload_status: upload.status || (upload.dry_run ? 'dry_run' : 'recorded'),
      dry_run: Boolean(upload.dry_run),
      id: upload.id || null,
      remote_filename: upload.verification?.filename || upload.filename || null,
      upload_sha256: upload.source_sha256 || null
    });
  }
  return rows;
}

function assetIntegrityStatus({ plannedStoryblokAssets, uploadedOrReused, missingSources, unresolvedAssetFields, failedUploadResults }) {
  if (missingSources > 0 || unresolvedAssetFields > 0 || failedUploadResults > 0) return 'failed';
  if (plannedStoryblokAssets > 0 && uploadedOrReused === 0) return 'pending';
  if (plannedStoryblokAssets > 0 && uploadedOrReused < plannedStoryblokAssets) return 'warning';
  return 'passed';
}

function assetIntegrityWarnings({ plannedStoryblokAssets, uploadResults, uploadedOrReused, dryRunUploadResults, missingSources, unresolvedAssetFields, failedUploadResults }) {
  const warnings = [];
  if (missingSources > 0) warnings.push(`${missingSources} planned local asset source(s) are missing.`);
  if (failedUploadResults > 0) warnings.push(`${failedUploadResults} asset upload result(s) failed.`);
  if (unresolvedAssetFields > 0) warnings.push(`${unresolvedAssetFields} draft asset field(s) are still unresolved.`);
  if (plannedStoryblokAssets > 0 && uploadResults.length === 0) warnings.push('Storyblok asset upload has not run yet.');
  if (plannedStoryblokAssets > 0 && dryRunUploadResults > 0 && uploadedOrReused === 0) warnings.push('Only dry-run Storyblok asset upload evidence is available.');
  if (plannedStoryblokAssets > 0 && uploadedOrReused < plannedStoryblokAssets && uploadResults.length > 0) {
    warnings.push(`${plannedStoryblokAssets - uploadedOrReused} planned Storyblok asset(s) do not have upload evidence.`);
  }
  return warnings;
}

function assetKey(filename, localPath) {
  return `${filename || ''}:${localPath || ''}`;
}

function emptyManifestAssets() {
  return {
    planned_repository_assets: 0,
    planned_storyblok_assets: 0,
    repository_assets: [],
    storyblok_assets: [],
    summary: {
      local_sources_checked: 0,
      missing_sources: 0,
      local_sources_hashed: 0,
      total_local_bytes: 0
    }
  };
}

function emptyDashboard() {
  return buildAssetIntegrityDashboard([]);
}
