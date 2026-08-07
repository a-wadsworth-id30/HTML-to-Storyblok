import { readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validatePlan } from './policy.js';
import { deleteStoryblokIntegrationResources } from './storyblok.js';
import { ensureArray, pathExists } from './utils.js';

export function createRollbackPreview(manifest, { repoPath = process.cwd() } = {}) {
  const validation = validatePlan(manifest);
  const repositoryFiles = unique([
    ...ensureArray(manifest.repository?.files_to_create),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => asset.target_path || asset.path).filter(Boolean)
  ]);
  return {
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
}

export async function rollbackIntegration(manifest, {
  repoPath = process.cwd(),
  dryRun = false,
  confirmIntegrationId,
  remote = false,
  confirmRemoteDelete = false,
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

  return {
    action: 'rollback',
    dry_run: dryRun,
    integration_id: manifest.integration_id,
    repository_files_removed: removed,
    repository_files_missing: missing,
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
