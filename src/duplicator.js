import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureArray, pathExists, sha256, writeJson, writeText } from './utils.js';
import { duplicateStoryblokComponents } from './storyblok.js';

export async function duplicateFrontendComponents(manifest, { repoPath = process.cwd(), dryRun = false } = {}) {
  const root = path.resolve(repoPath);
  const entries = ensureArray(manifest.repository?.components_to_duplicate);
  const results = [];

  for (const entry of entries) {
    const sourceRel = entry.source_path || entry.source;
    const targetRel = entry.target_path || entry.target;
    if (!sourceRel || !targetRel) throw new Error('frontend duplication entries require source_path and target_path');
    if (!targetRel.startsWith(`${manifest.repository_namespace}/`)) {
      throw new Error(`duplicate target must be inside repository namespace: ${targetRel}`);
    }
    const source = path.join(root, sourceRel);
    const target = path.join(root, targetRel);
    if (!(await pathExists(source))) throw new Error(`source component does not exist: ${sourceRel}`);
    if (await pathExists(target)) throw new Error(`refusing to overwrite duplicate target: ${targetRel}`);
    const content = await readFile(source, 'utf8');
    const rewritten = rewriteDuplicate(content, manifest, entry);
    if (!dryRun) {
      await writeText(target, rewritten);
    }
    results.push({
      action: 'duplicate_frontend_component',
      dry_run: dryRun,
      source_path: sourceRel,
      target_path: targetRel,
      source_hash: sha256(content),
      runtime_dependency_retained: false
    });
  }

  return results;
}

export async function duplicateRepositoryAssets(manifest, { repoPath = process.cwd(), dryRun = false } = {}) {
  const root = path.resolve(repoPath);
  const entries = ensureArray(manifest.repository?.assets_to_create).filter((entry) => entry.source_path && entry.target_path);
  const results = [];

  for (const entry of entries) {
    if (!entry.target_path.startsWith(`${manifest.repository_namespace}/`) && !entry.target_path.startsWith(`public/integrations/${manifest.integration_id}/`)) {
      throw new Error(`asset duplicate target must be inside integration namespace: ${entry.target_path}`);
    }
    const source = path.join(root, entry.source_path);
    const target = path.join(root, entry.target_path);
    if (!(await pathExists(source))) throw new Error(`source asset does not exist: ${entry.source_path}`);
    if (await pathExists(target)) throw new Error(`refusing to overwrite asset target: ${entry.target_path}`);
    if (!dryRun) {
      await copyFile(source, target);
    }
    results.push({
      action: 'duplicate_repository_asset',
      dry_run: dryRun,
      source_path: entry.source_path,
      target_path: entry.target_path,
      runtime_dependency_retained: false
    });
  }

  return results;
}

export async function duplicateAll(manifest, { repoPath = process.cwd(), dryRun = false } = {}) {
  return {
    action: 'duplicate',
    dry_run: dryRun,
    frontend_components: await duplicateFrontendComponents(manifest, { repoPath, dryRun }),
    repository_assets: await duplicateRepositoryAssets(manifest, { repoPath, dryRun }),
    storyblok_components: await duplicateStoryblokComponents(manifest, { dryRun })
  };
}

export async function writeDuplicationSnapshot(workDir, result) {
  return writeJson(path.join(workDir, 'duplication-result.json'), result);
}

function rewriteDuplicate(content, manifest, entry) {
  let rewritten = content;
  const replacements = {
    ...(entry.replacements || {}),
    ...(entry.export_name && entry.new_export_name ? { [entry.export_name]: entry.new_export_name } : {})
  };
  for (const [from, to] of Object.entries(replacements)) {
    rewritten = rewritten.split(from).join(to);
  }
  rewritten = `/* Duplicated and isolated for ${manifest.integration_id}. Source: ${entry.source_path || entry.source}. */\n${rewritten}`;
  rewritten = rewritten.replace(/\bclass(Name)?=(['"])([^'"]+)\2/g, (_match, classNameSuffix = '', quote, classes) => {
    const scoped = classes
      .split(/\s+/)
      .filter(Boolean)
      .map((className) => className.startsWith(`hts-${manifest.integration_id}-`) ? className : `hts-${manifest.integration_id}-${className}`)
      .join(' ');
    return `class${classNameSuffix || ''}=${quote}${scoped}${quote}`;
  });
  return rewritten;
}
