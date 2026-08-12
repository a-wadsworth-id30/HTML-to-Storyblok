import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ASSET_EXTENSIONS, isExternalRef, parseAttributes, stripRefQuery } from './analyzer.js';
import { namespaceCss } from './css-isolation.js';
import { inspectRepository, inspectTemplate } from './inspectors.js';
import { ensureArray, pathExists, relativeTo, toPosixPath } from './utils.js';

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
  const routePages = pagesForConversion(inventory, manifest);
  const cssFiles = inventory.files_inspected.filter((file) => /\.(css|scss|sass|less)$/i.test(file));
  const styleConversion = await readTemplateCss(templateRoot, cssFiles, manifest.integration_id);
  const sanitizedPages = [];
  const htmlAssetReferences = [];
  for (const page of routePages) {
    const sourcePage = path.join(templateRoot, pageSource(page));
    const sourceHtml = await readFile(sourcePage, 'utf8');
    const sanitized = sanitizeHtml(sourceHtml);
    sanitizedPages.push({
      page,
      route: routeForTemplatePage(page),
      source_page: pageSource(page),
      source_path: sourcePage,
      sanitized
    });
    htmlAssetReferences.push(...findHtmlAssetRefs(sanitized.bodyHtml).map((reference) => ({
      sourceFile: sourcePage,
      reference,
      outputBase: '.'
    })));
  }
  const scriptConversion = await readTemplateScripts(templateRoot, sanitizedPages, inventory.files_inspected, manifest.integration_id);
  const assetCopies = planAssetCopies(templateRoot, manifest.repository_namespace, [
    ...htmlAssetReferences,
    ...styleConversion.asset_references
  ]);

  const routeConversions = sanitizedPages.map((entry) => {
    const routeAssetPrefix = `${routeImportPrefix(entry.route.slug)}/assets`;
    const convertedHtml = replaceHtmlAssetRefs(entry.sanitized.bodyHtml, assetCopies, entry.source_path, routeAssetPrefix);
    return {
      ...entry.route,
      source_page: entry.source_page,
      root_html: entry.route.primary
        ? namespaceHtml(replaceHtmlAssetRefs(entry.sanitized.bodyHtml, assetCopies, entry.source_path, './assets'), manifest.integration_id)
        : null,
      html: namespaceHtml(convertedHtml, manifest.integration_id)
    };
  });

  const primaryRoute = routeConversions[0];
  const frameworkName = normalizeFramework(detectedFramework);
  return {
    framework: frameworkName,
    source_page: primaryRoute?.source_page || null,
    routes: routeConversions.map(({ html, root_html: _rootHtml, ...route }) => route),
    removed_scripts: sanitizedPages.reduce((total, entry) => total + entry.sanitized.removedScripts, 0),
    removed_inline_handlers: sanitizedPages.reduce((total, entry) => total + entry.sanitized.removedInlineHandlers, 0),
    excluded_external_scripts: uniqueRefs(sanitizedPages.flatMap((entry) => (
      entry.sanitized.scripts.filter((script) => script.src && isExternalRef(script.src)).map((script) => script.src)
    ))),
    isolated_scripts: scriptConversion.sources,
    asset_copies: assetCopies,
    files: buildTemplateFiles({
      manifest,
      framework: frameworkName,
      html: primaryRoute?.root_html || primaryRoute?.html || '',
      css: styleConversion.css,
      behaviour: scriptConversion.module,
      routes: shouldGenerateRoutePreviewFiles(manifest) ? routeConversions : []
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
  const routes = routeInfosForManifest(manifest);
  if (routes.length > 0) {
    files.push(`${namespace}/routes/manifest.json`);
    for (const route of routes) {
      files.push(`${namespace}/routes/${route.slug}/template-html.js`);
      if (normalized === 'astro') files.push(`${namespace}/routes/${route.slug}/TemplatePage.astro`);
      else if (normalized === 'react' || normalized === 'next') files.push(`${namespace}/routes/${route.slug}/TemplatePage.jsx`);
      else if (normalized === 'vue' || normalized === 'nuxt') files.push(`${namespace}/routes/${route.slug}/TemplatePage.vue`);
      else files.push(`${namespace}/routes/${route.slug}/template.html`);
    }
  }
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

export function buildTemplateFiles({ manifest, framework, html, css, behaviour, routes = [] }) {
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
    files.push({
      path: `${namespace}/TemplatePage.astro`,
      content: `---
import './styles/template.css';
import { renderTemplateHtml } from './template-html.js';

const { blok = {} } = Astro.props;
const htsHtml = renderTemplateHtml(blok);
---

<script>
  import './behaviour/${integrationId}.js';
</script>

<main class="hts-${integrationId}-root" data-integration="${integrationId}" set:html={htsHtml}></main>
`
    });
  } else if (framework === 'react' || framework === 'next') {
    files.push({
      path: `${namespace}/TemplatePage.jsx`,
      content: `import './styles/template.css';
import './behaviour/${integrationId}.js';
import { renderTemplateHtml } from './template-html.js';

export function HtsTemplatePage({ blok = {} }) {
  return (
    <main
      className="hts-${integrationId}-root"
      data-integration="${integrationId}"
      dangerouslySetInnerHTML={{ __html: renderTemplateHtml(blok) }}
    />
  );
}
`
    });
  } else if (framework === 'vue' || framework === 'nuxt') {
    files.push({
      path: `${namespace}/TemplatePage.vue`,
      content: `<script setup>
import { computed } from 'vue';
import './styles/template.css';
import './behaviour/${integrationId}.js';
import { renderTemplateHtml } from './template-html.js';

const props = defineProps({
  blok: {
    type: Object,
    default: () => ({})
  }
});

const htsHtml = computed(() => renderTemplateHtml(props.blok));
</script>

<template>
  <main class="hts-${integrationId}-root" data-integration="${integrationId}" v-html="htsHtml"></main>
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
  if (routes.length > 0) {
    files.push(...buildRoutePreviewFiles({ manifest, framework, routes }));
  }
  return files;
}

function buildRoutePreviewFiles({ manifest, framework, routes }) {
  const namespace = manifest.repository_namespace;
  const integrationId = manifest.integration_id;
  const normalized = normalizeFramework(framework);
  const files = [{
    path: `${namespace}/routes/manifest.json`,
    json: true,
    content: {
      integration_id: integrationId,
      framework: normalized,
      note: 'Route previews are isolated. They are not registered with the host application router.',
      routes: routes.map((route) => ({
        slug: route.slug,
        path: route.path,
        source_page: route.source_page,
        files: {
          template_html: `${namespace}/routes/${route.slug}/template-html.js`,
          preview: routePreviewPath(namespace, route.slug, normalized)
        }
      }))
    }
  }];

  for (const route of routes) {
    const prefix = routeImportPrefix(route.slug);
    files.push({
      path: `${namespace}/routes/${route.slug}/template-html.js`,
      content: renderTemplateModule(integrationId, route.html)
    });
    if (normalized === 'astro') {
      files.push({
        path: `${namespace}/routes/${route.slug}/TemplatePage.astro`,
        content: `---
import '${prefix}/styles/template.css';
import { renderTemplateHtml } from './template-html.js';

const { blok = {} } = Astro.props;
const htsHtml = renderTemplateHtml(blok);
---

<script>
  import '${prefix}/behaviour/${integrationId}.js';
</script>

<main class="hts-${integrationId}-root" data-integration="${integrationId}" data-route="${route.slug}" set:html={htsHtml}></main>
`
      });
    } else if (normalized === 'react' || normalized === 'next') {
      files.push({
        path: `${namespace}/routes/${route.slug}/TemplatePage.jsx`,
        content: `import '${prefix}/styles/template.css';
import '${prefix}/behaviour/${integrationId}.js';
import { renderTemplateHtml } from './template-html.js';

export function HtsTemplatePage${pascalCase(route.slug)}({ blok = {} }) {
  return (
    <main
      className="hts-${integrationId}-root"
      data-integration="${integrationId}"
      data-route="${route.slug}"
      dangerouslySetInnerHTML={{ __html: renderTemplateHtml(blok) }}
    />
  );
}
`
      });
    } else if (normalized === 'vue' || normalized === 'nuxt') {
      files.push({
        path: `${namespace}/routes/${route.slug}/TemplatePage.vue`,
        content: `<script setup>
import { computed } from 'vue';
import '${prefix}/styles/template.css';
import '${prefix}/behaviour/${integrationId}.js';
import { renderTemplateHtml } from './template-html.js';

const props = defineProps({
  blok: {
    type: Object,
    default: () => ({})
  }
});

const htsHtml = computed(() => renderTemplateHtml(props.blok));
</script>

<template>
  <main class="hts-${integrationId}-root" data-integration="${integrationId}" data-route="${route.slug}" v-html="htsHtml"></main>
</template>
`
      });
    } else {
      files.push({
        path: `${namespace}/routes/${route.slug}/template.html`,
        content: `<main class="hts-${integrationId}-root" data-integration="${integrationId}" data-route="${route.slug}">
${route.html}
</main>
<script type="module" src="${prefix}/behaviour/${integrationId}.js"></script>
`
      });
    }
  }
  return files;
}

function renderTemplateModule(integrationId, html) {
  return `const templateHtml = ${JSON.stringify(html)};

export function renderTemplateHtml(blok = {}) {
  const fields = flattenBlokFields(blok);
  const hydrated = hydrateTextFields(
    hydrateFormFields(
      hydrateLinkFields(
        hydrateAssetFields(templateHtml, fields),
        fields
      ),
      fields
    ),
    fields
  );
  return injectStoryblokEditableMarkers(hydrated, blok);
}

function injectStoryblokEditableMarkers(html, blok) {
  const rootMarker = storyblokEditableComment(blok);
  const blockMarkers = Array.isArray(blok?.body)
    ? blok.body.map(storyblokEditableComment).filter(Boolean)
    : [];
  const markedHtml = blockMarkers.length > 0
    ? injectSequentialEditableMarkers(html, blockMarkers)
    : html;
  return rootMarker ? rootMarker + markedHtml : markedHtml;
}

function injectSequentialEditableMarkers(html, markers) {
  let index = 0;
  const output = html.replace(/<(header|nav|main|section|article|aside|footer)\\b/gi, (match) => {
    if (index >= markers.length) return match;
    const marker = markers[index];
    index += 1;
    return marker + match;
  });
  return index === 0 ? markers.join('') + html : output;
}

function storyblokEditableComment(value) {
  const comment = typeof value?._editable === 'string' ? value._editable.trim() : '';
  if (!/^<!--#storyblok#[\\s\\S]*-->$/.test(comment)) return '';
  if (/<\\/?script\\b/i.test(comment)) return '';
  return comment;
}

function hydrateTextFields(html, fields) {
  return html.replace(/<([a-zA-Z][\\w:-]*)\\b([^<>]*\\sdata-hts-field=(["'])([^"']+)\\3[^<>]*?)>([\\s\\S]*?)<\\/\\1>/g, (match, tagName, attributes, _quote, fieldName, fallback) => {
    const tag = tagName.toLowerCase();
    if (['script', 'style', 'svg', 'picture', 'select'].includes(tag)) return match;
    const value = fields[fieldName];
    if (!hasRenderableValue(value)) return match;
    if (tag === 'a' && isLinkValue(value)) return match;
    if (tag === 'textarea') {
      return '<' + tagName + attributes + '>' + escapeHtml(textValue(value, fallback)) + '</' + tagName + '>';
    }
    if (['input', 'img', 'source', 'video', 'audio'].includes(tag)) return match;
    return '<' + tagName + attributes + '>' + escapeHtml(textValue(value, fallback)) + '</' + tagName + '>';
  });
}

function hydrateAssetFields(html, fields) {
  return html.replace(/<img\\b([^<>]*\\sdata-hts-field=(["'])([^"']+)\\2[^<>]*?)>/gi, (match, _attributes, _quote, fieldName) => {
    const value = fields[fieldName];
    if (!hasRenderableValue(value)) return match;
    const src = assetUrl(value);
    if (!src) return match;
    let output = upsertAttribute(match, 'src', src);
    const alt = assetAlt(value);
    if (alt) output = upsertAttribute(output, 'alt', alt);
    return output;
  });
}

function hydrateLinkFields(html, fields) {
  return html.replace(/<a\\b([^<>]*\\sdata-hts-field=(["'])([^"']+)\\2[^<>]*?)>/gi, (match, _attributes, _quote, fieldName) => {
    const value = fields[fieldName];
    if (!hasRenderableValue(value)) return match;
    const href = linkUrl(value);
    return href ? upsertAttribute(match, 'href', href) : match;
  });
}

function hydrateFormFields(html, fields) {
  let output = html.replace(/<input\\b([^<>]*\\sdata-hts-field=(["'])([^"']+)\\2[^<>]*?)>/gi, (match, attributes, _quote, fieldName) => {
    const value = fields[fieldName];
    if (!hasRenderableValue(value)) return match;
    const type = attributeValue(attributes, 'type').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      return upsertBooleanAttribute(match, 'checked', Boolean(value));
    }
    return upsertAttribute(match, 'value', textValue(value, attributeValue(attributes, 'value')));
  });
  output = output.replace(/<select\\b([^<>]*\\sdata-hts-field=(["'])([^"']+)\\2[^<>]*?)>([\\s\\S]*?)<\\/select>/gi, (match, attributes, _quote, fieldName, optionsHtml) => {
    const value = fields[fieldName];
    if (!hasRenderableValue(value)) return match;
    const selected = textValue(value, '');
    if (!selected) return match;
    const hydratedOptions = optionsHtml.replace(/<option\\b([^<>]*?)>([\\s\\S]*?)<\\/option>/gi, (optionMatch, optionAttributes, label) => {
      const optionValue = attributeValue(optionAttributes, 'value') || stripHtml(label);
      const cleanSelected = selected.trim();
      const isSelected = optionValue.trim() === cleanSelected || stripHtml(label).trim() === cleanSelected;
      return optionMatch.replace(/<option\\b([^<>]*?)>/i, (openingTag) => (
        isSelected ? upsertBooleanAttribute(openingTag, 'selected', true) : removeAttribute(openingTag, 'selected')
      ));
    });
    return '<select' + attributes + '>' + hydratedOptions + '</select>';
  });
  return output;
}

function flattenBlokFields(value, fields = {}, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return fields;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) flattenBlokFields(item, fields, seen);
    return fields;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'component' || key.startsWith('_')) continue;
    if (fields[key] === undefined && hasDirectFieldValue(child)) {
      fields[key] = child;
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') flattenBlokFields(child, fields, seen);
  }
  return fields;
}

function hasDirectFieldValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return false;
  if (typeof value === 'object') {
    return Boolean(value.filename || value.fieldtype === 'asset' || value.linktype || value.type === 'doc');
  }
  return false;
}

function hasRenderableValue(value) {
  return hasDirectFieldValue(value);
}

function isLinkValue(value) {
  return Boolean(value && typeof value === 'object' && value.linktype);
}

function textValue(value, fallback = '') {
  if (value === null || value === undefined || value === '') return stripHtml(fallback);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => textValue(item, '')).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (value.type === 'doc') return richTextToPlainText(value);
    if (value.fieldtype === 'asset' || value.filename) return value.alt || value.title || value.filename || stripHtml(fallback);
    if (value.linktype) return linkUrl(value) || stripHtml(fallback);
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return value.content.map((item) => textValue(item, '')).filter(Boolean).join(' ');
  }
  return stripHtml(fallback);
}

function richTextToPlainText(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.content)) {
    return value.content.map((item) => richTextToPlainText(item)).filter(Boolean).join(' ');
  }
  return '';
}

function assetUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.filename || value.url || '';
  return '';
}

function assetAlt(value) {
  return value && typeof value === 'object' ? value.alt || value.title || '' : '';
}

function linkUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  const raw = value.url || value.cached_url || value.story?.cached_url || '';
  if (!raw) return '';
  if (/^(https?:|mailto:|tel:|#|\\/)/i.test(raw)) return raw;
  return '/' + raw.replace(/^\\/+/, '');
}

function attributeValue(attributes, name) {
  const pattern = new RegExp("\\\\s" + escapeRegExp(name) + "\\\\s*=\\\\s*([\\"'])([\\\\s\\\\S]*?)\\\\1", "i");
  const match = String(attributes || '').match(pattern);
  return match ? decodeHtmlAttribute(match[2]) : '';
}

function upsertAttribute(tag, name, value) {
  const serialized = ' ' + name + '="' + escapeHtmlAttribute(value) + '"';
  const pattern = new RegExp("\\\\s" + escapeRegExp(name) + "\\\\s*=\\\\s*([\\"'])[\\\\s\\\\S]*?\\\\1", "i");
  if (pattern.test(tag)) return tag.replace(pattern, serialized);
  return tag.replace(/\\s*\\/?>$/, (end) => serialized + end);
}

function upsertBooleanAttribute(tag, name, enabled) {
  if (!enabled) return removeAttribute(tag, name);
  const pattern = new RegExp("\\\\s" + escapeRegExp(name) + "(?:\\\\s*=\\\\s*([\\"'])[\\\\s\\\\S]*?\\\\1)?", "i");
  if (pattern.test(tag)) return tag;
  return tag.replace(/\\s*\\/?>$/, (end) => ' ' + name + end);
}

function removeAttribute(tag, name) {
  const pattern = new RegExp("\\\\s" + escapeRegExp(name) + "(?:\\\\s*=\\\\s*([\\"'])[\\\\s\\\\S]*?\\\\1)?", "ig");
  return tag.replace(pattern, '');
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\\s+/g, ' ').trim();
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#x22;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[\\\\^$.*+?()[\\]{}|]/g, '\\\\$&');
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

function pagesForConversion(inventory, manifest) {
  const pages = shouldGenerateRoutePreviewFiles(manifest)
    ? manifest.template.pages
    : [selectPrimaryPage(inventory.pages)];
  return orderedTemplatePages(pages.filter(Boolean));
}

function shouldGenerateRoutePreviewFiles(manifest) {
  return ensureArray(manifest.template?.pages).length > 0;
}

function routeInfosForManifest(manifest) {
  if (!shouldGenerateRoutePreviewFiles(manifest)) return [];
  return orderedTemplatePages(manifest.template.pages).map(routeForTemplatePage);
}

function selectPrimaryPage(pages = []) {
  if (pages.length === 0) throw new Error('template does not contain an HTML page');
  return pages.find((page) => path.basename(pageSource(page)).toLowerCase() === 'index.html') || pages[0];
}

function orderedTemplatePages(pages = []) {
  if (pages.length === 0) return [];
  const primary = selectPrimaryPage(pages);
  return [
    primary,
    ...pages.filter((page) => page !== primary)
  ];
}

function routeForTemplatePage(page) {
  const source = pageSource(page);
  const parsed = path.parse(source);
  const parts = parsed.dir
    ? [...parsed.dir.split(/[\\/]+/).filter(Boolean), parsed.name]
    : [parsed.name];
  const normalized = parts
    .filter((part) => part && part !== '.')
    .map((part, index) => {
      if (index === parts.length - 1 && /^index$/i.test(part)) return 'home';
      return kebabCase(part);
    })
    .filter(Boolean);
  const slug = normalized.join('/') || 'home';
  return {
    slug,
    path: slug === 'home' ? '/' : `/${slug}`,
    source_page: source,
    primary: path.basename(source).toLowerCase() === 'index.html'
  };
}

function pageSource(page) {
  return typeof page === 'string' ? page : String(page?.page || 'index.html');
}

function routeImportPrefix(slug) {
  const depth = String(slug || 'home').split('/').filter(Boolean).length + 1;
  return '../'.repeat(depth).replace(/\/$/, '');
}

function routePreviewPath(namespace, slug, framework) {
  if (framework === 'astro') return `${namespace}/routes/${slug}/TemplatePage.astro`;
  if (framework === 'react' || framework === 'next') return `${namespace}/routes/${slug}/TemplatePage.jsx`;
  if (framework === 'vue' || framework === 'nuxt') return `${namespace}/routes/${slug}/TemplatePage.vue`;
  return `${namespace}/routes/${slug}/template.html`;
}

function kebabCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'page';
}

function replaceHtmlAssetRefs(html, assetCopies, sourcePage, assetPrefix) {
  const replacements = new Map();
  for (const asset of assetCopies) {
    for (const original of asset.original_refs.filter((entry) => entry.output_base === '.' && entry.source_file === sourcePage)) {
      replacements.set(original.reference, `${assetPrefix}/${asset.asset_path}`);
    }
  }
  if (replacements.size === 0) return html;
  return rewriteHtmlAttributes(html, (attribute) => {
    if (attribute.value === null) return attribute;
    const lower = attribute.name.toLowerCase();
    if (['src', 'href', 'poster'].includes(lower) && replacements.has(attribute.value)) {
      return { ...attribute, value: replacements.get(attribute.value) };
    }
    if (lower === 'srcset') {
      return { ...attribute, value: rewriteSrcsetAssetRefs(attribute.value, replacements) };
    }
    return attribute;
  });
}

function uniqueRefs(values) {
  return [...new Set(values.filter(Boolean))];
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
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const removedInlineHandlers = countInlineHandlerAttributes(withoutScripts);
  const withoutHandlers = rewriteHtmlAttributes(withoutScripts, (attribute) => (
    /^on[a-z]/i.test(attribute.name) ? null : attribute
  ));
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
  let output = rewriteHtmlAttributes(html, (attribute) => {
    if (attribute.value === null) return attribute;
    const lower = attribute.name.toLowerCase();
    if (lower === 'id') {
      return { ...attribute, value: namespaceIdReference(attribute.value, prefix) };
    }
    if (['for', 'list', 'form', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-flowto'].includes(lower)) {
      return { ...attribute, value: namespaceIdReferenceList(attribute.value, prefix) };
    }
    if ((lower === 'href' || lower === 'xlink:href') && attribute.value.startsWith('#')) {
      return { ...attribute, value: `#${namespaceIdReference(attribute.value.slice(1), prefix)}` };
    }
    if (lower === 'class') {
      const classes = attribute.value.split(/\s+/).filter(Boolean).map((className) => (
        className.startsWith(`${prefix}-`) ? className : `${prefix}-${className}`
      ));
      return { ...attribute, value: classes.join(' ') };
    }
    return attribute;
  });
  output = markFirst(output, /<h1\b([^>]*)>/i, (_match, attributes) => (
    /\bdata-hts-field=/.test(attributes) ? `<h1${attributes}>` : `<h1${attributes} data-hts-field="headline">`
  ));
  output = markFirst(output, /<p\b([^>]*)>/i, (_match, attributes) => (
    /\bdata-hts-field=/.test(attributes) ? `<p${attributes}>` : `<p${attributes} data-hts-field="body">`
  ));
  return output;
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

function rewriteHtmlAttributes(html, visitor) {
  return html.replace(/<([a-zA-Z][\w:-]*)([^<>]*?)(\/?)>/g, (match, tagName, rawAttributes = '', selfClosing = '') => {
    if (match.startsWith('</')) return match;
    const attributes = tokenizeAttributes(rawAttributes);
    const rewritten = attributes
      .map((attribute) => visitor(attribute, tagName))
      .filter(Boolean)
      .map(serializeHtmlAttribute)
      .join('');
    return `<${tagName}${rewritten}${selfClosing ? ' /' : ''}>`;
  });
}

function serializeHtmlAttribute(attribute) {
  if (attribute.value === null) return ` ${attribute.name}`;
  return ` ${attribute.name}="${escapeHtmlAttribute(attribute.value)}"`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function countInlineHandlerAttributes(html) {
  let count = 0;
  rewriteHtmlAttributes(html, (attribute) => {
    if (/^on[a-z]/i.test(attribute.name)) count += 1;
    return attribute;
  });
  return count;
}

function rewriteSrcsetAssetRefs(value, replacements) {
  return String(value).split(',').map((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed) return candidate;
    const parts = trimmed.split(/\s+/);
    if (!replacements.has(parts[0])) return candidate;
    return [replacements.get(parts[0]), ...parts.slice(1)].join(' ');
  }).join(', ');
}

function tokenizeAttributes(rawAttributes) {
  const attributes = [];
  const attrPattern = /([:@a-zA-Z_][:@\w.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(rawAttributes)) !== null) {
    attributes.push({
      name: match[1],
      value: match[2] ?? match[3] ?? match[4] ?? null
    });
  }
  return attributes;
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
      output_base: entry.outputBase,
      source_file: entry.sourceFile
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

async function readTemplateScripts(templateRoot, pages, files, integrationId) {
  const sources = [];
  for (const page of pages) {
    for (const script of page.sanitized.scripts) {
      if (script.src) {
        if (isExternalRef(script.src)) continue;
        const source = path.resolve(path.dirname(page.source_path), stripRefQuery(script.src));
        if (await pathExists(source) && await isFile(source) && !sources.some((entry) => entry.source_file === relativeTo(templateRoot, source))) {
          sources.push({
            source_file: relativeTo(templateRoot, source),
            content: await readFile(source, 'utf8')
          });
        }
        continue;
      }
      if (script.content.trim()) {
        sources.push({
          source_file: `${page.source_page}#inline-script-${sources.length + 1}`,
          content: script.content
        });
      }
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
    return `  runIsolatedScript(${JSON.stringify(source.source_file)}, ${index + 1}, (window, document, root) => {\n${indent(isolated, 4)}\n  }, globalThis.window, scopedDocument, integrationRoot);`;
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

function runIsolatedScript(sourceFile, index, callback, window, document, root) {
  try {
    callback(window, document, root);
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
    .replace(/\bdocument\.getElementById\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, (_match, _quote, id) => `document.getElementById('hts-${integrationId}-${id}')`);
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function namespaceIdReferenceList(value, prefix) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => namespaceIdReference(entry, prefix))
    .join(' ');
}

function namespaceIdReference(value, prefix) {
  return String(value).startsWith(`${prefix}-`) ? String(value) : `${prefix}-${value}`;
}
