import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { walkFiles } from './inspectors.js';
import { ensureArray, relativeTo, sha256, unique } from './utils.js';

const FRONTEND_COMPONENT_EXTENSIONS = new Set(['.astro', '.vue', '.js', '.jsx', '.ts', '.tsx', '.mjs']);
const COMPONENT_PATH_PATTERNS = [
  /(^|\/)components?\//i,
  /(^|\/)blocks?\//i,
  /(^|\/)sections?\//i,
  /(^|\/)ui\//i,
  /(^|\/)storyblok\//i,
  /(^|\/)bloks?\//i
];
const RUNTIME_IMPORT_PATTERN = /\b(?:import\s+(?:[^'"()]+?\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
const SAFE_DEPENDENCY_SOURCE_PATTERNS = [
  /^(src\/)?components?\//i,
  /^(src\/)?blocks?\//i,
  /^(src\/)?sections?\//i,
  /^(src\/)?ui\//i,
  /^(src\/)?storyblok\//i,
  /^(src\/)?bloks?\//i,
  /^(src\/)?lib\//i,
  /^(src\/)?utils?\//i,
  /^(src\/)?hooks?\//i,
  /^(src\/)?composables?\//i
];
const MAX_DEPENDENCY_FILES = 16;
const MAX_DEPENDENCY_DEPTH = 5;
const MAX_DEPENDENCY_BYTES = 1_500_000;
const SIGNAL_SYNONYMS = new Map([
  ['navigation', ['nav', 'navbar', 'menu']],
  ['feature_grid', ['features', 'feature-list', 'cards', 'card-grid']],
  ['content_section', ['content', 'section', 'rich-text', 'text']],
  ['template_page', ['page', 'layout']]
]);

export async function inferDuplicationCandidates(manifest, {
  repoPath = process.cwd(),
  storyblokInspection = null,
  maxFrontend = 8,
  maxStoryblok = 8
} = {}) {
  const signals = buildManifestSignals(manifest);
  const [frontendComponents, storyblokComponents] = await Promise.all([
    inferFrontendComponentCandidates(manifest, { repoPath, signals, max: maxFrontend }),
    inferStoryblokComponentCandidates(manifest, { storyblokInspection, signals, max: maxStoryblok })
  ]);

  return {
    action: 'infer_duplication_candidates',
    repository_path: path.resolve(repoPath),
    integration_id: manifest.integration_id,
    signals: signals.map((signal) => signal.key),
    repository: {
      components_to_duplicate: frontendComponents
    },
    storyblok: {
      components_to_duplicate: storyblokComponents
    },
    summary: {
      frontend_components: frontendComponents.filter((entry) => !entry.dependency_of).length,
      frontend_dependency_files: frontendComponents.filter((entry) => entry.dependency_of).length,
      storyblok_components: storyblokComponents.length
    }
  };
}

export async function applyInferredDuplicationCandidates(manifest, options = {}) {
  const inference = await inferDuplicationCandidates(manifest, options);
  manifest.repository ||= {};
  manifest.storyblok ||= {};
  manifest.repository.components_to_duplicate ||= [];
  manifest.storyblok.components_to_duplicate ||= [];

  for (const candidate of inference.repository.components_to_duplicate) {
    appendUniqueByTarget(manifest.repository.components_to_duplicate, candidate, 'target_path');
  }

  const duplicatedStoryblokTargets = new Set();
  for (const candidate of inference.storyblok.components_to_duplicate) {
    if (appendUniqueByTarget(manifest.storyblok.components_to_duplicate, candidate, 'technical_name')) {
      duplicatedStoryblokTargets.add(candidate.technical_name);
    }
  }
  if (duplicatedStoryblokTargets.size > 0) {
    manifest.storyblok.components_to_create = ensureArray(manifest.storyblok.components_to_create)
      .filter((component) => !duplicatedStoryblokTargets.has(component.technical_name || component.name));
  }

  manifest.duplication_inference = {
    enabled: true,
    repository_components: inference.summary.frontend_components,
    repository_dependency_files: inference.summary.frontend_dependency_files,
    storyblok_components: inference.summary.storyblok_components,
    generated_at: new Date().toISOString()
  };

  return inference;
}

async function inferFrontendComponentCandidates(manifest, { repoPath, signals, max }) {
  const root = path.resolve(repoPath);
  const files = await walkFiles(root);
  const scored = [];
  const reservedTargets = new Set([
    ...ensureArray(manifest.repository?.files_to_create),
    ...ensureArray(manifest.repository?.components_to_duplicate).map((entry) => entry.target_path || entry.target)
  ].filter(Boolean));
  const existingSources = new Set(ensureArray(manifest.repository?.components_to_duplicate).map((entry) => entry.source_path || entry.source));
  const sourceTargetMap = new Map(ensureArray(manifest.repository?.components_to_duplicate)
    .filter((entry) => entry.source_path && entry.target_path)
    .map((entry) => [entry.source_path, entry.target_path]));
  const fileSet = new Set(files.map((file) => relativeTo(root, file)));
  let acceptedRoots = 0;

  for (const file of files) {
    if (acceptedRoots >= max) break;
    const rel = relativeTo(root, file);
    if (rel.startsWith(`${manifest.repository_namespace}/`)) continue;
    if (existingSources.has(rel)) continue;
    if (!isFrontendComponentPath(rel)) continue;

    const fileStat = await stat(file);
    if (fileStat.size > 500_000) continue;
    const content = await readFile(file, 'utf8');

    const match = scoreAgainstSignals(rel, content, signals);
    if (match.score <= 0) continue;
    const exportName = inferExportName(content, rel);
    const newExportName = `Hts${pascalCase(manifest.integration_id)}${pascalCase(exportName)}`;
    const targetPath = uniqueTargetPath(
      `${manifest.repository_namespace}/components/${newExportName}${path.extname(rel)}`,
      reservedTargets
    );
    const graph = await collectLocalDependencyGraph(root, rel, fileSet);
    if (graph.blockers.length > 0) continue;
    const entries = await buildFrontendDuplicationEntries({
      root,
      manifest,
      entrySource: rel,
      entryTarget: targetPath,
      graph,
      match,
      exportName,
      reservedTargets,
      existingSources,
      sourceTargetMap
    });
    if (entries.length === 0) continue;
    entries.forEach((entry) => {
      reservedTargets.add(entry.target_path);
      existingSources.add(entry.source_path);
      sourceTargetMap.set(entry.source_path, entry.target_path);
    });
    acceptedRoots += 1;
    scored.push(...entries);
  }

  return scored
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence) || left.source_path.localeCompare(right.source_path));
}

function inferStoryblokComponentCandidates(manifest, { storyblokInspection, signals, max }) {
  const existingComponents = normalizeStoryblokComponents(storyblokInspection);
  if (existingComponents.length === 0) return [];

  const existingTargets = new Set(ensureArray(manifest.storyblok?.components_to_duplicate).map((entry) => entry.technical_name || entry.name));
  const createdNestables = ensureArray(manifest.storyblok?.components_to_create)
    .filter((component) => component.component_type === 'nestable' || component.is_nestable)
    .filter((component) => !(component.technical_name || component.name || '').endsWith('_item'));
  const candidates = [];

  for (const component of createdNestables) {
    const targetName = component.technical_name || component.name;
    if (!targetName || existingTargets.has(targetName)) continue;
    const signal = signals.find((entry) => entry.target === targetName) || signalFromComponent(component, manifest.storyblok_prefix);
    const source = findStoryblokSource(existingComponents, signal, manifest.storyblok_prefix);
    if (!source) continue;
    candidates.push({
      source_technical_name: source.name,
      technical_name: targetName,
      component_type: component.component_type || 'nestable',
      display_name: component.display_name,
      confidence: source.confidence,
      matched_signal: signal.key,
      reason: `Existing Storyblok component "${source.name}" matched inferred template block "${signal.key}".`
    });
  }

  return candidates
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence) || left.technical_name.localeCompare(right.technical_name))
    .slice(0, max);
}

