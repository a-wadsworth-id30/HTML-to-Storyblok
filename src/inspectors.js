import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { analyzeCss, analyzeHtml, analyzeScript, ASSET_EXTENSIONS, extractAssetReferences, findMissingLocalAssets } from './analyzer.js';
import { assessTemplateReadiness } from './template-readiness.js';
import { relativeTo, sha256, unique } from './utils.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.astro', '.tmp']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot', '.woff']);
const MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg']);

export async function walkFiles(root) {
  const output = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }
  }
  await walk(root);
  return output.sort();
}

export async function inspectTemplate(templatePath) {
  const root = path.resolve(templatePath);
  const files = await walkFiles(root);
  const inventory = [];
  const pages = [];
  const pageInventory = [];
  const sharedSections = new Set();
  const behaviours = new Set();
  const thirdParty = new Set();
  const accessibility = [];
  const assets = [];
  const fonts = [];
  const cssInventory = [];
  const scriptInventory = [];
  const missingAssets = [];
  const assetReferences = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const rel = relativeTo(root, file);
    const stats = await stat(file);
    let content = '';
    if (stats.size <= 2_000_000 && !IMAGE_EXTENSIONS.has(ext) && !FONT_EXTENSIONS.has(ext) && !MEDIA_EXTENSIONS.has(ext)) {
      content = await readFile(file, 'utf8');
    }

    if (ext === '.html') {
      const facts = analyzeHtml(content, { sourceFile: rel });
      pages.push(rel);
      for (const [name, count] of Object.entries(facts.landmarks)) {
        if (count > 0 && ['header', 'nav', 'footer'].includes(name)) sharedSections.add(name === 'nav' ? 'navigation' : name);
      }
      if (facts.forms.length > 0) behaviours.add('form submission');
      if (facts.tag_counts.dialog || /modal/i.test(content)) behaviours.add('dialog or modal');
      if (facts.scripts.length > 0 || facts.inline_handlers.length > 0) behaviours.add('client-side behaviour');
      facts.external_urls.forEach((url) => thirdParty.add(url));
      facts.accessibility_issues.forEach((issue) => accessibility.push(issue));
      assetReferences.push(...facts.asset_references.map((reference) => ({ source_file: rel, reference })));
      missingAssets.push(...await findMissingLocalAssets(root, rel, facts.asset_references));
      pageInventory.push({
        page: rel,
        title: facts.title,
        description: facts.description,
        seo: facts.seo,
        tag_counts: facts.tag_counts,
        landmarks: facts.landmarks,
        headings: facts.headings,
        text_blocks: facts.text_blocks,
        forms: facts.forms,
        links: facts.links,
        images: facts.images,
        classes: facts.classes,
        ids: facts.ids,
        scripts: facts.scripts,
        inline_handlers: facts.inline_handlers,
        asset_references: facts.asset_references,
        external_urls: facts.external_urls,
        repeated_candidates: facts.repeated_candidates,
        risks: facts.risks
      });
      inventory.push(item(rel, 'Template root content type', content, stats.size, {
        editableContent: inferEditableContentFromFacts(facts),
        behaviour: inferBehaviour(content, facts.risks),
        assets: facts.asset_references,
        risks: facts.risks.join('; ') || inferRisks(content)
      }));
      continue;
    }

    if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
      const facts = analyzeCss(content, { sourceFile: rel });
      if (facts.breakpoints.length > 0) behaviours.add('responsive CSS breakpoints');
      facts.asset_references.forEach((reference) => assetReferences.push({ source_file: rel, reference }));
      missingAssets.push(...await findMissingLocalAssets(root, rel, facts.asset_references));
      cssInventory.push(facts);
      inventory.push(item(rel, 'Framework-only component', content, stats.size, {
        behaviour: facts.breakpoints,
        assets: facts.asset_references,
        risks: facts.risks.join('; ') || inferRisks(content)
      }));
      continue;
    }

    if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
      const facts = analyzeScript(content, { sourceFile: rel });
      if (facts.event_types.length > 0 || facts.selectors.length > 0 || facts.browser_apis.length > 0) {
        behaviours.add('client-side behaviour');
      }
      facts.external_urls.forEach((url) => thirdParty.add(url));
      facts.asset_references.forEach((reference) => assetReferences.push({ source_file: rel, reference }));
      missingAssets.push(...await findMissingLocalAssets(root, rel, facts.asset_references));
      scriptInventory.push(facts);
      inventory.push(item(rel, 'Client-side behaviour', content, stats.size, {
        behaviour: [...facts.event_types, ...facts.browser_apis],
        assets: facts.asset_references,
        risks: facts.risks.join('; ') || inferRisks(content)
      }));
      continue;
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      assets.push({ file: rel, type: ext.slice(1), bytes: stats.size });
      inventory.push(fileItem(rel, 'Static asset', stats.size));
      continue;
    }

    if (FONT_EXTENSIONS.has(ext)) {
      fonts.push({ file: rel, type: ext.slice(1), bytes: stats.size, licence: 'Manual review required' });
      inventory.push(fileItem(rel, 'Static asset', stats.size, 'Font licence requires review before redistribution'));
      continue;
    }

    if (MEDIA_EXTENSIONS.has(ext)) {
      assets.push({ file: rel, type: ext.slice(1), bytes: stats.size });
      inventory.push(fileItem(rel, 'Static asset', stats.size));
      continue;
    }

    inventory.push(fileItem(rel, 'Excluded item', stats.size, 'No automatic template classification yet'));
  }

  const result = {
    template_path: root,
    files_inspected: files.map((file) => relativeTo(root, file)),
    pages,
    page_inventory: pageInventory,
    shared_sections: [...sharedSections],
    shared_section_inventory: [...sharedSections].map((name) => ({
      name,
      pages: pageInventory.filter((page) => page.landmarks[name === 'navigation' ? 'nav' : name] > 0).map((page) => page.page)
    })),
    repeated_sections: inferRepeatedSections(files.map((file) => relativeTo(root, file))),
    behaviours: [...behaviours],
    behaviour_inventory: scriptInventory,
    third_party_integrations: [...thirdParty],
    third_party_integration_inventory: [...thirdParty].map((url) => ({ url, classification: 'Manual review required' })),
    accessibility_issues: accessibility,
    accessibility_issue_inventory: accessibility,
    assets,
    asset_inventory: assets,
    asset_references: uniqueAssetReferences(assetReferences),
    missing_assets: uniqueMissingAssets(missingAssets),
    fonts,
    font_inventory: fonts,
    css_inventory: cssInventory,
    script_inventory: scriptInventory,
    inventory
  };
  result.template_readiness = assessTemplateReadiness(result);
  return result;
}

