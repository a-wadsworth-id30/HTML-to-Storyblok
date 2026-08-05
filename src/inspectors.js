import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { relativeTo, sha256, unique } from './utils.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.astro', '.tmp']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
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
  const sharedSections = new Set();
  const behaviours = new Set();
  const thirdParty = new Set();
  const accessibility = [];
  const assets = [];
  const fonts = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const rel = relativeTo(root, file);
    const stats = await stat(file);
    let content = '';
    if (stats.size <= 2_000_000 && !IMAGE_EXTENSIONS.has(ext) && !FONT_EXTENSIONS.has(ext) && !MEDIA_EXTENSIONS.has(ext)) {
      content = await readFile(file, 'utf8');
    }

    if (ext === '.html') {
      pages.push(rel);
      if (/<header[\s>]/i.test(content)) sharedSections.add('header');
      if (/<nav[\s>]/i.test(content)) sharedSections.add('navigation');
      if (/<footer[\s>]/i.test(content)) sharedSections.add('footer');
      if (/<form[\s>]/i.test(content)) behaviours.add('form submission');
      if (/<dialog[\s>]|modal/i.test(content)) behaviours.add('dialog or modal');
      if (/<img\b(?![^>]*\balt=)/i.test(content)) accessibility.push({ file: rel, issue: 'Image without explicit alt attribute' });
      extractUrls(content).forEach((url) => {
        if (/^https?:\/\//i.test(url)) thirdParty.add(url);
      });
      inventory.push(item(rel, 'Template root content type', content, stats.size));
      continue;
    }

    if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
      const breakpoints = [...content.matchAll(/@media[^{]+/gi)].map((match) => match[0]);
      if (breakpoints.length > 0) behaviours.add('responsive CSS breakpoints');
      inventory.push(item(rel, 'Framework-only component', content, stats.size, breakpoints));
      continue;
    }

    if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
      if (/addEventListener|querySelector|IntersectionObserver|Swiper|gsap|anime|scroll/i.test(content)) {
        behaviours.add('client-side behaviour');
      }
      extractUrls(content).forEach((url) => thirdParty.add(url));
      inventory.push(item(rel, 'Client-side behaviour', content, stats.size));
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

  return {
    template_path: root,
    files_inspected: files.map((file) => relativeTo(root, file)),
    pages,
    shared_sections: [...sharedSections],
    repeated_sections: inferRepeatedSections(files.map((file) => relativeTo(root, file))),
    behaviours: [...behaviours],
    third_party_integrations: [...thirdParty],
    accessibility_issues: accessibility,
    assets,
    fonts,
    inventory
  };
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
    framework,
    framework_version: dependencies[framework.package] || null,
    rendering_mode: inferRenderingMode(framework.name, relFiles, dependencies),
    package_manager: packageManager.name,
    package_manager_version: packageManager.version,
    node_version: nodeVersion?.content?.trim() || null,
    typescript: relFiles.some((file) => file.endsWith('.ts') || file.endsWith('.tsx')),
    styling_system: detectStyling(dependencies, relFiles),
    storyblok_sdk: storyblokPackages,
    storyblok_rendering_pattern: unique(storyblokEvidence.map((entry) => entry.pattern)),
    component_discovery_pattern: inferComponentDiscovery(relFiles),
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
  return {
    template_item: path.basename(sourceFile),
    source_file: sourceFile,
    classification,
    repeated: 'Unknown',
    editable_content: inferEditableContent(content),
    behaviour: inferBehaviour(content, extra),
    assets: extractAssetRefs(content),
    risks_or_notes: inferRisks(content)
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

function extractUrls(content) {
  return [...content.matchAll(/https?:\/\/[^"')\s<>]+/gi)].map((match) => match[0]);
}

function extractAssetRefs(content) {
  return unique([...content.matchAll(/(?:src|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|woff2?|ttf|otf))["']/gi)].map((match) => match[1]));
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

function inferComponentDiscovery(files) {
  if (files.some((file) => /storyblok.*components|components.*storyblok/i.test(file))) return 'Explicit Storyblok component registry';
  if (files.some((file) => file.includes('src/storyblok'))) return 'Storyblok directory convention';
  return 'Uncertain';
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
  const envNames = [...content.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map((match) => match[1]);
  return {
    present: true,
    build_command: get('command'),
    publish: get('publish'),
    base: get('base'),
    site_name: get('name'),
    production_branch: get('production_branch'),
    deploy_previews: content.includes('context.deploy-preview') ? 'Configured in netlify.toml' : 'Default or unconfirmed',
    environment_variables: unique(envNames)
  };
}