function buildManifestSignals(manifest) {
  const technicalNames = ensureArray(manifest.storyblok?.components_to_create)
    .map((component) => component.technical_name || component.name)
    .filter(Boolean);
  const mappingLabels = ensureArray(manifest.mapping).map((entry) => entry.template_section);
  const signals = [];

  for (const technicalName of technicalNames) {
    const key = stripStoryblokPrefix(technicalName, manifest.storyblok_prefix);
    if (key === 'template_page' || key.endsWith('_item')) continue;
    signals.push(signal(key, technicalName));
  }
  for (const label of mappingLabels) {
    const key = snakeCase(label);
    if (!key || key.endsWith('_item')) continue;
    signals.push(signal(key, null));
  }

  const seen = new Set();
  return signals.filter((entry) => {
    const key = `${entry.key}:${entry.target || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signal(key, target) {
  const normalized = snakeCase(key);
  const variants = unique([
    normalized,
    normalized.replaceAll('_', '-'),
    normalized.replaceAll('_', ''),
    ...(SIGNAL_SYNONYMS.get(normalized) || [])
  ]);
  return { key: normalized, target, variants };
}

function scoreAgainstSignals(rel, content, signals) {
  const searchablePath = normalizeForSearch(rel);
  const searchableContent = normalizeForSearch(content.slice(0, 100_000));
  let best = { score: 0, signal: null, reason: '' };
  for (const entry of signals) {
    let score = 0;
    const matched = [];
    for (const variant of entry.variants) {
      const normalizedVariant = normalizeForSearch(variant);
      if (!normalizedVariant) continue;
      if (searchablePath.includes(normalizedVariant)) {
        score += path.basename(rel).toLowerCase().includes(variant.toLowerCase()) ? 4 : 2;
        matched.push(variant);
      }
      if (searchableContent.includes(normalizedVariant)) {
        score += 1;
        matched.push(variant);
      }
    }
    if (score > best.score) {
      best = {
        score,
        signal: entry,
        reason: `Matched ${unique(matched).join(', ')} in component path or content.`
      };
    }
  }
  return best.signal ? best : { score: 0, signal: signals[0] || signal('component', null), reason: '' };
}

function isFrontendComponentPath(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (!FRONTEND_COMPONENT_EXTENSIONS.has(ext)) return false;
  return COMPONENT_PATH_PATTERNS.some((pattern) => pattern.test(rel));
}

function inferExportName(content, rel) {
  const functionMatch = content.match(/\bexport\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/);
  if (functionMatch) return functionMatch[1];
  const classMatch = content.match(/\bexport\s+(?:default\s+)?class\s+([A-Z][A-Za-z0-9_]*)\b/);
  if (classMatch) return classMatch[1];
  const constMatch = content.match(/\bexport\s+const\s+([A-Z][A-Za-z0-9_]*)\b/);
  if (constMatch) return constMatch[1];
  return pascalCase(path.basename(rel, path.extname(rel)));
}

async function collectLocalDependencyGraph(root, entryRel, fileSet) {
  const files = [];
  const visited = new Set();
  const blockers = [];
  let totalBytes = 0;

  async function visit(sourceRel, depth) {
    if (visited.has(sourceRel)) return;
    if (depth > MAX_DEPENDENCY_DEPTH) {
      blockers.push(`dependency graph exceeded depth ${MAX_DEPENDENCY_DEPTH} at ${sourceRel}`);
      return;
    }
    if (!isSafeDependencySourcePath(sourceRel)) {
      blockers.push(`dependency path is outside safe source directories: ${sourceRel}`);
      return;
    }
    visited.add(sourceRel);
    files.push(sourceRel);
    const fullPath = path.join(root, sourceRel);
    const fileStat = await stat(fullPath);
    totalBytes += fileStat.size;
    if (files.length > MAX_DEPENDENCY_FILES) blockers.push(`dependency graph exceeds ${MAX_DEPENDENCY_FILES} files`);
    if (totalBytes > MAX_DEPENDENCY_BYTES) blockers.push(`dependency graph exceeds ${MAX_DEPENDENCY_BYTES} bytes`);
    if (blockers.length > 0) return;

    const content = await readFile(fullPath, 'utf8');
    for (const specifier of extractImportSpecifiers(content).filter(isLocalImportSpecifier)) {
      const resolved = resolveLocalImport(sourceRel, specifier, fileSet);
      if (!resolved) {
        blockers.push(`local import could not be resolved from ${sourceRel}: ${specifier}`);
        continue;
      }
      await visit(resolved, depth + 1);
    }
  }

  await visit(entryRel, 0);
  return {
    files,
    blockers: unique(blockers)
  };
}

async function buildFrontendDuplicationEntries({
  root,
  manifest,
  entrySource,
  entryTarget,
  graph,
  match,
  exportName,
  reservedTargets,
  existingSources,
  sourceTargetMap
}) {
  const targetBySource = new Map([[entrySource, entryTarget]]);
  for (const sourcePath of graph.files.filter((file) => file !== entrySource)) {
    if (sourceTargetMap.has(sourcePath)) {
      targetBySource.set(sourcePath, sourceTargetMap.get(sourcePath));
      continue;
    }
    const targetPath = uniqueTargetPath(
      `${manifest.repository_namespace}/components/dependencies/${sourcePath}`,
      reservedTargets
    );
    targetBySource.set(sourcePath, targetPath);
  }

  const entries = [];
  for (const sourcePath of graph.files) {
    if (existingSources.has(sourcePath) && sourcePath !== entrySource) continue;
    const content = await readFile(path.join(root, sourcePath), 'utf8');
    const targetPath = targetBySource.get(sourcePath);
    const importRewrites = buildImportRewrites(sourcePath, content, targetBySource, graph.files);
    const isEntry = sourcePath === entrySource;
    entries.push({
      source_path: sourcePath,
      target_path: targetPath,
      ...(isEntry ? {
        export_name: exportName,
        new_export_name: path.basename(targetPath, path.extname(targetPath)),
        confidence: confidenceForScore(match.score),
        matched_signal: match.signal.key,
        reason: graph.files.length > 1
          ? `${match.reason} Local dependency graph will be duplicated into the integration namespace.`
          : match.reason
      } : {
        dependency_of: entrySource,
        confidence: 'dependency',
        reason: `Local dependency of inferred component ${entrySource}.`
      }),
      import_rewrites: importRewrites,
      source_hash: sha256(content)
    });
  }
  return entries;
}

function buildImportRewrites(sourcePath, content, targetBySource, graphFiles) {
  const rewrites = {};
  for (const specifier of extractImportSpecifiers(content).filter(isLocalImportSpecifier)) {
    const resolved = graphFiles.find((file) => file === resolveLocalImport(sourcePath, specifier, new Set(graphFiles)));
    if (!resolved) continue;
    const sourceTarget = targetBySource.get(sourcePath);
    const dependencyTarget = targetBySource.get(resolved);
    if (!sourceTarget || !dependencyTarget) continue;
    rewrites[specifier] = relativeImportSpecifier(path.dirname(sourceTarget), dependencyTarget);
  }
  return rewrites;
}

function extractImportSpecifiers(content) {
  return [...content.matchAll(RUNTIME_IMPORT_PATTERN)].map((match) => stripImportQuery(match[1]));
}

function resolveLocalImport(sourceRel, specifier, fileSet) {
  const clean = stripImportQuery(specifier);
  const candidates = [];
  if (clean.startsWith('.')) {
    candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(sourceRel), clean)));
  } else if (clean.startsWith('@/') || clean.startsWith('~/')) {
    const withoutAlias = clean.slice(2);
    candidates.push(path.posix.normalize(path.posix.join('src', withoutAlias)));
    candidates.push(path.posix.normalize(withoutAlias));
  } else {
    return null;
  }

  for (const candidate of candidates.flatMap(expandImportCandidates)) {
    if (fileSet.has(candidate) && FRONTEND_COMPONENT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return candidate;
  }
  return null;
}

function expandImportCandidates(candidate) {
  const ext = path.extname(candidate);
  if (ext) return [candidate];
  return [
    ...[...FRONTEND_COMPONENT_EXTENSIONS].map((extension) => `${candidate}${extension}`),
    ...[...FRONTEND_COMPONENT_EXTENSIONS].map((extension) => `${candidate}/index${extension}`)
  ];
}

function isLocalImportSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/');
}

function isSafeDependencySourcePath(sourcePath) {
  if (!sourcePath || sourcePath.startsWith('/') || sourcePath.includes('..')) return false;
  return SAFE_DEPENDENCY_SOURCE_PATTERNS.some((pattern) => pattern.test(sourcePath));
}

function stripImportQuery(specifier) {
  return String(specifier || '').split(/[?#]/)[0];
}

function relativeImportSpecifier(fromDir, toFile) {
  let relative = path.posix.relative(fromDir, toFile);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function uniqueTargetPath(targetPath, reservedTargets) {
  if (!reservedTargets.has(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, -ext.length);
  let index = 2;
  while (reservedTargets.has(`${base}${index}${ext}`)) index += 1;
  return `${base}${index}${ext}`;
}

function normalizeStoryblokComponents(storyblokInspection) {
  const components = ensureArray(storyblokInspection?.components);
  return components
    .map((component) => ({
      name: component.name || component.technical_name,
      display_name: component.display_name || '',
      type: component.type || component.component_type || (component.is_root ? 'content_type' : 'nestable'),
      is_root: component.is_root || component.type === 'content_type'
    }))
    .filter((component) => component.name && !component.is_root);
}

function signalFromComponent(component, storyblokPrefix) {
  return signal(stripStoryblokPrefix(component.technical_name || component.name, storyblokPrefix), component.technical_name || component.name);
}

function findStoryblokSource(components, signalEntry, storyblokPrefix) {
  const variants = new Set(signalEntry.variants.map(normalizeForSearch));
  let best = null;
  for (const component of components) {
    if (component.name.startsWith(storyblokPrefix)) continue;
    const sourceKey = normalizeForSearch(component.name);
    const displayKey = normalizeForSearch(component.display_name);
    let score = 0;
    if (variants.has(sourceKey)) score += 4;
    for (const variant of variants) {
      if (sourceKey.includes(variant)) score += 2;
      if (displayKey.includes(variant)) score += 1;
    }
    if (score <= 0) continue;
    const candidate = {
      ...component,
      confidence: confidenceForScore(score)
    };
    if (!best || confidenceRank(candidate.confidence) > confidenceRank(best.confidence)) best = candidate;
  }
  return best;
}

function appendUniqueByTarget(entries, candidate, key) {
  const value = candidate[key];
  if (!value || entries.some((entry) => entry[key] === value)) return false;
  entries.push(candidate);
  return true;
}

function stripStoryblokPrefix(value, prefix) {
  return String(value || '').startsWith(prefix) ? String(value).slice(prefix.length) : String(value || '');
}

function confidenceForScore(score) {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function confidenceRank(value) {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 1;
  return 0;
}

function normalizeForSearch(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function snakeCase(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function pascalCase(value) {
  return String(value || '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}
