import path from 'node:path';
import { summarizeManifestAssets } from './asset-integrity.js';
import { ensureArray, unique } from './utils.js';

export async function summarizeManifestAssetReferenceGraph(manifest = {}, { assetIntegrity = null } = {}) {
  const integrity = assetIntegrity || await summarizeManifestAssets(manifest);
  const builder = createAssetGraphBuilder(manifest, integrity);
  const storyUsages = collectStoryAssetUsages(manifest);
  const resolvedUsages = storyUsages.map((usage) => resolveStoryAssetUsage(usage, builder));
  const nodes = [...builder.nodes.values()].map((node) => summarizeNodeUsage(node, resolvedUsages));
  const summary = summarizeGraph({
    nodes,
    usages: resolvedUsages,
    integrity,
    uploadResults: [],
    managementVerification: null,
    contentValidation: null
  });

  return {
    status: graphStatus(summary),
    integration_id: manifest.integration_id || null,
    storyblok_prefix: manifest.storyblok_prefix || null,
    summary,
    assets: nodes,
    story_usages: resolvedUsages,
    ambiguous_references: [...builder.ambiguousAliases].sort(),
    warnings: graphWarnings(summary, resolvedUsages, builder)
  };
}

export function buildAssetReferenceGraph(artifactSummaries = []) {
  const manifest = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'integration_manifest');
  const apply = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_apply_result' || artifact.type === 'apply_result');
  const managementVerification = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_management_verification');
  const contentValidation = [...artifactSummaries].reverse().find((artifact) => artifact.type === 'storyblok_content_validation');
  const baseGraph = manifest?.asset_reference_graph || emptyAssetReferenceGraph();
  const uploadResults = ensureArray(apply?.asset_results);
  const uploadResolver = createUploadResolver(uploadResults);
  const nodes = ensureArray(baseGraph.assets).map((node) => mergeNodeUploadEvidence(node, uploadResolver));
  const nodeMap = new Map(nodes.map((node) => [node.asset_key, node]));
  addUnmatchedUploadNodes(nodes, nodeMap, uploadResults);
  const usages = ensureArray(baseGraph.story_usages).map((usage) => mergeUsageUploadEvidence(usage, nodeMap));
  const summary = summarizeGraph({
    nodes,
    usages,
    integrity: manifest?.asset_integrity,
    uploadResults,
    managementVerification,
    contentValidation
  });

  return {
    ...baseGraph,
    status: graphStatus(summary),
    summary,
    assets: nodes.map((node) => summarizeNodeUsage(node, usages)),
    story_usages: usages,
    upload_results: uploadResults.length,
    management_unresolved_asset_fields: Number(managementVerification?.unresolved_asset_fields || 0),
    content_api_asset_fields: Number(contentValidation?.assets || 0),
    warnings: graphWarnings(summary, usages, {
      ambiguousAliases: new Set(ensureArray(baseGraph.ambiguous_references))
    })
  };
}

export function renderAssetReferenceGraphMarkdown(graph = emptyAssetReferenceGraph()) {
  const summary = graph.summary || {};
  const assetRows = ensureArray(graph.assets).slice(0, 20)
    .map((asset) => `- ${asset.filename || asset.local_path || asset.asset_key}: ${asset.usage_count || 0} field(s), upload ${asset.upload_status || 'not_run'}${asset.remote_id ? `, id ${asset.remote_id}` : ''}`)
    .join('\n') || '- None';
  const unresolvedRows = ensureArray(graph.story_usages)
    .filter((usage) => usage.status === 'unresolved_reference' || usage.status === 'ambiguous_reference')
    .slice(0, 20)
    .map((usage) => `- ${usage.story_slug} ${usage.field_path}: ${usage.local_reference || 'missing reference'} (${usage.status})`)
    .join('\n') || '- None';
  const warningRows = ensureArray(graph.warnings).map((warning) => `- ${warning}`).join('\n') || '- None';

  return `## Asset Reference Graph

- Status: ${graph.status || 'not_run'}
- Asset nodes: ${summary.asset_nodes || 0}
- Planned Storyblok assets: ${summary.planned_storyblok_assets || 0}
- Story asset fields: ${summary.story_asset_fields || 0}
- Resolved story asset fields: ${summary.resolved_story_asset_fields || 0}
- Unresolved story asset fields: ${summary.unresolved_story_asset_fields || 0}
- Uploaded or reused: ${summary.uploaded_or_reused || 0}
- Remote unresolved asset fields: ${summary.remote_unresolved_asset_fields || 0}

### Asset Usage

${assetRows}

### Unresolved Story Asset Fields

${unresolvedRows}

### Asset Graph Warnings

${warningRows}`;
}

