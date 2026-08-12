import path from 'node:path';
import { DEFAULT_WORK_DIR, ensureWorkDir } from './evidence.js';
import { ensureArray, nowIso, pathExists, readJson, writeJson } from './utils.js';

const HISTORY_NAME = 'import-history.json';
const HISTORY_DIR = 'history';
const HISTORY_LIMIT = 200;

export async function readIntegrationHistory(workDir = DEFAULT_WORK_DIR, { limit = HISTORY_LIMIT } = {}) {
  const historyPath = path.join(workDir, HISTORY_NAME);
  if (!(await pathExists(historyPath))) {
    return {
      action: 'integration_history',
      version: 1,
      updated_at: null,
      total: 0,
      entries: []
    };
  }
  const history = await readJson(historyPath);
  const entries = ensureArray(history.entries)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return {
    action: 'integration_history',
    version: history.version || 1,
    updated_at: history.updated_at || null,
    total: entries.length,
    entries: entries.slice(0, limit)
  };
}

export async function recordIntegrationHistory(workDir = DEFAULT_WORK_DIR, {
  manifest = null,
  action = 'unknown',
  status = null,
  reportPath = null,
  repoPath = null,
  repositorySkipped = false,
  validation = null,
  localValidation = null,
  result = null,
  error = null
} = {}) {
  if (!manifest?.integration_id) return null;
  await ensureWorkDir(workDir);

  const timestamp = nowIso();
  const integrationId = manifest.integration_id;
  const manifestSnapshot = await writeManifestSnapshot(workDir, integrationId, timestamp, manifest);
  const history = await readIntegrationHistory(workDir, { limit: HISTORY_LIMIT });
  const entry = {
    id: historyEntryId(integrationId, action, timestamp),
    timestamp,
    integration_id: integrationId,
    action,
    status: normalizeHistoryStatus(status, result, error),
    storyblok_prefix: manifest.storyblok_prefix || null,
    storyblok_folder: manifest.storyblok?.story_folder || integrationId,
    template_path: manifest.template?.source_path || null,
    repository_namespace: manifest.repository_namespace || null,
    repository_path: repoPath || null,
    repository_skipped: Boolean(repositorySkipped),
    manifest_snapshot: manifestSnapshot,
    report_path: reportPath || null,
    validation: summarizeValidation(validation || manifest.validation),
    local_validation: localValidation?.status || null,
    planned: summarizePlannedResources(manifest),
    result: summarizeResult(result),
    error: error ? String(error?.message || error) : null
  };
  const entries = [entry, ...history.entries].slice(0, HISTORY_LIMIT);
  await writeJson(path.join(workDir, HISTORY_NAME), {
    action: 'integration_history',
    version: 1,
    updated_at: timestamp,
    entries
  });
  return entry;
}

function summarizePlannedResources(manifest) {
  return {
    repository_files: count(manifest.repository?.files_to_create),
    repository_assets: count(manifest.repository?.assets_to_copy),
    storyblok_component_groups: count(manifest.storyblok?.component_groups_to_create),
    storyblok_components: count(manifest.storyblok?.components_to_create),
    storyblok_presets: count(manifest.storyblok?.presets_to_create),
    storyblok_assets: count(manifest.storyblok?.assets_to_upload),
    draft_stories: count(manifest.storyblok?.stories_to_create)
  };
}

function summarizeResult(result) {
  if (!result) return null;
  return {
    action: result.action || null,
    status: result.status || null,
    dry_run: Boolean(result.dry_run),
    steps_total: count(result.steps),
    steps_completed: ensureArray(result.steps).filter((step) => step.status !== 'failed').length,
    steps_failed: ensureArray(result.steps).filter((step) => step.status === 'failed').length,
    failed_step: ensureArray(result.steps).find((step) => step.status === 'failed')?.message || null,
    story_links: result.link_summary ? {
      total: result.link_summary.total_links || 0,
      resolved: result.link_summary.resolved_story_links || 0,
      unresolved: result.link_summary.unresolved_story_links || 0
    } : null
  };
}

function summarizeValidation(validation) {
  if (!validation) return null;
  return {
    valid: validation.valid === true,
    violations: count(validation.violations)
  };
}

async function writeManifestSnapshot(workDir, integrationId, timestamp, manifest) {
  const relativePath = `${HISTORY_DIR}/${safeSegment(integrationId)}/${safeTimestamp(timestamp)}-manifest.json`;
  await writeJson(path.join(workDir, relativePath), manifest);
  return relativePath;
}

function normalizeHistoryStatus(status, result, error) {
  if (error) return 'failed';
  if (status) return status;
  if (result?.dry_run) return 'dry_run_complete';
  if (result?.status) return result.status;
  return 'recorded';
}

function historyEntryId(integrationId, action, timestamp) {
  return `${safeTimestamp(timestamp)}-${safeSegment(integrationId)}-${safeSegment(action)}`;
}

function safeTimestamp(timestamp) {
  return String(timestamp).replace(/[:.]/g, '-');
}

function safeSegment(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function count(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}
