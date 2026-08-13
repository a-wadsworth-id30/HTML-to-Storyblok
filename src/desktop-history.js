import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_RUN_HISTORY_LIMIT = 50;
export const DESKTOP_RUN_HISTORY_FILE = 'desktop-run-history.json';

export function desktopRunHistoryPath(runtime) {
  return path.join(runtime.user_data_path, DESKTOP_RUN_HISTORY_FILE);
}

export async function readDesktopRunHistory(runtime) {
  try {
    const raw = await readFile(desktopRunHistoryPath(runtime), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.runs)) return [];
    return parsed.runs.map(sanitizeRunEntry).filter(Boolean).slice(0, DESKTOP_RUN_HISTORY_LIMIT);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return [];
  }
}

export async function recordDesktopRun(runtime, entry) {
  const existing = await readDesktopRunHistory(runtime);
  const nextEntry = sanitizeRunEntry(entry);
  if (!nextEntry) return existing;

  const runs = [
    nextEntry,
    ...existing.filter((run) => run.request_id !== nextEntry.request_id)
  ].slice(0, DESKTOP_RUN_HISTORY_LIMIT);

  const filePath = desktopRunHistoryPath(runtime);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ runs }, null, 2)}\n`, 'utf8');
  return runs;
}

export function createDesktopRunRecord({
  requestId,
  action,
  commandLine,
  workDir,
  manifestPath,
  startedAt,
  endedAt,
  durationMs,
  status,
  exitCode = null,
  signal = null,
  envKeys = [],
  error = ''
}) {
  return sanitizeRunEntry({
    request_id: requestId,
    action_id: action?.id || '',
    action_title: action?.title || '',
    safety: action?.safety || '',
    command_line: commandLine,
    work_dir: workDir,
    manifest_path: manifestPath,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    status,
    exit_code: exitCode,
    signal,
    env_keys: envKeys,
    error
  });
}

function sanitizeRunEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const requestId = normalize(entry.request_id);
  const actionId = normalize(entry.action_id);
  if (!requestId || !actionId) return null;

  return {
    request_id: requestId,
    action_id: actionId,
    action_title: normalize(entry.action_title),
    safety: normalize(entry.safety),
    command_line: normalize(entry.command_line),
    work_dir: normalize(entry.work_dir),
    manifest_path: normalize(entry.manifest_path),
    started_at: normalize(entry.started_at),
    ended_at: normalize(entry.ended_at),
    duration_ms: normalizeInteger(entry.duration_ms),
    status: normalizeStatus(entry.status),
    exit_code: entry.exit_code === null || entry.exit_code === undefined ? null : normalizeInteger(entry.exit_code),
    signal: normalize(entry.signal),
    env_keys: normalizeStringArray([...(entry.env_keys || []), ...(entry.envKeys || [])]),
    error: normalize(entry.error)
  };
}

function normalize(value) {
  return String(value || '').trim();
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(normalize).filter(Boolean).sort() : [];
}

function normalizeStatus(status) {
  const value = normalize(status).toLowerCase();
  return ['passed', 'failed', 'cancelled'].includes(value) ? value : 'failed';
}
