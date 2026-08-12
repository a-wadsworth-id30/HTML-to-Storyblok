import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureArray, pathExists, readJson, writeText } from './utils.js';

const SUPPORTED_FRAMEWORKS = new Set(['astro', 'next', 'nuxt']);

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
    route_proposal_file: proposalFile || null,
    host_route_file: hostRouteFile || null,
    registration_policy: 'manual_review_required',
    host_routes_modified: false
  };

  if (!SUPPORTED_FRAMEWORKS.has(plan.framework)) {
    return {
      ...base,
      status: 'skipped',
      reason: `Automatic route handoff is not supported for ${plan.framework}. Review the route proposal manually.`
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
  return {
    action: 'wire_repository_routes',
    status,
    dry_run: dryRun,
    policy: 'additive-only-route-handoff',
    host_routes_modified: false,
    host_route_files_created: dryRun ? 0 : routes.filter((entry) => entry.status === 'created').length,
    reason,
    routes,
    summary: summarizeRouteHandoff(routes)
  };
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

const story = Astro.props.story || null;
const blok = Astro.props.blok || story?.content || {};
---

<ImportedRoute story={story} blok={blok} />
`;
}

function renderNextHostRoute(plan, entry) {
  return `// ${routeHeader(plan, entry).replaceAll('\n', '\n// ')}
import ImportedRoute from '${entry.import_path}';

export default function HtsImportedRoutePage() {
  return <ImportedRoute />;
}
`;
}

function renderNuxtHostRoute(plan, entry) {
  return `<script setup>
// ${routeHeader(plan, entry).replaceAll('\n', '\n// ')}
import ImportedRoute from '${entry.import_path}';
</script>

<template>
  <ImportedRoute />
</template>
`;
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
