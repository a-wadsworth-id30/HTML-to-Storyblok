import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { namespaceCss } from './css-isolation.js';
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
    const targetExists = await pathExists(target);
    if (targetExists && !dryRun) throw new Error(`refusing to overwrite duplicate target: ${targetRel}`);
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
      target_exists: targetExists,
      runtime_dependency_retained: false
    });
  }

  return results;
}

export async function duplicateRepositoryAssets(manifest, { repoPath = process.cwd(), dryRun = false } = {}) {
  const root = path.resolve(repoPath);
  const entries = ensureArray(manifest.repository?.assets_to_create)
    .filter((entry) => entry.source_path && entry.target_path && entry.source_type !== 'template');
  const results = [];

  for (const entry of entries) {
    if (!entry.target_path.startsWith(`${manifest.repository_namespace}/`) && !entry.target_path.startsWith(`public/integrations/${manifest.integration_id}/`)) {
      throw new Error(`asset duplicate target must be inside integration namespace: ${entry.target_path}`);
    }
    const source = path.join(root, entry.source_path);
    const target = path.join(root, entry.target_path);
    if (!(await pathExists(source))) throw new Error(`source asset does not exist: ${entry.source_path}`);
    const targetExists = await pathExists(target);
    if (targetExists && !dryRun) throw new Error(`refusing to overwrite asset target: ${entry.target_path}`);
    if (!dryRun) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    results.push({
      action: 'duplicate_repository_asset',
      dry_run: dryRun,
      source_path: entry.source_path,
      target_path: entry.target_path,
      target_exists: targetExists,
      runtime_dependency_retained: false
    });
  }

  return results;
}

export async function duplicateAll(manifest, { repoPath = process.cwd(), dryRun = false, env = process.env } = {}) {
  return {
    action: 'duplicate',
    dry_run: dryRun,
    frontend_components: await duplicateFrontendComponents(manifest, { repoPath, dryRun }),
    repository_assets: await duplicateRepositoryAssets(manifest, { repoPath, dryRun }),
    storyblok_components: await duplicateStoryblokComponents(manifest, { dryRun, env })
  };
}

export async function writeDuplicationSnapshot(workDir, result) {
  return writeJson(path.join(workDir, 'duplication-result.json'), result);
}

function rewriteDuplicate(content, manifest, entry) {
  if (isStyleDuplicate(entry)) {
    return rewriteStyleDuplicate(content, manifest, entry);
  }
  if (isDataDuplicate(entry)) {
    return String(content);
  }
  return rewriteSourceDuplicate(content, manifest, entry);
}

function rewriteStyleDuplicate(content, manifest, entry) {
  let rewritten = applyImportRewrites(content, entry);
  rewritten = applyCssUrlRewrites(rewritten, entry);
  rewritten = namespaceCss(rewritten, manifest.integration_id);
  return `/* Duplicated and isolated for ${manifest.integration_id}. Source: ${entry.source_path || entry.source}. */\n${rewritten}\n`;
}

function rewriteSourceDuplicate(content, manifest, entry) {
  let rewritten = applyImportRewrites(content, entry);
  for (const [from, to] of Object.entries(entry.replacements || {})) {
    rewritten = rewritten.split(from).join(to);
  }
  if (entry.export_name && entry.new_export_name) {
    rewritten = replaceIdentifierOutsideQuotedStrings(rewritten, entry.export_name, entry.new_export_name);
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

function applyImportRewrites(content, entry) {
  let rewritten = content;
  for (const [from, to] of Object.entries(entry.import_rewrites || {})) {
    rewritten = rewriteImportSpecifier(rewritten, from, to);
  }
  return rewritten;
}

function isStyleDuplicate(entry) {
  const source = entry.source_path || entry.source || '';
  const target = entry.target_path || entry.target || '';
  return entry.content_kind === 'style' || /\.(css|scss|sass|less)$/i.test(source) || /\.(css|scss|sass|less)$/i.test(target);
}

function isDataDuplicate(entry) {
  const source = entry.source_path || entry.source || '';
  const target = entry.target_path || entry.target || '';
  return entry.content_kind === 'data' || /\.json$/i.test(source) || /\.json$/i.test(target);
}

function applyCssUrlRewrites(content, entry) {
  const rewrites = {
    ...(entry.import_rewrites || {}),
    ...(entry.asset_rewrites || {})
  };
  return String(content).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, ref) => {
    const rewritten = rewrites[ref];
    if (!rewritten) return match;
    return `url(${quote || ''}${rewritten}${quote || ''})`;
  });
}

function rewriteImportSpecifier(content, from, to) {
  const escaped = escapeRegExp(from);
  return content.replace(new RegExp(`(['"])${escaped}\\1`, 'g'), (_match, quote) => `${quote}${to}${quote}`);
}

function replaceIdentifierOutsideQuotedStrings(content, from, to) {
  const source = String(content);
  const identifier = String(from);
  if (!identifier) return source;
  let output = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\') {
        output += source[index + 1] || '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (
      source.startsWith(identifier, index) &&
      !isIdentifierCharacter(source[index - 1]) &&
      !isIdentifierCharacter(source[index + identifier.length])
    ) {
      output += to;
      index += identifier.length;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function isIdentifierCharacter(char) {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
