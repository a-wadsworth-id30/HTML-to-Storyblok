import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureArray, pathExists, readJson, writeText } from './utils.js';

const SUPPORTED_FRAMEWORKS = new Set(['astro', 'next', 'nuxt']);
const STORYBLOK_CONTENT_BASE_URLS = {
  eu: 'https://api.storyblok.com/v2/cdn',
  us: 'https://api-us.storyblok.com/v2/cdn',
  ca: 'https://api-ca.storyblok.com/v2/cdn',
  ap: 'https://api-ap.storyblok.com/v2/cdn',
  cn: 'https://app.storyblokchina.cn/v2/cdn'
};

export async function wireRepositoryRoutes(manifest, {
  repoPath = process.cwd(),
  dryRun = false,
  route = null
} = {}) {
  const root = path.resolve(repoPath);
  const adapterPath = `${manifest.repository_namespace}/adapter-plan.json`;
  const adapterAbsolutePath = safeRepoPath(root, adapterPath);
  if (!(await pathExists(adapterAbsolutePath))) {
    return {
      action: 'wire_repository_routes',
      status: 'blocked',
      dry_run: dryRun,
      policy: 'additive-only-route-handoff',
      reason: `Generated adapter plan not found: ${adapterPath}. Run generate or apply before wiring routes.`,
      routes: [],
      summary: emptyRouteHandoffSummary()
    };
  }

  const plan = await readJson(adapterAbsolutePath);
  const selectedRoutes = filterRoutes(ensureArray(plan.routes), route);
  if (route && selectedRoutes.length === 0) {
    return {
      action: 'wire_repository_routes',
      status: 'blocked',
      dry_run: dryRun,
      policy: 'additive-only-route-handoff',
      reason: `No generated route matched ${route}.`,
      routes: [],
      summary: emptyRouteHandoffSummary()
    };
  }

  const routes = await Promise.all(selectedRoutes.map((entry) => planRouteHandoff(root, plan, entry, { dryRun })));
  const blocked = routes.filter((entry) => entry.status === 'blocked');
  if (blocked.length > 0) {
    return routeHandoffResult({ dryRun, routes, status: 'blocked', reason: 'One or more host route targets are unavailable. No files were written.' });
  }

  if (!dryRun) {
    for (const entry of routes.filter((item) => item.status === 'would_create')) {
      await mkdir(path.dirname(safeRepoPath(root, entry.host_route_file)), { recursive: true });
      await writeText(safeRepoPath(root, entry.host_route_file), renderHostRoute(plan, entry));
      entry.status = 'created';
      entry.dry_run = false;
    }
  }

  const status = routes.some((entry) => entry.status === 'created' || entry.status === 'would_create')
    ? 'passed'
    : 'skipped';
  return routeHandoffResult({ dryRun, routes, status });
}

async function planRouteHandoff(root, plan, route, { dryRun }) {
  const proposalFile = route.route_proposal_file || route.proposal_file;
  const hostRouteFile = concreteHostRouteFile(plan.framework, route);
  const base = {
    action: 'wire_route',
    dry_run: dryRun,
    slug: route.slug,
    suggested_site_path: route.suggested_site_path,
    storyblok_slug: route.storyblok_slug,
    seo: route.seo || {},
    route_proposal_file: proposalFile || null,
    host_route_file: hostRouteFile || null,
    registration_policy: 'manual_review_required',
    content_source: 'storyblok_content_api_optional',
    host_routes_modified: false
  };

  if (!SUPPORTED_FRAMEWORKS.has(plan.framework)) {
    return {
      ...base,
      status: 'skipped',
      reason: `Automatic route handoff is not supported for ${plan.framework}. Review the route proposal manually.`,
      manual_handoff: manualRouteHandoff(plan, route, proposalFile)
    };
  }
  if (!proposalFile) {
    return { ...base, status: 'blocked', reason: 'Route proposal file is missing from the adapter plan.' };
  }
  if (!hostRouteFile) {
    return { ...base, status: 'blocked', reason: 'No concrete host route file was suggested for this framework.' };
  }
  if (!safeHostRouteTarget(plan.framework, hostRouteFile)) {
    return { ...base, status: 'blocked', reason: `Unsafe host route target for ${plan.framework}: ${hostRouteFile}` };
  }
  if (!(await pathExists(safeRepoPath(root, proposalFile)))) {
    return { ...base, status: 'blocked', reason: `Route proposal file does not exist: ${proposalFile}` };
  }
  if (await pathExists(safeRepoPath(root, hostRouteFile))) {
    return { ...base, status: 'blocked', reason: `Host route already exists: ${hostRouteFile}` };
  }

  return {
    ...base,
    status: 'would_create',
    host_routes_modified: false,
    import_path: relativeImport(hostRouteFile, proposalFile)
  };
}

