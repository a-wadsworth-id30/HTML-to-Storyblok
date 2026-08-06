import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ASSET_EXTENSIONS, isExternalRef, parseAttributes, stripRefQuery } from './analyzer.js';
import { inspectRepository, inspectTemplate } from './inspectors.js';
import { ensureArray, pathExists, relativeTo, toPosixPath, unique } from './utils.js';

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
  const styleConversion = await readTemplateCss(templateRoot, cssFiles, manifest.integration_id);
  const scriptConversion = await readTemplateScripts(templateRoot, sourcePage, sanitized.scripts, inventory.files_inspected, manifest.integration_id);
  const assetCopies = planAssetCopies(templateRoot, manifest.repository_namespace, [
    ...findHtmlAssetRefs(sanitized.bodyHtml).map((reference) => ({
      sourceFile: sourcePage,
      reference,
      outputBase: '.'
    })),
    ...styleConversion.asset_references
  ]);

  let convertedHtml = sanitized.bodyHtml;
  for (const asset of assetCopies) {
    for (const original of asset.original_refs.filter((entry) => entry.output_base === '.')) {
      convertedHtml = convertedHtml.split(original.reference).join(`./assets/${asset.asset_path}`);
    }
  }

  const namespacedHtml = namespaceHtml(convertedHtml, manifest.integration_id);
  const frameworkName = normalizeFramework(detectedFramework);
  return {
    framework: frameworkName,
    source_page: relativeTo(templateRoot, sourcePage),
    removed_scripts: sanitized.removedScripts,
    removed_inline_handlers: sanitized.removedInlineHandlers,
    excluded_external_scripts: sanitized.scripts.filter((script) => script.src && isExternalRef(script.src)).map((script) => script.src),
    isolated_scripts: scriptConversion.sources,
    asset_copies: assetCopies,
    files: buildTemplateFiles({
      manifest,
      framework: frameworkName,
      html: namespacedHtml,
      css: styleConversion.css,
      behaviour: scriptConversion.module
    })
  };
}

