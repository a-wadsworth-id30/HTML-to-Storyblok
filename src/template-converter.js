import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectRepository, inspectTemplate } from './inspectors.js';
import { ensureArray, pathExists, relativeTo, toPosixPath } from './utils.js';

const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|eot)$/i;

export async function convertTemplate({
  templatePath,
  repoPath,
  manifest,
  framework = 'auto'
}) {
  if (!templatePath) return null;
  const templateRoot = path.resolve(templatePath);
  const repoRoot = path.resolve(repoPath || process.cwd());
  const inventory = await inspectTemplate(templateRoot);
  const detectedFramework = framework === 'auto'
    ? (await inspectRepository(repoRoot)).framework.name
    : framework;
  const sourcePage = selectSourcePage(templateRoot, inventory.pages);
  const sourceHtml = await readFile(sourcePage, 'utf8');
  const sanitized = sanitizeHtml(sourceHtml);
  const cssFiles = inventory.files_inspected.filter((file) => /\.(css|scss|sass|less)$/i.test(file));
  const css = await readTemplateCss(templateRoot, cssFiles, manifest.integration_id);
  const assetRefs = findAssetRefs(sanitized.bodyHtml);
  const assetCopies = [];
  let convertedHtml = sanitized.bodyHtml;

  for (const ref of assetRefs) {
    if (isExternalRef(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
    const sourceAsset = path.resolve(path.dirname(sourcePage), ref.split(/[?#]/)[0]);
    if (!(await pathExists(sourceAsset))) continue;
    if (!(await isFile(sourceAsset))) continue;
    const targetRel = `${manifest.repository_namespace}/assets/${path.basename(sourceAsset)}`;
    const publicRef = `./assets/${path.basename(sourceAsset)}`;
    convertedHtml = convertedHtml.split(ref).join(publicRef);
    assetCopies.push({
      source_path: sourceAsset,
      target_path: targetRel,
      original_ref: ref,
      converted_ref: publicRef
    });
  }

  const namespacedHtml = namespaceHtml(convertedHtml, manifest.integration_id);
  const frameworkName = normalizeFramework(detectedFramework);
  return {
    framework: frameworkName,
    source_page: relativeTo(templateRoot, sourcePage),
    removed_scripts: sanitized.removedScripts,
    removed_inline_handlers: sanitized.removedInlineHandlers,
    asset_copies: assetCopies,
    files: buildTemplateFiles({
      manifest,
      framework: frameworkName,
      html: namespacedHtml,
      css
    })
  };
}

export function plannedTemplateFilePaths(manifest, framework = 'static') {
  const namespace = manifest.repository_namespace;
  const normalized = normalizeFramework(framework);
  const files = [
    `${namespace}/template-html.js`,
    `${namespace}/styles/template.css`
  ];
  if (normalized === 'astro') files.push(`${namespace}/TemplatePage.astro`);
  else if (normalized === 'react' || normalized === 'next') files.push(`${namespace}/TemplatePage.jsx`);
  else if (normalized === 'vue' || normalized === 'nuxt') files.push(`${namespace}/TemplatePage.vue`);
  else files.push(`${namespace}/template.html`);
  return files;
}

export async function copyConvertedAssets(assetCopies, repoRoot, { dryRun = false } = {}) {
  const copied = [];
  for (const asset of ensureArray(assetCopies)) {
    const destination = path.join(repoRoot, asset.target_path);
    if (await pathExists(destination)) {
      throw new Error(`refusing to overwrite existing asset: ${asset.target_path}`);
    }
    if (!dryRun) {
      await copyFile(asset.source_path, destination);
    }
    const fileStat = await stat(asset.source_path);
    copied.push({
      source_path: asset.source_path,
      target_path: asset.target_path,
      bytes: fileStat.size
    });
  }
  return copied;
}

function buildTemplateFiles({ manifest, framework, html, css }) {
  const namespace = manifest.repository_namespace;
  const integrationId = manifest.integration_id;
  const renderer = renderTemplateModule(integrationId, html);
  const files = [
    {
      path: `${namespace}/template-html.js`,
      content: renderer
    },
    {
      path: `${namespace}/styles/template.css`,
      content: css || defaultTemplateCss(integrationId)
    }
  ];

  if (framework === 'astro') {
    const astroHtml = html
      .replace(/data-hts-field="headline">([^<]*)</, 'data-hts-field="headline">{blok.headline || "$1"}<')
      .replace(/data-hts-field="body">([^<]*)</, 'data-hts-field="body">{blok.body || "$1"}<');
    files.push({
      path: `${namespace}/TemplatePage.astro`,
      content: `---
import './styles/template.css';

const { blok = {} } = Astro.props;
---

<main class="hts-${integrationId}-root" data-integration="${integrationId}">
${astroHtml}
</main>
`
    });
  } else if (framework === 'react' || framework === 'next') {
    const jsxHtml = toJsx(html)
      .replace(/data-hts-field="headline">([^<]*)</, 'data-hts-field="headline">{blok.headline || "$1"}<')
      .replace(/data-hts-field="body">([^<]*)</, 'data-hts-field="body">{blok.body || "$1"}<');
    files.push({
      path: `${namespace}/TemplatePage.jsx`,
      content: `import './styles/template.css';

export function HtsTemplatePage({ blok = {} }) {
  return (
    <main className="hts-${integrationId}-root" data-integration="${integrationId}">
${indent(jsxHtml, 6)}
    </main>
  );
}
`
    });
  } else if (framework === 'vue' || framework === 'nuxt') {
    const vueHtml = html
      .replace(/data-hts-field="headline">([^<]*)</, 'data-hts-field="headline">{{ blok.headline || "$1" }}<')
      .replace(/data-hts-field="body">([^<]*)</, 'data-hts-field="body">{{ blok.body || "$1" }}<');
    files.push({
      path: `${namespace}/TemplatePage.vue`,
      content: `<script setup>
import './styles/template.css';

const props = defineProps({
  blok: {
    type: Object,
    default: () => ({})
  }
});
</script>

<template>
  <main class="hts-${integrationId}-root" data-integration="${integrationId}">
${indent(vueHtml.replaceAll('blok.', 'props.blok.'), 4)}
  </main>
</template>
`
    });
  } else {
    files.push({
      path: `${namespace}/template.html`,
      content: `<main class="hts-${integrationId}-root" data-integration="${integrationId}">
${html}
</main>
`
    });
  }
  return files;
}

function renderTemplateModule(integrationId, html) {
  return `const templateHtml = ${JSON.stringify(html)};

export function renderTemplateHtml(blok = {}) {
  const replacements = {
    headline: escapeHtml(blok.headline || ''),
    body: escapeHtml(blok.body || '')
  };
  return templateHtml
    .replaceAll('data-hts-field="headline"></', \`data-hts-field="headline">\${replacements.headline}</\`)
    .replaceAll('data-hts-field="body"></', \`data-hts-field="body">\${replacements.body}</\`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
`;
}

function defaultTemplateCss(integrationId) {
  return `.hts-${integrationId}-root {
  display: block;
}
`;
}

async function readTemplateCss(templateRoot, cssFiles, integrationId) {
  const chunks = [];
  for (const rel of cssFiles) {
    const source = path.join(templateRoot, rel);
    const content = await readFile(source, 'utf8');
    chunks.push(`/* Source: ${rel} */\n${namespaceCss(content, integrationId)}`);
  }
  return chunks.join('\n\n');
}

function selectSourcePage(templateRoot, pages) {
  if (pages.length === 0) throw new Error('template does not contain an HTML page');
  const index = pages.find((page) => path.basename(page).toLowerCase() === 'index.html');
  return path.join(templateRoot, index || pages[0]);
}

function sanitizeHtml(html) {
  const removedScripts = [...html.matchAll(/<script\b[\s\S]*?<\/script>/gi)].length;
  const removedInlineHandlers = [...html.matchAll(/\son[a-z]+\s*=\s*(['"]).*?\1/gi)].length;
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const withoutHandlers = withoutScripts.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  const bodyMatch = withoutHandlers.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return {
    bodyHtml: (bodyMatch ? bodyMatch[1] : withoutHandlers).trim(),
    removedScripts,
    removedInlineHandlers
  };
}

function namespaceHtml(html, integrationId) {
  const prefix = `hts-${integrationId}`;
  let output = html
    .replace(/\bid=(['"])([^'"]+)\1/gi, (_match, quote, value) => `id=${quote}${prefix}-${value}${quote}`)
    .replace(/\bclass=(['"])([^'"]+)\1/gi, (_match, quote, value) => {
      const classes = value.split(/\s+/).filter(Boolean).map((className) => `${prefix}-${className}`);
      return `class=${quote}${classes.join(' ')}${quote}`;
    });
  output = markFirst(output, /<h1\b([^>]*)>/i, '<h1$1 data-hts-field="headline">');
  output = markFirst(output, /<p\b([^>]*)>/i, '<p$1 data-hts-field="body">');
  return output;
}

function namespaceCss(css, integrationId) {
  const prefix = `.hts-${integrationId}-root`;
  return css
    .replace(/@keyframes\s+([a-zA-Z0-9_-]+)/g, `@keyframes hts-${integrationId}-$1`)
    .split('}')
    .map((block) => {
      if (!block.trim() || block.includes('@keyframes')) return block;
      const [selector, ...rest] = block.split('{');
      if (rest.length === 0) return block;
      if (selector.trim().startsWith('@')) return `${selector}{${rest.join('{')}`;
      const scoped = selector
        .split(',')
        .map((part) => `${prefix} ${part.trim()}`)
        .join(', ');
      return `${scoped}{${rest.join('{')}`;
    })
    .join('}');
}

function findAssetRefs(html) {
  return [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((ref) => ASSET_EXTENSIONS.test(ref.split(/[?#]/)[0]));
}

function isExternalRef(ref) {
  return /^(https?:)?\/\//i.test(ref) || /^(mailto|tel):/i.test(ref);
}

function normalizeFramework(value) {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('astro')) return 'astro';
  if (lower.includes('next')) return 'next';
  if (lower.includes('react')) return 'react';
  if (lower.includes('nuxt')) return 'nuxt';
  if (lower.includes('vue')) return 'vue';
  return 'static';
}

function markFirst(value, pattern, replacement) {
  return value.replace(pattern, replacement);
}

function toJsx(html) {
  return html
    .replace(/\bclass=/g, 'className=')
    .replace(/\bfor=/g, 'htmlFor=')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img([^>]*?)(?<!\/)>/gi, '<img$1 />')
    .replace(/<input([^>]*?)(?<!\/)>/gi, '<input$1 />')
    .replace(/<br([^>]*?)(?<!\/)>/gi, '<br$1 />')
    .replace(/<hr([^>]*?)(?<!\/)>/gi, '<hr$1 />');
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => line ? `${prefix}${line}` : line).join('\n');
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