function routeHandoffResult({ dryRun, routes, status, reason = null }) {
  const manualRoutes = routes.filter((entry) => entry.manual_handoff);
  return {
    action: 'wire_repository_routes',
    status,
    dry_run: dryRun,
    policy: 'additive-only-route-handoff',
    host_routes_modified: false,
    host_route_files_created: dryRun ? 0 : routes.filter((entry) => entry.status === 'created').length,
    reason,
    routes,
    summary: summarizeRouteHandoff(routes),
    manual_handoff: manualRoutes.length > 0 ? summarizeManualHandoff(manualRoutes) : null
  };
}

function manualRouteHandoff(plan, route, proposalFile) {
  const framework = plan.framework || 'static';
  const importTarget = proposalFile || route.route_proposal_file || route.proposal_file || 'review adapter-plan.json for the generated route proposal';
  const sitePath = route.suggested_site_path || `/${route.slug || ''}`;
  const storyblokSlug = route.storyblok_slug || `${plan.integration_id}/${route.slug || 'home'}`;
  return {
    framework,
    required: true,
    site_path: sitePath,
    route_proposal_file: importTarget,
    storyblok_slug: storyblokSlug,
    policy: 'manual-review-required',
    reason: manualRouteReason(framework),
    steps: manualRouteSteps(framework, { importTarget, sitePath, storyblokSlug })
  };
}

function summarizeManualHandoff(routes) {
  const frameworks = [...new Set(routes.map((entry) => entry.manual_handoff.framework))];
  return {
    required: true,
    frameworks,
    routes: routes.length,
    policy: 'manual-review-required',
    summary: 'Automatic router mutation is disabled for these frameworks because route registration is project-specific.',
    next_steps: [
      'Open each route proposal file listed below.',
      'Create or update host router entries manually in the target app.',
      'Pass Storyblok draft content from the host app using its existing safe Content API pattern.',
      'Run the host app build and browser checks before deployment.'
    ]
  };
}

function manualRouteReason(framework) {
  if (framework === 'react') return 'React route registration depends on the host router setup, such as React Router, file-based routing, or custom app composition.';
  if (framework === 'vue') return 'Vue route registration depends on the host router setup, such as Vue Router, file-based routing, or custom app composition.';
  if (framework === 'static') return 'Static route publishing depends on the host file layout and deployment convention.';
  return `Automatic route handoff is not implemented for ${framework}.`;
}

function manualRouteSteps(framework, { importTarget, sitePath, storyblokSlug }) {
  const common = [
    `Review the generated route proposal: ${importTarget}`,
    `Map host route ${sitePath || '/'} to Storyblok draft ${storyblokSlug}.`,
    'Use a Content API token only in a safe server/runtime context; never expose Management API tokens.',
    'Run the target app validation, build, and browser preview before publishing.'
  ];
  if (framework === 'react') {
    return [
      ...common,
      'Register the imported route component in the host React router or app shell by hand.'
    ];
  }
  if (framework === 'vue') {
    return [
      ...common,
      'Register the imported route component in the host Vue router or page registry by hand.'
    ];
  }
  return common;
}

