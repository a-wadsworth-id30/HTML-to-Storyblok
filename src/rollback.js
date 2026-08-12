import { readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validatePlan } from './policy.js';
import { deleteStoryblokIntegrationResources } from './storyblok.js';
import { ensureArray, nowIso, pathExists, sha256 } from './utils.js';

export function createRollbackPreview(manifest, { repoPath = process.cwd() } = {}) {
  const validation = validatePlan(manifest);
  const repositoryFiles = unique([
    ...ensureArray(manifest.repository?.files_to_create),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => asset.target_path || asset.path).filter(Boolean)
  ]);
  const preview = {
    action: 'rollback_preview',
    dry_run: true,
    policy: 'manual_confirmation_required',
    repository_path: path.resolve(repoPath),
    integration_id: manifest.integration_id,
    validation,
    repository_files_to_remove: repositoryFiles.map((file) => ({
      path: file,
      owned_by_integration: isOwnedRepositoryPath(manifest, file)
    })),
    empty_directories_to_prune: pruneDirectoriesForFiles(manifest, repositoryFiles),
    storyblok_component_groups_to_remove: ensureArray(manifest.storyblok?.component_groups_to_create).map((group) => group.path || group.name || group),
    storyblok_internal_tags_to_remove: ensureArray(manifest.storyblok?.internal_tags_to_create).map((tag) => tag.name || tag.tag || tag),
    storyblok_components_to_remove: [
      ...ensureArray(manifest.storyblok?.components_to_create),
      ...ensureArray(manifest.storyblok?.components_to_duplicate)
    ].map((component) => component.technical_name || component.name || component),
    storyblok_presets_to_remove: ensureArray(manifest.storyblok?.presets_to_create).map((preset) => preset.name || preset.component_technical_name || preset.component),
    storyblok_stories_to_remove: ensureArray(manifest.storyblok?.stories_to_create).map((story) => story.slug || story.full_slug),
    storyblok_assets_to_remove: ensureArray(manifest.storyblok?.assets_to_create).map((asset) => asset.id || asset.filename || asset.local_path),
    remote_rollback: 'manual_or_future_confirmed_remote_operation',
    note: 'Preview only unless used through rollback with --confirm-integration-id. Rollback never removes resources outside the integration namespace.'
  };
  preview.rollback_ledger = createRollbackLedger(manifest, preview, {
    phase: 'preview',
    dryRun: true,
    repoPath,
    hashVerification: null,
    removed: [],
    missing: [],
    prunedDirectories: [],
    remoteRequested: false,
    remoteConfirmed: false,
    remoteRollback: null
  });
  return preview;
}

export async function rollbackIntegration(manifest, {
  repoPath = process.cwd(),
  dryRun = false,
  confirmIntegrationId,
  remote = false,
  confirmRemoteDelete = false,
  allowModifiedGeneratedFiles = false,
  env = process.env
} = {}) {
  if (confirmIntegrationId !== manifest.integration_id) {
    throw new Error('rollback requires --confirm-integration-id matching the manifest integration_id');
  }
  const preview = createRollbackPreview(manifest, { repoPath });
  if (!preview.validation.valid) {
    throw new Error('rollback refused because the manifest failed policy validation');
  }
  const unsafe = preview.repository_files_to_remove.filter((entry) => !entry.owned_by_integration);
  if (unsafe.length > 0) {
    throw new Error(`rollback refused because paths are outside the integration namespace: ${unsafe.map((entry) => entry.path).join(', ')}`);
  }

  const root = path.resolve(repoPath);
  const drift = await verifyGeneratedFileHashes(manifest, root, preview.repository_files_to_remove);
  if (drift.modified.length > 0 && !allowModifiedGeneratedFiles) {
    throw new Error(`rollback refused because generated files were modified after creation: ${drift.modified.map((entry) => entry.path).join(', ')}. Review the files or rerun with --allow-modified-generated-files.`);
  }
  const removed = [];
  const missing = [];
  for (const entry of preview.repository_files_to_remove) {
    const fullPath = path.join(root, entry.path);
    if (!(await pathExists(fullPath))) {
      missing.push(entry.path);
      continue;
    }
    if (!dryRun) {
      await unlink(fullPath);
    }
    removed.push(entry.path);
  }

  const prunedDirectories = [];
  for (const directory of preview.empty_directories_to_prune) {
    const fullPath = path.join(root, directory);
    if (dryRun || !(await pathExists(fullPath))) continue;
    if (await isDirectoryEmpty(fullPath)) {
      await rmdir(fullPath);
      prunedDirectories.push(directory);
    }
  }

  const remoteRollback = remote
    ? await deleteStoryblokIntegrationResources(manifest, {
      dryRun,
      env,
      confirmIntegrationId,
      confirmRemoteDelete
    })
    : null;

  const result = {
    action: 'rollback',
    dry_run: dryRun,
    integration_id: manifest.integration_id,
    repository_files_removed: removed,
    repository_files_missing: missing,
    repository_file_hash_verification: drift,
    directories_pruned: prunedDirectories,
    remote_rollback: remoteRollback,
    remote_resources_not_removed: remote ? null : {
      storyblok_component_groups: preview.storyblok_component_groups_to_remove,
      storyblok_internal_tags: preview.storyblok_internal_tags_to_remove,
      storyblok_components: preview.storyblok_components_to_remove,
      storyblok_presets: preview.storyblok_presets_to_remove,
      storyblok_stories: preview.storyblok_stories_to_remove,
      storyblok_assets: preview.storyblok_assets_to_remove,
      reason: 'Pass --remote --confirm-remote-delete to delete integration-owned Storyblok draft resources.'
    }
  };
  result.rollback_ledger = createRollbackLedger(manifest, preview, {
    phase: 'rollback',
    dryRun,
    repoPath,
    hashVerification: drift,
    removed,
    missing,
    prunedDirectories,
    remoteRequested: remote,
    remoteConfirmed: confirmRemoteDelete,
    remoteRollback
  });
  return result;
}

