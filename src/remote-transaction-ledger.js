import { ensureArray, nowIso } from './utils.js';

const MUTATION_STATUSES = new Set(['created', 'updated_link_metadata']);

export function createRemoteTransactionLedger(manifest, {
  steps = [],
  dryRun = false,
  workflow = 'apply_manifest'
} = {}) {
  const transactions = collectTransactions(steps, manifest);
  const summary = summarizeTransactions(transactions);
  const safety = {
    remote_mutations: summary.created + summary.updated_link_metadata,
    reused_or_verified: summary.already_exists,
    dry_run_transactions: summary.dry_run,
    skipped_optional: summary.skipped_optional,
    published_stories: transactions.filter((entry) => entry.resource_type === 'storyblok_draft_story' && entry.published).length,
    unnamespaced_resources: transactions.filter((entry) => entry.namespaced === false).length,
    rollback_requires_confirmation: true
  };
  return {
    action: 'remote_transaction_ledger',
    workflow,
    status: safety.unnamespaced_resources > 0 || safety.published_stories > 0
      ? 'failed'
      : dryRun ? 'planned' : 'recorded',
    created_at: nowIso(),
    dry_run: Boolean(dryRun),
    integration_id: manifest.integration_id,
    storyblok_prefix: manifest.storyblok_prefix,
    policy: 'additive-only-namespaced-draft-resources',
    transaction_count: transactions.length,
    summary,
    rollback_scope: summarizeRollbackScope(transactions),
    safety,
    transactions
  };
}

function collectTransactions(steps, manifest) {
  return ensureArray(steps)
    .flatMap((step, stepIndex) => transactionsForStep(step, stepIndex, manifest))
    .filter(Boolean);
}

function transactionsForStep(step, stepIndex, manifest) {
  const results = ensureArray(step?.results);
  const nested = results.flatMap((result, resultIndex) => [
    transactionForResult(result, { step, stepIndex, resultIndex }, manifest),
    ...ensureArray(result?.folder_results).map((folder, folderIndex) => transactionForResult(folder, {
      step,
      stepIndex,
      resultIndex,
      nestedIndex: folderIndex,
      parentAction: result.action
    }, manifest))
  ]);
  return nested.filter(Boolean);
}

function transactionForResult(result, context, manifest) {
  if (!result || !isRemoteResult(result)) return null;
  const resourceType = resourceTypeForAction(result.action);
  const status = result.status || (result.dry_run ? 'planned' : 'recorded');
  const key = resourceKey(result);
  return {
    action: result.action,
    status,
    dry_run: Boolean(result.dry_run),
    step: context.step?.action || null,
    step_index: context.stepIndex,
    result_index: context.resultIndex,
    nested_index: context.nestedIndex ?? null,
    parent_action: context.parentAction || null,
    resource_type: resourceType,
    resource_key: key,
    namespaced: isNamespacedResource(result, key, manifest),
    id: result.id || result.verification?.id || null,
    uuid: result.uuid || result.verification?.uuid || null,
    editor_url: result.editor_url || null,
    published: Boolean(result.published),
    rollback_allowed: rollbackAllowed(result, resourceType),
    rollback_scope: rollbackScopeFor(resourceType, result, key),
    evidence: evidenceForResult(result)
  };
}

function isRemoteResult(result) {
  return [
    'create_component_group',
    'create_internal_tag',
    'create_component',
    'duplicate_storyblok_component',
    'create_asset_folder',
    'upload_asset',
    'create_component_preset',
    'create_story_folder',
    'create_draft_story'
  ].includes(result.action);
}

function resourceTypeForAction(action) {
  return {
    create_component_group: 'storyblok_component_group',
    create_internal_tag: 'storyblok_internal_tag',
    create_component: 'storyblok_component',
    duplicate_storyblok_component: 'storyblok_component',
    create_asset_folder: 'storyblok_asset_folder',
    upload_asset: 'storyblok_asset',
    create_component_preset: 'storyblok_component_preset',
    create_story_folder: 'storyblok_story_folder',
    create_draft_story: 'storyblok_draft_story'
  }[action] || 'storyblok_resource';
}