function createAssetGraphBuilder(manifest, integrity) {
  const nodes = new Map();
  const aliasSets = new Map();
  const repositoryAssets = ensureArray(manifest.repository?.assets_to_create);
  const storyblokAssets = ensureArray(manifest.storyblok?.assets_to_create);
  const repositorySummaries = ensureArray(integrity.repository_assets);
  const storyblokSummaries = ensureArray(integrity.storyblok_assets);

  storyblokAssets.forEach((asset, index) => {
    const summary = storyblokSummaries[index] || {};
    const key = assetKey(asset, summary, 'storyblok', index);
    const node = mergeAssetNode(nodes.get(key), {
      asset_key: key,
      type: 'storyblok',
      planned_storyblok: true,
      planned_repository: false,
      filename: asset.filename || asset.path || summary.filename || null,
      local_path: asset.local_path || asset.source_path || asset.path || summary.local_path || null,
      source_ref: asset.source_ref || asset.reference || summary.source_ref || null,
      asset_folder_path: asset.asset_folder_path || asset.asset_folder || summary.folder_path || null,
      bytes: Number(asset.bytes || asset.size || summary.bytes || 0),
      source_status: summary.source_status || 'unknown',
      source_sha256: summary.source_sha256 || asset.source_sha256 || null,
      upload_status: 'not_run',
      remote_id: null,
      remote_filename: null,
      usage_count: 0
    });
    nodes.set(key, node);
    for (const alias of nodeAliases(node, asset)) registerAlias(aliasSets, alias, key);
  });

  repositoryAssets.forEach((asset, index) => {
    const summary = repositorySummaries[index] || {};
    const provisional = {
      filename: asset.target_path || asset.path || asset.filename || summary.filename || null,
      local_path: asset.source_path || asset.local_path || asset.path || summary.local_path || null,
      source_ref: asset.source_ref || asset.reference || summary.source_ref || null
    };
    const existingKey = resolveAliasSet(aliasSets, provisional.local_path) ||
      resolveAliasSet(aliasSets, provisional.source_ref) ||
      resolveAliasSet(aliasSets, provisional.filename);
    const key = existingKey || assetKey(asset, summary, 'repository', index);
    const node = mergeAssetNode(nodes.get(key), {
      asset_key: key,
      type: nodes.has(key) ? 'shared' : 'repository',
      planned_storyblok: Boolean(nodes.get(key)?.planned_storyblok),
      planned_repository: true,
      filename: nodes.get(key)?.filename || provisional.filename,
      repository_target_path: asset.target_path || asset.path || null,
      local_path: provisional.local_path,
      source_ref: provisional.source_ref,
      asset_folder_path: nodes.get(key)?.asset_folder_path || null,
      bytes: Number(asset.bytes || asset.size || summary.bytes || nodes.get(key)?.bytes || 0),
      source_status: summary.source_status || nodes.get(key)?.source_status || 'unknown',
      source_sha256: summary.source_sha256 || asset.source_sha256 || nodes.get(key)?.source_sha256 || null,
      upload_status: nodes.get(key)?.upload_status || 'not_run',
      remote_id: nodes.get(key)?.remote_id || null,
      remote_filename: nodes.get(key)?.remote_filename || null,
      usage_count: nodes.get(key)?.usage_count || 0
    });
    nodes.set(key, node);
    for (const alias of nodeAliases(node, asset)) registerAlias(aliasSets, alias, key);
  });

  const aliases = new Map();
  const ambiguousAliases = new Set();
  for (const [alias, keys] of aliasSets.entries()) {
    if (keys.size === 1) aliases.set(alias, [...keys][0]);
    else ambiguousAliases.add(alias);
  }

  return { nodes, aliases, ambiguousAliases };
}

function collectStoryAssetUsages(manifest) {
  return ensureArray(manifest.storyblok?.stories_to_create).flatMap((story) => {
    const slug = story.slug || story.full_slug || 'story';
    const content = story.content || {
      component: story.component,
      body: ensureArray(story.body)
    };
    return collectAssetFieldsWithPath(content, {
      storySlug: slug,
      pathName: 'content',
      component: content?.component || null
    });
  });
}

