import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDesktopRunRecord,
  DESKTOP_RUN_HISTORY_LIMIT,
  desktopRunHistoryPath,
  readDesktopRunHistory,
  recordDesktopRun
} from '../src/desktop-history.js';

test('desktop run history records latest sanitized runs first', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hts-desktop-history-'));
  const runtime = runtimeFor(temp);
  try {
    await recordDesktopRun(runtime, createRecord('one', 'inspectTemplate', 'passed'));
    await recordDesktopRun(runtime, createRecord('two', 'fullApply', 'failed', {
      envKeys: ['STORYBLOK_SPACE_ID', 'STORYBLOK_MANAGEMENT_TOKEN'],
      error: 'repository preflight failed'
    }));

    const history = await readDesktopRunHistory(runtime);
    assert.equal(history.length, 2);
    assert.equal(history[0].request_id, 'two');
    assert.equal(history[0].status, 'failed');
    assert.deepEqual(history[0].env_keys, ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_SPACE_ID']);
    assert.equal(history[0].error, 'repository preflight failed');
    assert.equal(history[1].request_id, 'one');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('desktop run history is bounded and resilient to corrupt files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hts-desktop-history-'));
  const runtime = runtimeFor(temp);
  try {
    for (let index = 0; index < DESKTOP_RUN_HISTORY_LIMIT + 5; index += 1) {
      await recordDesktopRun(runtime, createRecord(`run-${index}`, 'dashboard', 'passed'));
    }

    const history = await readDesktopRunHistory(runtime);
    assert.equal(history.length, DESKTOP_RUN_HISTORY_LIMIT);
    assert.equal(history[0].request_id, `run-${DESKTOP_RUN_HISTORY_LIMIT + 4}`);

    await writeFile(desktopRunHistoryPath(runtime), '{not json', 'utf8');
    assert.deepEqual(await readDesktopRunHistory(runtime), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('desktop run record excludes credential values and normalizes status', () => {
  const record = createDesktopRunRecord({
    requestId: 'abc',
    action: {
      id: 'storyblokApply',
      title: 'Storyblok Real Apply',
      safety: 'remote-write'
    },
    commandLine: 'html-to-storyblok storyblok-apply --manifest .tmp/html-to-storyblok/integration-manifest.json',
    workDir: '.tmp/html-to-storyblok',
    manifestPath: '.tmp/html-to-storyblok/integration-manifest.json',
    startedAt: '2026-08-13T10:00:00.000Z',
    endedAt: '2026-08-13T10:00:03.000Z',
    durationMs: 3012,
    status: 'unknown',
    exitCode: 1,
    envKeys: ['STORYBLOK_MANAGEMENT_TOKEN']
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.action_title, 'Storyblok Real Apply');
  assert.deepEqual(record.env_keys, ['STORYBLOK_MANAGEMENT_TOKEN']);
  assert.doesNotMatch(JSON.stringify(record), /management-secret|preview-secret/);
});

test('desktop renderer exposes a run history panel through read-only IPC', async () => {
  const mainSource = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const preloadSource = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');

  assert.match(mainSource, /desktop:read-run-history/);
  assert.match(mainSource, /recordDesktopRun/);
  assert.match(preloadSource, /readRunHistory/);
  assert.match(html, /Run History/);
  assert.match(html, /id="runHistory"/);
  assert.match(renderer, /renderRunHistory/);
  assert.match(renderer, /refreshRunHistory/);
});

function createRecord(requestId, actionId, status, overrides = {}) {
  return {
    request_id: requestId,
    action_id: actionId,
    action_title: actionId,
    safety: 'read-only',
    command_line: `html-to-storyblok ${actionId}`,
    work_dir: '.tmp/html-to-storyblok',
    manifest_path: '.tmp/html-to-storyblok/integration-manifest.json',
    started_at: '2026-08-13T10:00:00.000Z',
    ended_at: '2026-08-13T10:00:01.000Z',
    duration_ms: 1000,
    status,
    exit_code: status === 'passed' ? 0 : 1,
    signal: '',
    env_keys: [],
    error: '',
    ...overrides
  };
}

function runtimeFor(temp) {
  return {
    app_root: temp,
    user_data_path: path.join(temp, 'user-data')
  };
}