function createRollbackLedger(manifest, preview, {
  phase,
  dryRun,
  repoPath,
  hashVerification,
  removed,
  missing,
  prunedDirectories,
  remoteRequested,
  remoteConfirmed,
  remoteRollback
}) {
  const localTargets = ensureArray(preview.repository_files_to_remove);
  const unsafeLocalTargets = localTargets.filter((entry) => !entry.owned_by_integration);
  const remoteTargets = rollbackRemoteTargets(preview);
  const hash = hashVerification || {
    status: 'pending',
    ledger_path: `${manifest.repository_namespace}/generated-file-hashes.json`,
    verified: [],
    modified: [],
    missing_hashes: [],
    note: 'Hash verification runs during confirmed rollback.'
  };
  const remoteResults = ensureArray(remoteRollback);
  return {
    action: 'rollback_ledger',
    phase,
    created_at: nowIso(),
    dry_run: Boolean(dryRun),
    integration_id: manifest.integration_id,
    repository_path: path.resolve(repoPath),
    policy: 'additive-only-owned-resources',
    confirmation: {
      integration_id_required: manifest.integration_id,
      integration_id_confirmed: phase === 'rollback',
      remote_delete_requested: Boolean(remoteRequested),
      remote_delete_confirmed: Boolean(remoteConfirmed),
      remote_delete_requires: '--remote --confirm-remote-delete'
    },
    local: {
      targets: localTargets.length,
      owned_targets: localTargets.length - unsafeLocalTargets.length,
      unsafe_targets: unsafeLocalTargets.map((entry) => entry.path),
      removed: ensureArray(removed),
      missing: ensureArray(missing),
      directories_to_prune: ensureArray(preview.empty_directories_to_prune),
      directories_pruned: ensureArray(prunedDirectories),
      hash_verification: {
        status: hash.status,
        ledger_path: hash.ledger_path,
        verified: ensureArray(hash.verified).length,
        modified: ensureArray(hash.modified).length,
        missing_hashes: ensureArray(hash.missing_hashes).length,
        note: hash.note || null
      }
    },
    remote: {
      requested: Boolean(remoteRequested),
      confirmed: Boolean(remoteConfirmed),
      targets: remoteTargets,
      total_targets: Object.values(remoteTargets).reduce((total, count) => total + count, 0),
      results: summarizeRemoteRollbackResults(remoteResults)
    },
    risk_flags: rollbackRiskFlags({
      validation: preview.validation,
      unsafeLocalTargets,
      hash,
      remoteRequested,
      remoteConfirmed,
      remoteTargets,
      remoteResults
    })
  };
}