function collectAssetFieldsWithPath(value, context, usages = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectAssetFieldsWithPath(entry, {
        ...context,
        pathName: `${context.pathName}[${index}]`
      }, usages);
    });
    return usages;
  }
  if (!value || typeof value !== 'object') return usages;

  const component = typeof value.component === 'string' ? value.component : context.component;
  if (isAssetField(value)) {
    usages.push({
      story_slug: context.storySlug,
      field_path: context.pathName,
      component,
      local_reference: value.filename || value.source_ref || value.path || value.file || null,
      remote_id: value.id || null,
      remote_filename: value.filename && isRemoteAssetFilename(value.filename) ? value.filename : null,
      alt: value.alt || '',
      title: value.title || '',
      fieldtype: value.fieldtype || 'asset'
    });
    return usages;
  }

  for (const [key, entry] of Object.entries(value)) {
    collectAssetFieldsWithPath(entry, {
      storySlug: context.storySlug,
      pathName: `${context.pathName}.${key}`,
      component
    }, usages);
  }
  return usages;
}

function resolveStoryAssetUsage(usage, builder) {
  const key = resolveAlias(builder.aliases, usage.local_reference);
  const normalizedReference = normalizeAssetRef(usage.local_reference);
  const ambiguous = normalizedReference && builder.ambiguousAliases.has(normalizedReference);
  const status = key
    ? 'planned'
    : usage.remote_id || usage.remote_filename
      ? 'remote_reference'
      : ambiguous
        ? 'ambiguous_reference'
        : 'unresolved_reference';
  return {
    ...usage,
    asset_key: key || null,
    status
  };
}

function mergeNodeUploadEvidence(node, uploadResolver) {
  const upload = uploadResolver.resolve(node);
  if (!upload) return { ...node };
  return {
    ...node,
    upload_status: upload.status || (upload.dry_run ? 'dry_run' : 'recorded'),
    dry_run: Boolean(upload.dry_run),
    remote_id: upload.id || upload.verification?.id || node.remote_id || null,
    remote_filename: upload.verification?.filename || upload.filename || node.remote_filename || null,
    upload_sha256: upload.source_sha256 || null
  };
}

function mergeUsageUploadEvidence(usage, nodeMap) {
  if (!usage.asset_key) return usage;
  const node = nodeMap.get(usage.asset_key);
  if (!node) return { ...usage, status: 'unresolved_reference' };
  const remoteId = node.remote_id || usage.remote_id || null;
  let status = usage.status || 'planned';
  if (remoteId) status = 'hydrated';
  else if (node.upload_status === 'dry_run') status = 'dry_run_planned';
  else if (node.upload_status === 'failed') status = 'upload_failed';
  return {
    ...usage,
    status,
    upload_status: node.upload_status || 'not_run',
    remote_id: remoteId,
    remote_filename: node.remote_filename || usage.remote_filename || null
  };
}

function createUploadResolver(uploadResults) {
  const aliasSets = new Map();
  uploadResults.forEach((upload, index) => {
    const key = `upload:${index}`;
    for (const alias of uploadAliases(upload)) registerAlias(aliasSets, alias, key);
  });
  const aliases = new Map();
  for (const [alias, keys] of aliasSets.entries()) {
    if (keys.size === 1) aliases.set(alias, [...keys][0]);
  }
  const uploadsByKey = new Map(uploadResults.map((upload, index) => [`upload:${index}`, upload]));
  return {
    resolve(node) {
      const aliasesToTry = nodeAliases(node);
      for (const alias of aliasesToTry) {
        const key = resolveAlias(aliases, alias);
        if (key && uploadsByKey.has(key)) return uploadsByKey.get(key);
      }
      return null;
    },
    has(upload) {
      return Boolean(resolveAlias(aliases, upload.filename) || resolveAlias(aliases, upload.local_path));
    }
  };
}

function addUnmatchedUploadNodes(nodes, nodeMap, uploadResults) {
  for (const [index, upload] of uploadResults.entries()) {
    const exists = nodes.some((node) => {
      const aliases = new Set(nodeAliases(node));
      return uploadAliases(upload).some((alias) => aliases.has(alias));
    });
    if (exists) continue;
    const key = `remote-upload:${normalizeAssetRef(upload.filename) || normalizeAssetRef(upload.local_path) || index}`;
    const node = {
      asset_key: key,
      type: 'storyblok',
      planned_storyblok: false,
      planned_repository: false,
      filename: upload.filename || upload.verification?.filename || null,
      local_path: upload.local_path || null,
      source_ref: upload.source_ref || null,
      asset_folder_path: upload.asset_folder_path || null,
      bytes: Number(upload.bytes || 0),
      source_status: upload.source_sha256 ? 'available' : 'unknown',
      source_sha256: upload.source_sha256 || null,
      upload_status: upload.status || (upload.dry_run ? 'dry_run' : 'recorded'),
      dry_run: Boolean(upload.dry_run),
      remote_id: upload.id || upload.verification?.id || null,
      remote_filename: upload.verification?.filename || upload.filename || null,
      usage_count: 0
    };
    nodes.push(node);
    nodeMap.set(key, node);
  }
}