export async function inspectRepository(repositoryPath) {
  const root = path.resolve(repositoryPath);
  const files = await walkFiles(root);
  const relFiles = files.map((file) => relativeTo(root, file));
  const packageJsonPath = path.join(root, 'package.json');
  let packageJson = null;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch {
    packageJson = null;
  }

  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {})
  };
  const storyblokPackages = Object.entries(dependencies)
    .filter(([name]) => name.includes('storyblok'))
    .map(([name, version]) => ({ name, version }));

  const framework = detectFramework(dependencies, relFiles);
  const packageManager = detectPackageManager(relFiles);
  const packageManagerVersion = detectPackageManagerVersion(packageJson, packageManager.name);
  const nodeVersion = await readOptional(root, ['.nvmrc', '.node-version']);
  const netlifyToml = relFiles.includes('netlify.toml') ? await readFile(path.join(root, 'netlify.toml'), 'utf8') : '';
  const storyblokEvidence = await scanFiles(root, files, [
    '@storyblok/',
    'storyblokInit',
    'StoryblokComponent',
    'storyblokEditable',
    'useStoryblok',
    'useStoryblokApi',
    'STORYBLOK_'
  ]);

  return {
    repository_path: root,
    files_inspected: relFiles,
    package_json_present: Boolean(packageJson),
    package_name: packageJson?.name || null,
    scripts: packageJson?.scripts || {},
    framework,
    framework_version: dependencies[framework.package] || null,
    rendering_mode: inferRenderingMode(framework.name, relFiles, dependencies),
    package_manager: packageManager.name,
    package_manager_version: packageManagerVersion || packageManager.version,
    node_version: nodeVersion?.content?.trim() || null,
    typescript: relFiles.some((file) => file.endsWith('.ts') || file.endsWith('.tsx')),
    styling_system: detectStyling(dependencies, relFiles),
    image_strategy: detectImageStrategy(dependencies, relFiles),
    storyblok_sdk: storyblokPackages,
    storyblok_rendering_pattern: unique(storyblokEvidence.map((entry) => entry.pattern)),
    component_discovery_pattern: inferComponentDiscovery(relFiles),
    storyblok: {
      env_variable_names: unique(storyblokEvidence.filter((entry) => /^STORYBLOK_/.test(entry.pattern)).map((entry) => entry.pattern)),
      component_registry_candidates: relFiles.filter((file) => /storyblok.*components|components.*storyblok|blok.*resolver|component.*resolver/i.test(file)),
      api_client_candidates: relFiles.filter((file) => /storyblok|cms|api/i.test(file) && /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file)),
      route_candidates: relFiles.filter((file) => /(pages|app|routes|src\/pages).*\[(slug|path|params)|storyblok/i.test(file)),
      generated_type_candidates: relFiles.filter((file) => /storyblok.*types|types.*storyblok|component-types/i.test(file))
    },
    commands: inferCommands(packageJson),
    netlify: parseNetlifyToml(netlifyToml),
    evidence: {
      storyblok: storyblokEvidence,
      framework_files: relFiles.filter((file) => /^(astro|nuxt|next|svelte|vite)\.config\./.test(file) || file === 'package.json'),
      netlify_files: relFiles.filter((file) => file === 'netlify.toml' || file.endsWith('_redirects') || file.endsWith('_headers'))
    }
  };
}