function rollbackRemoteTargets(preview) {
  return {
    component_groups: ensureArray(preview.storyblok_component_groups_to_remove).length,
    internal_tags: ensureArray(preview.storyblok_internal_tags_to_remove).length,
    components: ensureArray(preview.storyblok_components_to_remove).length,
    presets: ensureArray(preview.storyblok_presets_to_remove).length,
    stories: ensureArray(preview.storyblok_stories_to_remove).length,
    assets: ensureArray(preview.storyblok_assets_to_remove).length
  };
}

function summarizeRemoteRollbackResults(results) {
  return results.reduce((summary, result) => {
    const status = result.status || 'recorded';
    summary.total += 1;
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, { total: 0 });
}

function rollbackRiskFlags({ validation, unsafeLocalTargets, hash, remoteRequested, remoteConfirmed, remoteTargets, remoteResults }) {
  const flags = [];
  if (!validation?.valid) flags.push('manifest_policy_validation_failed');
  if (unsafeLocalTargets.length > 0) flags.push('unsafe_repository_targets');
  if (hash.status === 'unavailable') flags.push('hash_ledger_unavailable');
  if (ensureArray(hash.modified).length > 0) flags.push('generated_file_drift_detected');
  if (ensureArray(hash.missing_hashes).length > 0) flags.push('missing_hash_entries');
  if (remoteTargets && Object.values(remoteTargets).some((count) => count > 0) && !remoteRequested) flags.push('remote_resources_not_requested');
  if (remoteRequested && !remoteConfirmed) flags.push('remote_delete_not_confirmed');
  if (remoteResults.some((result) => result.status === 'refused' || result.status === 'failed')) flags.push('remote_rollback_failures');
  return flags;
}

async function verifyGeneratedFileHashes(manifest, root, entries) {
  const ledger = await readHashLedger(manifest, root);
  if (!ledger) {
    return {
      status: 'unavailable',
      ledger_path: `${manifest.repository_namespace}/generated-file-hashes.json`,
      verified: [],
      modified: [],
      missing_hashes: entries.map((entry) => entry.path),
      note: 'No generated hash ledger was found; legacy rollback path verification is namespace-only.'
    };
  }
  const expected = new Map(ensureArray(ledger.files).map((entry) => [entry.path, entry]));
  const verified = [];
  const modified = [];
  const missingHashes = [];
  for (const entry of entries) {
    if (entry.path.endsWith('/generated-file-hashes.json')) continue;
    const hash = expected.get(entry.path);
    if (!hash) {
      missingHashes.push(entry.path);
      continue;
    }
    const fullPath = path.join(root, entry.path);
    if (!(await pathExists(fullPath))) continue;
    const actual = sha256(await readFile(fullPath));
    if (actual === hash.sha256) {
      verified.push(entry.path);
    } else {
      modified.push({
        path: entry.path,
        expected_sha256: hash.sha256,
        actual_sha256: actual
      });
    }
  }
  return {
    status: modified.length > 0 ? 'failed' : 'passed',
    ledger_path: `${manifest.repository_namespace}/generated-file-hashes.json`,
    verified,
    modified,
    missing_hashes: missingHashes
  };
}

async function readHashLedger(manifest, root) {
  const ledgerPath = path.join(root, manifest.repository_namespace, 'generated-file-hashes.json');
  try {
    return JSON.parse(await readFile(ledgerPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`rollback hash ledger is not valid: ${error.message || String(error)}`);
  }
}

function pruneDirectoriesForFiles(manifest, repositoryFiles) {
  const directories = [];
  for (const file of repositoryFiles) {
    let directory = path.posix.dirname(toPosix(file));
    while (directory && directory !== '.') {
      if (isOwnedRepositoryPath(manifest, directory)) directories.push(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return unique(directories)
    .sort((a, b) => pathDepth(b) - pathDepth(a) || b.length - a.length);
}

function isOwnedRepositoryPath(manifest, filePath) {
  const file = toPosix(filePath);
  const namespace = toPosix(manifest.repository_namespace);
  const publicNamespace = `public/integrations/${manifest.integration_id}`;
  return file === namespace ||
    file.startsWith(`${namespace}/`) ||
    file === publicNamespace ||
    file.startsWith(`${publicNamespace}/`);
}

function pathDepth(filePath) {
  return toPosix(filePath).split('/').filter(Boolean).length;
}

function toPosix(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/\/+$/g, '');
}

async function isDirectoryEmpty(directory) {
  try {
    const entries = await readdir(directory);
    return entries.length === 0;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