function summarizeNodeUsage(node, usages) {
  const matchingUsages = ensureArray(usages).filter((usage) => usage.asset_key === node.asset_key);
  return {
    ...node,
    usage_count: matchingUsages.length,
    stories: unique(matchingUsages.map((usage) => usage.story_slug)),
    fields: matchingUsages.slice(0, 20).map((usage) => ({
      story_slug: usage.story_slug,
      field_path: usage.field_path,
      component: usage.component || null,
      status: usage.status
    }))
  };
}

function summarizeGraph({ nodes, usages, integrity, uploadResults, managementVerification, contentValidation }) {
  const uploadedOrReused = ensureArray(uploadResults).filter((asset) =>
    !asset.dry_run && ['created', 'already_exists', 'recorded'].includes(asset.status || '')
  ).length;
  const dryRunUploadResults = ensureArray(uploadResults).filter((asset) => asset.dry_run || asset.status === 'dry_run').length;
  const failedUploadResults = ensureArray(uploadResults).filter((asset) => asset.status === 'failed').length;
  const unresolvedUsages = usages.filter((usage) => usage.status === 'unresolved_reference' || usage.status === 'ambiguous_reference');
  const remoteUnresolvedAssetFields = Number(managementVerification?.unresolved_asset_fields || 0);
  return {
    asset_nodes: nodes.length,
    planned_repository_assets: Number(integrity?.planned_repository_assets || nodes.filter((node) => node.planned_repository).length),
    planned_storyblok_assets: Number(integrity?.planned_storyblok_assets || nodes.filter((node) => node.planned_storyblok).length),
    local_sources_missing: Number(integrity?.summary?.missing_sources || nodes.filter((node) => node.source_status === 'missing').length),
    story_asset_fields: usages.length,
    resolved_story_asset_fields: usages.length - unresolvedUsages.length,
    unresolved_story_asset_fields: unresolvedUsages.length,
    ambiguous_story_asset_fields: usages.filter((usage) => usage.status === 'ambiguous_reference').length,
    assets_with_story_usage: nodes.filter((node) => ensureArray(node.fields).length > 0 || ensureArray(usages).some((usage) => usage.asset_key === node.asset_key)).length,
    upload_results: ensureArray(uploadResults).length,
    dry_run_upload_results: dryRunUploadResults,
    uploaded_or_reused: uploadedOrReused,
    failed_upload_results: failedUploadResults,
    management_asset_fields: Number(managementVerification?.asset_fields || 0),
    remote_unresolved_asset_fields: remoteUnresolvedAssetFields,
    content_api_asset_fields: Number(contentValidation?.assets || 0)
  };
}

function graphStatus(summary) {
  if (
    summary.local_sources_missing > 0 ||
    summary.unresolved_story_asset_fields > 0 ||
    summary.failed_upload_results > 0 ||
    summary.remote_unresolved_asset_fields > 0
  ) return 'failed';
  if (summary.planned_storyblok_assets > 0 && summary.upload_results === 0) return 'pending';
  if (summary.planned_storyblok_assets > 0 && summary.uploaded_or_reused === 0 && summary.dry_run_upload_results > 0) return 'pending';
  if (summary.planned_storyblok_assets > 0 && summary.uploaded_or_reused < summary.planned_storyblok_assets && summary.upload_results > 0 && summary.dry_run_upload_results === 0) return 'warning';
  return 'passed';
}

function graphWarnings(summary, usages, builder) {
  const warnings = [];
  if (summary.local_sources_missing > 0) warnings.push(`${summary.local_sources_missing} planned asset source(s) are missing locally.`);
  if (summary.unresolved_story_asset_fields > 0) warnings.push(`${summary.unresolved_story_asset_fields} story asset field(s) could not be matched to a planned asset.`);
  if (summary.ambiguous_story_asset_fields > 0) warnings.push(`${summary.ambiguous_story_asset_fields} story asset field(s) matched ambiguous asset aliases.`);
  if (summary.failed_upload_results > 0) warnings.push(`${summary.failed_upload_results} asset upload result(s) failed.`);
  if (summary.remote_unresolved_asset_fields > 0) warnings.push(`${summary.remote_unresolved_asset_fields} remote draft asset field(s) are unresolved after apply.`);
  if (summary.planned_storyblok_assets > 0 && summary.upload_results === 0) warnings.push('Storyblok asset upload evidence has not been recorded yet.');
  if (summary.planned_storyblok_assets > 0 && summary.dry_run_upload_results > 0 && summary.uploaded_or_reused === 0) warnings.push('Only dry-run asset upload evidence is available.');
  if (ensureArray(usages).some((usage) => usage.status === 'remote_reference')) warnings.push('Some story asset fields already reference remote Storyblok assets outside the generated asset plan.');
  if (builder?.ambiguousAliases?.size > 0) warnings.push(`${builder.ambiguousAliases.size} asset alias(es) are ambiguous and require explicit source references.`);
  return unique(warnings);
}