export async function inspectNetlify(repositoryPath) {
  const repository = await inspectRepository(repositoryPath);
  return {
    source: 'repository',
    site_name: repository.netlify.site_name || null,
    site_id: null,
    linked_repository: null,
    production_branch: repository.netlify.production_branch || null,
    build_command: repository.netlify.build_command || null,
    base_directory: repository.netlify.base || null,
    publish_directory: repository.netlify.publish || null,
    framework: repository.framework.name,
    deploy_previews: repository.netlify.deploy_previews || 'Unconfirmed without Netlify API access',
    required_variable_names: repository.netlify.environment_variables,
    status: 'Repository contract inspected; Netlify API not queried by this command.'
  };
}

export function inspectStoryblokEnvironment(env = process.env) {
  const names = Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name));
  return {
    management_api_available: names.some((name) => /MANAGEMENT|OAUTH|PERSONAL|TOKEN/i.test(name)),
    preview_api_available: names.some((name) => /PREVIEW|PUBLIC|TOKEN/i.test(name)),
    variable_names: names.sort(),
    note: 'Values are intentionally omitted.'
  };
}

function item(sourceFile, classification, content, bytes, extra = []) {
  const overrides = Array.isArray(extra) ? {} : extra;
  return {
    template_item: path.basename(sourceFile),
    source_file: sourceFile,
    classification,
    repeated: 'Unknown',
    editable_content: overrides.editableContent || inferEditableContent(content),
    behaviour: overrides.behaviour || inferBehaviour(content, extra),
    assets: overrides.assets || extractAssetReferences(content),
    risks_or_notes: overrides.risks || inferRisks(content)
  };
}

function fileItem(sourceFile, classification, bytes, note = '') {
  return {
    template_item: path.basename(sourceFile),
    source_file: sourceFile,
    classification,
    repeated: 'No',
    editable_content: [],
    behaviour: [],
    assets: [],
    risks_or_notes: note || `${bytes} bytes`
  };
}

