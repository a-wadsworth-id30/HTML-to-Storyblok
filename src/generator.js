import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { copyConvertedAssets, convertTemplate } from './template-converter.js';
import { ensureArray, pathExists, writeJson, writeText } from './utils.js';

export async function generateIntegration(manifest, { repoPath = process.cwd(), templatePath, framework = 'auto', dryRun = false } = {}) {
  const root = path.resolve(repoPath);
  const namespace = manifest.repository_namespace;
  if (!namespace) throw new Error('manifest is missing repository_namespace');

  const conversion = await convertTemplate({ templatePath, repoPath: root, manifest, framework });
  const files = buildGeneratedFiles(manifest, { conversion });
  const unplanned = files
    .map((file) => file.path)
    .filter((filePath) => !ensureArray(manifest.repository?.files_to_create).includes(filePath));
  if (unplanned.length > 0) {
    throw new Error(`generated files are missing from manifest.repository.files_to_create: ${unplanned.join(', ')}`);
  }
  const collisions = [];
  for (const file of files) {
    const absolute = path.join(root, file.path);
    if (await pathExists(absolute)) collisions.push(file.path);
  }
  if (collisions.length > 0) {
    throw new Error(`refusing to overwrite existing generated files: ${collisions.join(', ')}`);
  }

  if (!dryRun) {
    for (const file of files) {
      const absolute = path.join(root, file.path);
      if (file.json) {
        await writeJson(absolute, file.content);
      } else {
        await writeText(absolute, file.content);
      }
    }
    await mkdir(path.join(root, namespace, 'assets'), { recursive: true });
    if (conversion) {
      await copyConvertedAssets(conversion.asset_copies, root, { dryRun });
    }
  }

  return {
    action: 'generate_framework_components',
    dry_run: dryRun,
    repository_path: root,
    framework: conversion?.framework || 'generic',
    source_page: conversion?.source_page || null,
    files: files.map((file) => file.path),
    assets: conversion?.asset_copies?.map((asset) => asset.target_path) || [],
    removed_scripts: conversion?.removed_scripts || 0,
    removed_inline_handlers: conversion?.removed_inline_handlers || 0,
    excluded_external_scripts: conversion?.excluded_external_scripts || [],
    isolated_scripts: conversion?.isolated_scripts || [],
    note: 'Generated files are isolated. Existing registries and routes are not modified.'
  };
}

export function buildGeneratedFiles(manifest, { conversion = null } = {}) {
  const namespace = manifest.repository_namespace;
  const integrationId = manifest.integration_id;
  const cssClass = integrationId.replaceAll('-', '-');
  const components = ensureArray(manifest.storyblok?.components_to_create);
  const componentNames = components.map((component) => component.technical_name || component.name || component);
  const files = [
    {
      path: `${namespace}/integration-manifest.json`,
      json: true,
      content: manifest
    },
    {
      path: `${namespace}/index.js`,
      content: renderIndex(componentNames)
    },
    {
      path: `${namespace}/components.js`,
      content: renderComponents(integrationId, componentNames)
    },
    {
      path: `${namespace}/styles/${integrationId}.css`,
      content: renderCss(cssClass)
    },
    {
      path: `${namespace}/README.md`,
      content: renderIntegrationReadme(manifest)
    }
  ];
  if (conversion) {
    files.push(...conversion.files);
  }
  return files;
}

function renderIndex(componentNames) {
  return `import { htsComponents } from './components.js';

export { htsComponents };

export const htsStoryblokComponents = {
${componentNames.map((name) => `  ${JSON.stringify(name)}: htsComponents[${JSON.stringify(name)}]`).join(',\n')}
};
`;
}

function renderComponents(integrationId, componentNames) {
  const rootClass = `hts-${integrationId}-root`;
  const componentEntries = componentNames.map((name) => {
    const fn = functionName(name);
    return `export function ${fn}(blok = {}) {
  const headline = escapeHtml(blok.headline || blok.name || '');
  const body = escapeHtml(blok.body || '');
  return \`<section class="${rootClass}__section" data-component="${name}">
    \${headline ? \`<h2>\${headline}</h2>\` : ''}
    \${body ? \`<p>\${body}</p>\` : ''}
  </section>\`;
}`;
  }).join('\n\n');

  return `import './styles/${integrationId}.css';

${componentEntries}

export const htsComponents = {
${componentNames.map((name) => `  ${JSON.stringify(name)}: ${functionName(name)}`).join(',\n')}
};

export function renderHtsPage(blok = {}) {
  const blocks = Array.isArray(blok.body) ? blok.body : [];
  const rendered = blocks.map((child) => {
    const renderer = htsComponents[child.component];
    return renderer ? renderer(child) : '';
  }).join('');
  return \`<main class="${rootClass}" data-integration="${integrationId}">\${rendered}</main>\`;
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

function renderCss(cssClass) {
  return `.${cssClass}-root {
  --hts-color-background: #ffffff;
  --hts-color-text: #171717;
  --hts-color-accent: #2457ff;
  color: var(--hts-color-text);
  background: var(--hts-color-background);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.${cssClass}-root *,
.${cssClass}-root *::before,
.${cssClass}-root *::after {
  box-sizing: border-box;
}

.${cssClass}-root__section {
  max-width: 72rem;
  margin: 0 auto;
  padding: clamp(3rem, 8vw, 6rem) 1rem;
}

.${cssClass}-root__section h2 {
  max-width: 14ch;
  margin: 0 0 1rem;
  font-size: clamp(2rem, 6vw, 4rem);
  line-height: 1;
}

.${cssClass}-root__section p {
  max-width: 42rem;
  margin: 0;
  font-size: 1.125rem;
  line-height: 1.6;
}

@media (prefers-reduced-motion: reduce) {
  .${cssClass}-root *,
  .${cssClass}-root *::before,
  .${cssClass}-root *::after {
    animation-duration: 0.001ms !important;
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}
`;
}

function renderIntegrationReadme(manifest) {
  return `# ${manifest.integration_id}

Generated isolated integration scaffold.

- Storyblok prefix: \`${manifest.storyblok_prefix}\`
- Repository namespace: \`${manifest.repository_namespace}\`
- Policy: \`${manifest.policy}\`

This folder is additive-only. It does not register routes or mutate existing component registries automatically.
`;
}

function functionName(name) {
  const parts = String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const pascal = parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
  return `render${pascal}`;
}