export function plannedTemplateFilePaths(manifest, framework = 'static') {
  const namespace = manifest.repository_namespace;
  const normalized = normalizeFramework(framework);
  const files = [
    `${namespace}/template-html.js`,
    `${namespace}/styles/template.css`,
    `${namespace}/behaviour/${manifest.integration_id}.js`
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
      await mkdir(path.dirname(destination), { recursive: true });
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

export function buildTemplateFiles({ manifest, framework, html, css, behaviour }) {
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
    },
    {
      path: `${namespace}/behaviour/${integrationId}.js`,
      content: behaviour || renderBehaviourModule(integrationId, [])
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

<script>
  import './behaviour/${integrationId}.js';
</script>

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
import './behaviour/${integrationId}.js';

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
import './behaviour/${integrationId}.js';

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
<script type="module" src="./behaviour/${integrationId}.js"></script>
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
  const assetReferences = [];
  for (const rel of cssFiles) {
    const source = path.join(templateRoot, rel);
    const content = await readFile(source, 'utf8');
    const rewritten = rewriteCssAssetRefs(content, source, templateRoot, assetReferences);
    chunks.push(`/* Source: ${rel} */\n${namespaceCss(rewritten, integrationId)}`);
  }
  return {
    css: chunks.join('\n\n'),
    asset_references: assetReferences
  };
}

function selectSourcePage(templateRoot, pages) {
  if (pages.length === 0) throw new Error('template does not contain an HTML page');
  const index = pages.find((page) => path.basename(page).toLowerCase() === 'index.html');
  return path.join(templateRoot, index || pages[0]);
}

function sanitizeHtml(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((match) => {
    const attributes = parseAttributes(match[1] || '');
    return {
      attributes,
      src: attributes.src || null,
      content: match[2] || ''
    };
  });
  const removedScripts = scripts.length;
  const removedInlineHandlers = [...html.matchAll(/\son[a-z]+\s*=\s*(['"]).*?\1/gi)].length;
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const withoutHandlers = withoutScripts.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  const bodyMatch = withoutHandlers.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return {
    bodyHtml: (bodyMatch ? bodyMatch[1] : withoutHandlers).trim(),
    removedScripts,
    removedInlineHandlers,
    scripts
  };
}

function namespaceHtml(html, integrationId) {
  const prefix = `hts-${integrationId}`;
  let output = html
    .replace(/\bid=(['"])([^'"]+)\1/gi, (_match, quote, value) => `id=${quote}${prefix}-${value}${quote}`)
    .replace(/\bclass=(['"])([^'"]+)\1/gi, (_match, quote, value) => {
      const classes = value.split(/\s+/).filter(Boolean).map((className) => (
        className.startsWith(`${prefix}-`) ? className : `${prefix}-${className}`
      ));
      return `class=${quote}${classes.join(' ')}${quote}`;
    });
  output = markFirst(output, /<h1\b([^>]*)>/i, '<h1$1 data-hts-field="headline">');
  output = markFirst(output, /<p\b([^>]*)>/i, '<p$1 data-hts-field="body">');
  return output;
}

function namespaceCss(css, integrationId) {
  const keyframeNames = unique([...css.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g)].map((match) => match[1]));
  let rewritten = css;
  for (const name of keyframeNames) {
    rewritten = rewritten.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), `hts-${integrationId}-${name}`);
  }
  return scopeCssRules(rewritten, integrationId).trimEnd();
}

function findHtmlAssetRefs(html) {
  return [...html.matchAll(/\b(?:src|href|poster)=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((ref) => ASSET_EXTENSIONS.test(stripRefQuery(ref)));
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

function planAssetCopies(templateRoot, repositoryNamespace, references) {
  const bySource = new Map();
  for (const entry of references) {
    const ref = entry.reference;
    if (!ref || isExternalRef(ref) || ref.startsWith('#') || path.isAbsolute(ref)) continue;
    const sourceAsset = path.resolve(path.dirname(entry.sourceFile), stripRefQuery(ref));
    const assetPath = toPosixPath(path.relative(templateRoot, sourceAsset));
    if (!assetPath || assetPath.startsWith('..')) continue;
    const targetPath = `${repositoryNamespace}/assets/${assetPath}`;
    if (!bySource.has(sourceAsset)) {
      bySource.set(sourceAsset, {
        source_path: sourceAsset,
        target_path: targetPath,
        asset_path: assetPath,
        original_refs: []
      });
    }
    bySource.get(sourceAsset).original_refs.push({
      reference: ref,
      output_base: entry.outputBase
    });
  }
  return [...bySource.values()];
}

function rewriteCssAssetRefs(css, sourceFile, templateRoot, assetReferences) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, ref) => {
    if (!ref || isExternalRef(ref) || ref.startsWith('#') || path.isAbsolute(ref)) return match;
    const sourceAsset = path.resolve(path.dirname(sourceFile), stripRefQuery(ref));
    const assetPath = toPosixPath(path.relative(templateRoot, sourceAsset));
    if (!assetPath || assetPath.startsWith('..')) return match;
    assetReferences.push({
      sourceFile,
      reference: ref,
      outputBase: 'styles'
    });
    const suffix = ref.includes('?') ? `?${ref.split('?').slice(1).join('?')}` : '';
    const rewrittenRef = `../assets/${assetPath}${suffix}`;
    return `url(${quote || ''}${rewrittenRef}${quote || ''})`;
  });
}

async function readTemplateScripts(templateRoot, sourcePage, scripts, files, integrationId) {
  const sources = [];
  for (const script of scripts) {
    if (script.src) {
      if (isExternalRef(script.src)) continue;
      const source = path.resolve(path.dirname(sourcePage), stripRefQuery(script.src));
      if (await pathExists(source) && await isFile(source)) {
        sources.push({
          source_file: relativeTo(templateRoot, source),
          content: await readFile(source, 'utf8')
        });
      }
      continue;
    }
    if (script.content.trim()) {
      sources.push({
        source_file: `${relativeTo(templateRoot, sourcePage)}#inline-script-${sources.length + 1}`,
        content: script.content
      });
    }
  }

  for (const rel of files.filter((file) => /\.(js|mjs|cjs)$/i.test(file))) {
    if (sources.some((source) => source.source_file === rel)) continue;
    sources.push({
      source_file: rel,
      content: await readFile(path.join(templateRoot, rel), 'utf8')
    });
  }

  return {
    sources: sources.map((source) => source.source_file),
    module: renderBehaviourModule(integrationId, sources)
  };
}

function renderBehaviourModule(integrationId, sources) {
  const functionName = `initHts${pascalCase(integrationId)}Behaviour`;
  const rootClass = `hts-${integrationId}-root`;
  const blocks = sources.map((source, index) => {
    const isolated = isolateScriptSource(source.content, integrationId);
    return `  runIsolatedScript(${JSON.stringify(source.source_file)}, ${index + 1}, (window, document, root) => {\n${indent(isolated, 4)}\n  });`;
  }).join('\n');

  return `const ROOT_SELECTOR = '.${rootClass}';

export function ${functionName}(root = globalThis.document) {
  if (typeof window === 'undefined' || !root) return () => {};
  const integrationRoot = resolveIntegrationRoot(root);
  if (!integrationRoot) return () => {};
  const cleanup = [];
  const scopedDocument = createScopedDocument(integrationRoot, cleanup);

${blocks || '  // No local template scripts were found.'}

  integrationRoot.dataset.htsBehaviourReady = 'true';
  return () => {
    while (cleanup.length > 0) {
      const remove = cleanup.pop();
      remove();
    }
    delete integrationRoot.dataset.htsBehaviourReady;
  };
}

function resolveIntegrationRoot(root) {
  if (root?.matches?.(ROOT_SELECTOR)) return root;
  return root?.querySelector?.(ROOT_SELECTOR) || null;
}

function createScopedDocument(root, cleanup) {
  const ownerDocument = root.ownerDocument || globalThis.document;
  return {
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => root.querySelector('#' + cssEscape(id)),
    createElement: (...args) => ownerDocument.createElement(...args),
    addEventListener: (type, listener, options) => {
      ownerDocument.addEventListener(type, listener, options);
      cleanup.push(() => ownerDocument.removeEventListener(type, listener, options));
    },
    removeEventListener: (...args) => ownerDocument.removeEventListener(...args),
    documentElement: ownerDocument.documentElement,
    body: root
  };
}

function runIsolatedScript(sourceFile, index, callback) {
  const root = resolveIntegrationRoot(globalThis.document);
  if (!root) return;
  try {
    callback(globalThis.window, createScopedDocument(root, []), root);
  } catch (error) {
    console.warn(\`html-to-storyblok isolated behaviour failed in \${sourceFile} (#\${index}):\`, error);
  }
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const boot = () => ${functionName}(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
`;
}

function isolateScriptSource(source, integrationId) {
  return String(source)
    .replace(/\bdocument\.getElementById\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, (_match, _quote, id) => `document.getElementById('hts-${integrationId}-${id}')`)
    .replace(/\bwindow\.on([a-z]+)\s*=/g, 'window.addEventListener("$1",');
}

function scopeCssRules(css, integrationId) {
  let output = '';
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) {
      output += css.slice(index);
      break;
    }
    const prelude = css.slice(index, open).trim();
    const close = findMatchingBrace(css, open);
    if (close === -1) {
      output += css.slice(index);
      break;
    }
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@container') || prelude.startsWith('@layer')) {
      output += `${prelude} {\n${scopeCssRules(body, integrationId)}\n}\n`;
    } else if (prelude.startsWith('@')) {
      output += `${prelude} {${body}}\n`;
    } else {
      output += `${scopeSelectorList(prelude, integrationId)} {${body}}\n`;
    }
    index = close + 1;
  }
  return output;
}

function findMatchingBrace(value, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function scopeSelectorList(selectorList, integrationId) {
  const root = `.hts-${integrationId}-root`;
  return selectorList
    .split(',')
    .map((selector) => scopeSelector(selector.trim(), integrationId, root))
    .join(', ');
}

function scopeSelector(selector, integrationId, root) {
  if (!selector) return selector;
  let rewritten = selector
    .replace(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g, (_match, className) => {
      if (className.startsWith(`hts-${integrationId}-`)) return `.${className}`;
      return `.hts-${integrationId}-${className}`;
    })
    .replace(/#(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g, (_match, id) => {
      if (id.startsWith(`hts-${integrationId}-`)) return `#${id}`;
      return `#hts-${integrationId}-${id}`;
    });
  rewritten = rewritten.replace(/^html\b|^body\b|^:root\b/, root);
  if (rewritten.startsWith(root)) return rewritten;
  return `${root} ${rewritten}`;
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