function inferEditableContent(content) {
  const fields = [];
  if (/<h[1-6][\s>]/i.test(content)) fields.push('headings');
  if (/<p[\s>]/i.test(content)) fields.push('body copy');
  if (/<a[\s>]/i.test(content)) fields.push('links');
  if (/<img[\s>]/i.test(content)) fields.push('images');
  if (/<form[\s>]/i.test(content)) fields.push('form labels');
  return fields;
}

function inferBehaviour(content, extra = []) {
  const behaviours = [...extra];
  if (/addEventListener|querySelector|IntersectionObserver/i.test(content)) behaviours.push('DOM scripting');
  if (/animation|transition|@keyframes/i.test(content)) behaviours.push('animation');
  if (/<form[\s>]/i.test(content)) behaviours.push('form');
  return unique(behaviours);
}

function inferRisks(content) {
  const risks = [];
  if (/<script[^>]+src=["']https?:\/\//i.test(content)) risks.push('External script requires review');
  if (/gtag|googletagmanager|facebook|hotjar|segment/i.test(content)) risks.push('Tracking code requires removal or approval');
  if (/innerHTML|document\.write|eval\(/i.test(content)) risks.push('Unsafe script pattern requires rewrite');
  if (/<img\b(?![^>]*\balt=)/i.test(content)) risks.push('Missing image alt text');
  return risks.join('; ') || 'None detected';
}

function inferRepeatedSections(files) {
  const names = files.map((file) => path.basename(file).toLowerCase());
  return ['card', 'item', 'grid', 'section', 'slide', 'testimonial', 'feature'].filter((needle) =>
    names.some((name) => name.includes(needle))
  );
}

function detectFramework(dependencies, files) {
  if (dependencies.astro || files.some((file) => file.startsWith('astro.config.'))) return { name: 'Astro', package: 'astro' };
  if (dependencies.nuxt || files.some((file) => file.startsWith('nuxt.config.'))) return { name: 'Nuxt', package: 'nuxt' };
  if (dependencies.next || files.some((file) => file.startsWith('next.config.'))) return { name: 'Next.js', package: 'next' };
  if (dependencies['@sveltejs/kit'] || files.some((file) => file.startsWith('svelte.config.'))) return { name: 'SvelteKit', package: '@sveltejs/kit' };
  if (dependencies.vite && dependencies.vue) return { name: 'Vue', package: 'vue' };
  if (dependencies.vite && dependencies.react) return { name: 'React', package: 'react' };
  if (dependencies.vite || files.some((file) => file.startsWith('vite.config.'))) return { name: 'Vite', package: 'vite' };
  return { name: 'Uncertain', package: null };
}

function detectPackageManager(files) {
  if (files.includes('pnpm-lock.yaml')) return { name: 'pnpm', version: null };
  if (files.includes('yarn.lock')) return { name: 'yarn', version: null };
  if (files.includes('package-lock.json')) return { name: 'npm', version: null };
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return { name: 'bun', version: null };
  return { name: 'npm', version: null };
}

function detectPackageManagerVersion(packageJson, packageManagerName) {
  const packageManager = packageJson?.packageManager;
  if (typeof packageManager === 'string') {
    const [name, version] = packageManager.split('@');
    if (name === packageManagerName && version) return version;
  }
  return null;
}

function inferRenderingMode(frameworkName, files, dependencies) {
  if (frameworkName === 'Astro' && Object.keys(dependencies).some((name) => name.includes('/netlify'))) return 'Hybrid or SSR';
  if (frameworkName === 'Next.js') return 'Hybrid';
  if (frameworkName === 'Nuxt') return 'Hybrid or SSR';
  if (frameworkName === 'Uncertain') return 'Uncertain';
  return 'SSG';
}

function detectStyling(dependencies, files) {
  const systems = [];
  if (dependencies.tailwindcss || files.some((file) => file.includes('tailwind.config'))) systems.push('Tailwind CSS');
  if (files.some((file) => /\.module\.css$/.test(file))) systems.push('CSS Modules');
  if (files.some((file) => /\.(scss|sass)$/.test(file))) systems.push('Sass');
  if (files.some((file) => file.endsWith('.css'))) systems.push('CSS');
  return systems.length ? systems.join(', ') : 'Uncertain';
}

function detectImageStrategy(dependencies, files) {
  if (dependencies['@astrojs/image'] || dependencies.astro) return 'Framework image tooling or Astro assets';
  if (dependencies.next) return 'Next image pipeline';
  if (dependencies.nuxt || dependencies['@nuxt/image']) return 'Nuxt image pipeline';
  if (files.some((file) => /image|picture|asset/i.test(file) && /\.(js|jsx|ts|tsx|vue|astro)$/.test(file))) return 'Repository image components';
  if (files.some((file) => file.startsWith('public/'))) return 'Public static assets';
  return 'Uncertain';
}

function inferComponentDiscovery(files) {
  if (files.some((file) => /storyblok.*components|components.*storyblok/i.test(file))) return 'Explicit Storyblok component registry';
  if (files.some((file) => file.includes('src/storyblok'))) return 'Storyblok directory convention';
  if (files.some((file) => /import\.meta\.glob|globEager/i.test(file))) return 'Automatic glob discovery';
  return 'Uncertain';
}

function inferCommands(packageJson) {
  const scripts = packageJson?.scripts || {};
  return {
    dev: scripts.dev || null,
    build: scripts.build || null,
    typecheck: scripts.typecheck || scripts['type-check'] || scripts.check || null,
    lint: scripts.lint || null,
    test: scripts.test || null
  };
}

async function scanFiles(root, files, patterns) {
  const matches = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.astro', '.json', '.md', '.mjs', '.cjs'].includes(ext)) continue;
    const content = await readFile(file, 'utf8');
    for (const pattern of patterns) {
      if (content.includes(pattern)) {
        matches.push({
          file: relativeTo(root, file),
          pattern,
          hash: sha256(`${relativeTo(root, file)}:${pattern}`).slice(0, 12)
        });
      }
    }
  }
  return matches;
}

async function readOptional(root, names) {
  for (const name of names) {
    try {
      return { name, content: await readFile(path.join(root, name), 'utf8') };
    } catch {
      // continue
    }
  }
  return null;
}

function parseNetlifyToml(content) {
  if (!content) {
    return {
      present: false,
      environment_variables: []
    };
  }
  const get = (key) => {
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]+)["']?`, 'm'));
    return match ? match[1].trim() : null;
  };
  const envNames = [
    ...content.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=/gm),
    ...content.matchAll(/^\s*environment\s*=\s*{([^}]+)}/gm)
  ].flatMap((match) => {
    if (match[1].includes('=')) {
      return [...match[1].matchAll(/([A-Z][A-Z0-9_]+)\s*=/g)].map((entry) => entry[1]);
    }
    return match[1];
  });
  return {
    present: true,
    build_command: get('command'),
    publish: get('publish'),
    base: get('base'),
    site_name: get('name'),
    production_branch: get('production_branch'),
    deploy_previews: content.includes('context.deploy-preview') ? 'Configured in netlify.toml' : 'Default or unconfirmed',
    environment_variables: unique(envNames),
    contexts: unique([...content.matchAll(/^\s*\[context\.([^\]]+)]/gm)].map((match) => match[1])),
    plugins: unique([...content.matchAll(/^\s*package\s*=\s*["']([^"']+)["']/gm)].map((match) => match[1])),
    redirects: content.includes('[[redirects]]'),
    headers: content.includes('[[headers]]'),
    functions_directory: get('directory')
  };
}

function inferEditableContentFromFacts(facts) {
  const fields = [];
  if (facts.headings.length > 0) fields.push('headings');
  if (facts.text_blocks.some((block) => ['p', 'li', 'blockquote'].includes(block.tag))) fields.push('body copy');
  if (facts.links.length > 0) fields.push('links');
  if (facts.images.length > 0) fields.push('images');
  if (facts.forms.length > 0) fields.push('form labels');
  return unique(fields);
}

function uniqueAssetReferences(references) {
  const seen = new Set();
  const output = [];
  for (const entry of references) {
    const key = `${entry.source_file}:${entry.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function uniqueMissingAssets(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const key = `${entry.source_file}:${entry.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}