function resourceKey(result) {
  return result.technical_name ||
    result.group_path ||
    result.folder_path ||
    result.slug ||
    result.name ||
    result.filename ||
    result.target_path ||
    result.local_path ||
    result.object_type ||
    result.action;
}

function isNamespacedResource(result, key, manifest) {
  if (!key) return null;
  if (key === manifest.integration_id || String(key).startsWith(`${manifest.integration_id}/`)) return true;
  if (manifest.storyblok_prefix && String(key).startsWith(manifest.storyblok_prefix)) return true;
  if (result.action === 'upload_asset') return true;
  if (result.action === 'create_story_folder') return true;
  if (result.action === 'create_internal_tag') return /^hts_|^html-to-storyblok|^HTML-to-Storyblok/i.test(String(key));
  return /^hts_|^[a-z0-9-]+\/|^src\/integrations\/|^public\/integrations\//i.test(String(key));
}

function rollbackAllowed(result, resourceType) {
  if (result.dry_run) return false;
  if (resourceType === 'storyblok_draft_story') return !result.published;
  if (result.status === 'created' || result.status === 'updated_link_metadata') return true;
  return false;
}

function rollbackScopeFor(resourceType, result, key) {
  return {
    resource_type: resourceType,
    key,
    id: result.id || result.verification?.id || null,
    uuid: result.uuid || result.verification?.uuid || null,
    status: result.status || (result.dry_run ? 'planned' : 'recorded')
  };
}

function evidenceForResult(result) {
  return {
    collision_policy: result.collision_policy || null,
    link_resolution: result.link_resolution || null,
    asset_resolution: result.asset_resolution || null,
    link_summary: result.link_summary || null,
    source_sha256: result.source_sha256 || null,
    bytes: result.bytes || null,
    verification: compactVerification(result.verification)
  };
}

function compactVerification(verification) {
  if (!verification) return null;
  return {
    id: verification.id || null,
    uuid: verification.uuid || null,
    name: verification.name || verification.technical_name || null,
    slug: verification.slug || verification.full_slug || null,
    filename: verification.filename || null
  };
}

function summarizeTransactions(transactions) {
  return transactions.reduce((summary, transaction) => {
    summary.total += 1;
    summary[transaction.status] = (summary[transaction.status] || 0) + 1;
    summary.by_resource_type[transaction.resource_type] = (summary.by_resource_type[transaction.resource_type] || 0) + 1;
    if (transaction.dry_run) summary.dry_run += 1;
    if (MUTATION_STATUSES.has(transaction.status)) summary.mutating += 1;
    if (transaction.rollback_allowed) summary.rollback_allowed += 1;
    return summary;
  }, {
    total: 0,
    created: 0,
    already_exists: 0,
    updated_link_metadata: 0,
    skipped_optional: 0,
    planned: 0,
    recorded: 0,
    dry_run: 0,
    mutating: 0,
    rollback_allowed: 0,
    by_resource_type: {}
  });
}

function summarizeRollbackScope(transactions) {
  return transactions
    .filter((transaction) => transaction.rollback_allowed)
    .reduce((scope, transaction) => {
      const bucket = bucketForResourceType(transaction.resource_type);
      scope[bucket].push(transaction.rollback_scope);
      return scope;
    }, {
      component_groups: [],
      internal_tags: [],
      components: [],
      asset_folders: [],
      assets: [],
      presets: [],
      stories: [],
      story_folders: []
    });
}

function bucketForResourceType(resourceType) {
  return {
    storyblok_component_group: 'component_groups',
    storyblok_internal_tag: 'internal_tags',
    storyblok_component: 'components',
    storyblok_asset_folder: 'asset_folders',
    storyblok_asset: 'assets',
    storyblok_component_preset: 'presets',
    storyblok_draft_story: 'stories',
    storyblok_story_folder: 'story_folders'
  }[resourceType] || 'stories';
}
