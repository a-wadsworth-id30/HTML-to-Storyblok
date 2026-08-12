import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { nowIso, pathExists, writeJson, writeText } from './utils.js';

export const DEFAULT_WORK_DIR = '.tmp/html-to-storyblok';

export async function ensureWorkDir(workDir = DEFAULT_WORK_DIR) {
  await mkdir(workDir, { recursive: true });
  return workDir;
}

export async function recordEvidence(workDir, event) {
  await ensureWorkDir(workDir);
  const entry = {
    timestamp: nowIso(),
    ...event
  };
  await appendFile(path.join(workDir, 'evidence.jsonl'), `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function writeArtifact(workDir, name, data) {
  await ensureWorkDir(workDir);
  const filePath = path.join(workDir, name);
  await writeJson(filePath, data);
  await recordEvidence(workDir, {
    type: 'artifact_written',
    artifact: filePath
  });
  return filePath;
}

export async function writeTextArtifact(workDir, name, content) {
  await ensureWorkDir(workDir);
  const filePath = path.join(workDir, name);
  await writeText(filePath, content);
  await recordEvidence(workDir, {
    type: 'artifact_written',
    artifact: filePath
  });
  return filePath;
}

export async function readEvidence(workDir = DEFAULT_WORK_DIR) {
  const filePath = path.join(workDir, 'evidence.jsonl');
  if (!(await pathExists(filePath))) return [];
  const content = await readFile(filePath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
