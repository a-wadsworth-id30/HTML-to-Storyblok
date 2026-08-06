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
      frontend_components: frontendComponents.length,
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

  for (const file of files) {
    const rel = relativeTo(root, file);
    if (rel.startsWith(`${manifest.repository_namespace}/`)) continue;
    if (existingSources.has(rel)) continue;
    if (!isFrontendComponentPath(rel)) continue;

    const fileStat = await stat(file);
    if (fileStat.size > 500_000) continue;
    const content = await readFile(file, 'utf8');
    if (hasRuntimeImportOutsideDuplicate(content)) continue;

    const match = scoreAgainstSignals(rel, content, signals);
    if (match.score <= 0) continue;
    const exportName = inferExportName(content, rel);
    const newExportName = `Hts${pascalCase(manifest.integration_id)}${pascalCase(exportName)}`;
    const targetPath = uniqueTargetPath(
      `${manifest.repository_namespace}/components/${newExportName}${path.extname(rel)}`,
      reservedTargets
    );
    reservedTargets.add(targetPath);
    scored.push({
      source_path: rel,
      target_path: targetPath,
      export_name: exportName,
      new_export_name: path.basename(targetPath, path.extname(targetPath)),
      confidence: confidenceForScore(match.score),
      matched_signal: match.signal.key,
      reason: match.reason,
      source_hash: sha256(content)
    });
  }

  return scored
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence) || left.source_path.localeCompare(right.source_path))
    .slice(0, max);
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

function hasRuntimeImportOutsideDuplicate(content) {
  for (const match of content.matchAll(RUNTIME_IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/')) return true;
  }
  return false;
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