function mergeAssetNode(existing = {}, next = {}) {
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null && value !== undefined && value !== '')),
    planned_storyblok: Boolean(existing.planned_storyblok || next.planned_storyblok),
    planned_repository: Boolean(existing.planned_repository || next.planned_repository),
    type: existing.planned_storyblok || next.planned_storyblok
      ? existing.planned_repository || next.planned_repository ? 'shared' : 'storyblok'
      : next.type || existing.type || 'repository'
  };
}

function assetKey(asset, summary, type, index) {
  const primary = normalizeAssetRef(asset.filename || summary.filename || asset.target_path || asset.local_path || asset.source_path || asset.path);
  if (primary) return `${type}:${primary}`;
  return `${type}:${index}`;
}

function nodeAliases(node, raw = {}) {
  return unique([
    node.asset_key,
    node.filename,
    node.remote_filename,
    node.local_path,
    node.source_ref,
    node.repository_target_path,
    raw.filename,
    raw.path,
    raw.file,
    raw.local_path,
    raw.source_path,
    raw.source_ref,
    raw.target_path,
    basenameAlias(node.filename),
    basenameAlias(node.local_path),
    basenameAlias(node.source_ref)
  ].map(normalizeAssetRef).filter(Boolean));
}

function uploadAliases(upload) {
  return unique([
    upload.filename,
    upload.verification?.filename,
    upload.local_path,
    upload.source_ref,
    basenameAlias(upload.filename),
    basenameAlias(upload.local_path),
    basenameAlias(upload.verification?.filename)
  ].map(normalizeAssetRef).filter(Boolean));
}

function basenameAlias(value) {
  const normalized = normalizeAssetRef(value);
  if (!normalized) return '';
  return path.basename(normalized);
}

function registerAlias(aliasSets, alias, key) {
  const normalized = normalizeAssetRef(alias);
  if (!normalized) return;
  if (!aliasSets.has(normalized)) aliasSets.set(normalized, new Set());
  aliasSets.get(normalized).add(key);
}

function resolveAlias(aliases, value) {
  const normalized = normalizeAssetRef(value);
  if (!normalized) return null;
  return aliases.get(normalized) || null;
}

function resolveAliasSet(aliasSets, value) {
  const normalized = normalizeAssetRef(value);
  if (!normalized) return null;
  const keys = aliasSets.get(normalized);
  return keys?.size === 1 ? [...keys][0] : null;
}

function normalizeAssetRef(value) {
  if (!value) return '';
  let normalized = String(value)
    .replaceAll('\\', '/')
    .split('#')[0]
    .split('?')[0]
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      normalized = url.pathname.replace(/^\/+/, '');
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function isAssetField(value) {
  return value &&
    typeof value === 'object' &&
    (value.fieldtype === 'asset' || ('filename' in value && ('id' in value || 'alt' in value || 'title' in value)));
}

function isRemoteAssetFilename(value) {
  return /^https?:\/\/a\.storyblok\.com\//i.test(String(value || ''));
}

function emptyAssetReferenceGraph() {
  return {
    status: 'not_run',
    integration_id: null,
    storyblok_prefix: null,
    summary: {
      asset_nodes: 0,
      planned_repository_assets: 0,
      planned_storyblok_assets: 0,
      local_sources_missing: 0,
      story_asset_fields: 0,
      resolved_story_asset_fields: 0,
      unresolved_story_asset_fields: 0,
      ambiguous_story_asset_fields: 0,
      assets_with_story_usage: 0,
      upload_results: 0,
      dry_run_upload_results: 0,
      uploaded_or_reused: 0,
      failed_upload_results: 0,
      management_asset_fields: 0,
      remote_unresolved_asset_fields: 0,
      content_api_asset_fields: 0
    },
    assets: [],
    story_usages: [],
    ambiguous_references: [],
    warnings: []
  };
}