function filterRoutes(routes, route) {
  if (!route) return routes;
  const normalized = normalizeRouteSelector(route);
  return routes.filter((entry) => {
    const values = [entry.slug, entry.suggested_site_path, entry.storyblok_slug]
      .map(normalizeRouteSelector);
    return values.includes(normalized);
  });
}

function normalizeRouteSelector(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^home$/, '');
}

function concreteHostRouteFile(framework, route) {
  const candidates = ensureArray(route.suggested_host_files)
    .filter((filePath) => typeof filePath === 'string' && !/review the host router/i.test(filePath));
  if (framework === 'astro') return candidates.find((filePath) => filePath.endsWith('.astro')) || null;
  if (framework === 'next') return candidates.find((filePath) => /\.(jsx|tsx|js|ts)$/.test(filePath)) || null;
  if (framework === 'nuxt') return candidates.find((filePath) => filePath.endsWith('.vue')) || null;
  return null;
}

function safeHostRouteTarget(framework, filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return false;
  if (framework === 'astro') return normalized.startsWith('src/pages/') && normalized.endsWith('.astro');
  if (framework === 'next') return normalized.startsWith('src/app/') && /\.(jsx|tsx|js|ts)$/.test(normalized);
  if (framework === 'nuxt') return normalized.startsWith('pages/') && normalized.endsWith('.vue');
  return false;
}

function safeRepoPath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new Error(`unsafe repository path: ${relativePath}`);
  }
  const absolutePath = path.resolve(root, normalized);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`repository path escapes root: ${relativePath}`);
  }
  return absolutePath;
}

function normalizeRelativePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function relativeImport(fromFile, toFile) {
  let relative = path.posix.relative(path.posix.dirname(normalizeRelativePath(fromFile)), normalizeRelativePath(toFile));
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function renderHostRoute(plan, entry) {
  if (plan.framework === 'astro') return renderAstroHostRoute(plan, entry);
  if (plan.framework === 'next') return renderNextHostRoute(plan, entry);
  if (plan.framework === 'nuxt') return renderNuxtHostRoute(plan, entry);
  throw new Error(`unsupported route handoff framework: ${plan.framework}`);
}

function routeHeader(plan, entry) {
  return `Generated by HTML-to-Storyblok.
Integration: ${plan.integration_id}
Source proposal: ${entry.route_proposal_file}
Policy: additive-only route handoff. Existing route files were not overwritten.`;
}

function renderAstroHostRoute(plan, entry) {
  return `---
// ${routeHeader(plan, entry).replaceAll('\n', '\n// ')}
import ImportedRoute from '${entry.import_path}';

${renderRouteSeoConstant(entry.seo)}
${renderStoryblokContentHelpers(entry.storyblok_slug)}

const story = Astro.props.story || await htsFetchStoryblokDraft();
const blok = Astro.props.blok || story?.content || {};
const htsStoryblokSource = story ? 'storyblok-draft' : 'generated-fallback';
const htsSeo = htsResolveStoryblokSeo(story, HTS_ROUTE_SEO);
---

<head>
  {htsSeo.title && <title>{htsSeo.title}</title>}
  {htsSeo.description && <meta name="description" content={htsSeo.description} />}
  {htsSeo.canonical_url && <link rel="canonical" href={htsSeo.canonical_url} />}
  {htsSeo.robots && <meta name="robots" content={htsSeo.robots} />}
  {htsSeo.og_title && <meta property="og:title" content={htsSeo.og_title} />}
  {htsSeo.og_description && <meta property="og:description" content={htsSeo.og_description} />}
  {htsSeo.og_image && <meta property="og:image" content={htsSeo.og_image} />}
  {htsSeo.og_type && <meta property="og:type" content={htsSeo.og_type} />}
  {htsSeo.twitter_card && <meta name="twitter:card" content={htsSeo.twitter_card} />}
  {htsSeo.twitter_title && <meta name="twitter:title" content={htsSeo.twitter_title} />}
  {htsSeo.twitter_description && <meta name="twitter:description" content={htsSeo.twitter_description} />}
  {htsSeo.twitter_image && <meta name="twitter:image" content={htsSeo.twitter_image} />}
</head>
<span data-hts-storyblok-source={htsStoryblokSource} data-hts-storyblok-slug={HTS_STORYBLOK_STORY_SLUG} hidden></span>
<ImportedRoute story={story} blok={blok} />
`;
}

function renderNextHostRoute(plan, entry) {
  return `// ${routeHeader(plan, entry).replaceAll('\n', '\n// ')}
import ImportedRoute from '${entry.import_path}';

export const dynamic = 'force-dynamic';

${renderRouteSeoConstant(entry.seo)}
${renderStoryblokContentHelpers(entry.storyblok_slug)}

export async function generateMetadata() {
  const story = await htsFetchStoryblokDraft();
  return htsNextRouteMetadata(htsResolveStoryblokSeo(story, HTS_ROUTE_SEO));
}

export default async function HtsImportedRoutePage() {
  const story = await htsFetchStoryblokDraft();
  const htsStoryblokSource = story ? 'storyblok-draft' : 'generated-fallback';
  return (
    <>
      <span data-hts-storyblok-source={htsStoryblokSource} data-hts-storyblok-slug={HTS_STORYBLOK_STORY_SLUG} hidden />
      <ImportedRoute story={story} blok={story?.content || null} />
    </>
  );
}
`;
}

function renderNuxtHostRoute(plan, entry) {
  return `<script setup>
// ${routeHeader(plan, entry).replaceAll('\n', '\n// ')}
import ImportedRoute from '${entry.import_path}';

${renderRouteSeoConstant(entry.seo)}
${renderStoryblokContentHelpers(entry.storyblok_slug, { clientGuard: true })}

const { data: story } = await useAsyncData('hts-${safeIdentifier(entry.slug)}-storyblok-draft', () => htsFetchStoryblokDraft(), {
  server: true
});
const htsSeo = computed(() => htsResolveStoryblokSeo(story.value, HTS_ROUTE_SEO));

useSeoMeta({
  title: () => htsSeo.value.title || undefined,
  description: () => htsSeo.value.description || undefined,
  robots: () => htsSeo.value.robots || undefined,
  ogTitle: () => htsSeo.value.og_title || htsSeo.value.title || undefined,
  ogDescription: () => htsSeo.value.og_description || htsSeo.value.description || undefined,
  ogImage: () => htsSeo.value.og_image || undefined,
  ogType: () => htsSeo.value.og_type || undefined,
  twitterCard: () => htsSeo.value.twitter_card || undefined,
  twitterTitle: () => htsSeo.value.twitter_title || htsSeo.value.title || undefined,
  twitterDescription: () => htsSeo.value.twitter_description || htsSeo.value.description || undefined,
  twitterImage: () => htsSeo.value.twitter_image || undefined
});

useHead(computed(() => ({
  link: htsSeo.value.canonical_url ? [{ rel: 'canonical', href: htsSeo.value.canonical_url }] : []
})));
</script>

<template>
  <span :data-hts-storyblok-source="story ? 'storyblok-draft' : 'generated-fallback'" :data-hts-storyblok-slug="HTS_STORYBLOK_STORY_SLUG" hidden></span>
  <ImportedRoute :story="story" :blok="story?.content || null" />
</template>
`;
}

function renderRouteSeoConstant(seo = {}) {
  return `const HTS_ROUTE_SEO = Object.freeze(${JSON.stringify(seo || {}, null, 2)});`;
}

function renderStoryblokContentHelpers(storyblokSlug, { clientGuard = false } = {}) {
  return `const HTS_STORYBLOK_CONTENT_BASE_URLS = Object.freeze(${JSON.stringify(STORYBLOK_CONTENT_BASE_URLS, null, 2)});
const HTS_STORYBLOK_STORY_SLUG = ${JSON.stringify(storyblokSlug)};

async function htsFetchStoryblokDraft() {
  ${clientGuard ? 'if (import.meta.client) return null;\n  ' : ''}const token = htsStoryblokContentToken();
  if (!token) return null;
  const env = htsStoryblokEnvironment();
  const region = String(env.STORYBLOK_REGION || 'eu').toLowerCase();
  const baseUrl = HTS_STORYBLOK_CONTENT_BASE_URLS[region] || HTS_STORYBLOK_CONTENT_BASE_URLS.eu;
  const url = new URL(\`\${baseUrl}/stories/\${HTS_STORYBLOK_STORY_SLUG}\`);
  url.searchParams.set('version', env.STORYBLOK_CONTENT_VERSION || 'draft');
  url.searchParams.set('token', token);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.story || null;
  } catch {
    return null;
  }
}

function htsStoryblokContentToken() {
  const env = htsStoryblokEnvironment();
  return env.STORYBLOK_PREVIEW_TOKEN || env.STORYBLOK_PUBLIC_TOKEN || env.STORYBLOK_DELIVERY_TOKEN || '';
}

function htsStoryblokEnvironment() {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

function htsResolveStoryblokSeo(story, fallback = {}) {
  const content = story?.content || {};
  return htsCompactSeo({
    title: content.seo_title || fallback.title || content.headline || '',
    description: content.seo_description || fallback.description || '',
    canonical_url: content.canonical_url || fallback.canonical_url || '',
    robots: content.robots || fallback.robots || '',
    og_title: content.og_title || fallback.og_title || content.seo_title || fallback.title || '',
    og_description: content.og_description || fallback.og_description || content.seo_description || fallback.description || '',
    og_image: content.og_image || fallback.og_image || '',
    og_type: content.og_type || fallback.og_type || '',
    twitter_card: content.twitter_card || fallback.twitter_card || '',
    twitter_title: content.twitter_title || fallback.twitter_title || content.seo_title || fallback.title || '',
    twitter_description: content.twitter_description || fallback.twitter_description || content.seo_description || fallback.description || '',
    twitter_image: content.twitter_image || fallback.twitter_image || ''
  });
}

function htsNextRouteMetadata(seo) {
  return {
    ...(seo.title ? { title: seo.title } : {}),
    ...(seo.description ? { description: seo.description } : {}),
    ...(seo.canonical_url ? { alternates: { canonical: seo.canonical_url } } : {}),
    ...(seo.robots ? { robots: seo.robots } : {}),
    ...(seo.og_title || seo.og_description || seo.og_image || seo.og_type ? {
      openGraph: {
        ...(seo.og_title ? { title: seo.og_title } : {}),
        ...(seo.og_description ? { description: seo.og_description } : {}),
        ...(seo.og_image ? { images: [seo.og_image] } : {}),
        ...(seo.og_type ? { type: seo.og_type } : {})
      }
    } : {}),
    ...(seo.twitter_card || seo.twitter_title || seo.twitter_description || seo.twitter_image ? {
      twitter: {
        ...(seo.twitter_card ? { card: seo.twitter_card } : {}),
        ...(seo.twitter_title ? { title: seo.twitter_title } : {}),
        ...(seo.twitter_description ? { description: seo.twitter_description } : {}),
        ...(seo.twitter_image ? { images: [seo.twitter_image] } : {})
      }
    } : {})
  };
}

function htsCompactSeo(value) {
  return Object.fromEntries(Object.entries(value || {})
    .filter(([, entry]) => entry !== null && entry !== undefined && String(entry).trim() !== '')
    .map(([key, entry]) => [key, String(entry)]));
}`;
}

function safeIdentifier(value) {
  const identifier = String(value || 'route').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return identifier || 'route';
}

function summarizeRouteHandoff(routes) {
  return routes.reduce((summary, entry) => {
    summary.routes += 1;
    if (entry.status === 'would_create') summary.would_create += 1;
    else if (entry.status === 'created') summary.created += 1;
    else if (entry.status === 'blocked') summary.blocked += 1;
    else if (entry.status === 'skipped') summary.skipped += 1;
    return summary;
  }, emptyRouteHandoffSummary());
}

function emptyRouteHandoffSummary() {
  return {
    routes: 0,
    would_create: 0,
    created: 0,
    blocked: 0,
    skipped: 0
  };
}
