import path from 'node:path';
import { inspectRepository } from './inspectors.js';
import { analyzeRouteCollisions } from './route-collision-analyzer.js';
import { ensureArray, pathExists, readJson } from './utils.js';

const AUTOMATIC_ROUTE_FRAMEWORKS = new Set(['astro', 'next', 'nuxt']);
const MANUAL_ROUTE_FRAMEWORKS = new Set(['react', 'vue', 'static']);
const REQUIRED_HOST_SCRIPTS = ['build'];
const RECOMMENDED_HOST_SCRIPTS = ['lint', 'typecheck'];
const STORYBLOK_RUNTIME_TOKEN_NAMES = [
  'STORYBLOK_PREVIEW_TOKEN',
  'STORYBLOK_PUBLIC_TOKEN',
  'STORYBLOK_DELIVERY_TOKEN'
];

export async function createPlatformReadiness(manifest, {
  repoPath = process.cwd(),
  route = null,
  requireAutomaticRoutes = false,
  adapterPlan = null
} = {}) {
  const root = path.resolve(repoPath);
  const checks = [];
  const repository = await safeInspectRepository(root);
  const adapterPlanPath = `${manifest.repository_namespace}/adapter-plan.json`;
  const adapterAbsolutePath = path.join(root, adapterPlanPath);
  const generatedAdapterPlan = adapterPlan || await readAdapterPlan(adapterAbsolutePath);
  const plannedFramework = normalizePlatformFramework(
    generatedAdapterPlan?.framework ||
    manifest.template?.framework ||
    repository.framework?.name ||
    'static'
  );
  const selectedRoutes = filterRoutes(ensureArray(generatedAdapterPlan?.routes), route);
  const routeCollisionAnalysis = generatedAdapterPlan
    ? await safeRouteCollisionAnalysis(manifest, { repoPath: root, adapterPlan: generatedAdapterPlan, route })
    : null;
  const routes = await Promise.all(selectedRoutes.map((entry) =>
    buildRouteEvidence(root, plannedFramework, entry, routeCollisionAnalysis)
  ));
  const hostScripts = summarizeHostScripts(repository);
  const manualHandoffRequired = !AUTOMATIC_ROUTE_FRAMEWORKS.has(plannedFramework);
  const missingRouteEvidence = routes.filter((entry) => !entry.preview_file_exists || !entry.route_proposal_file_exists);

  addCheck(
    checks,
    'repository_detected',
    repository.status === 'failed' ? 'failed' : 'passed',
    repository.status === 'failed'
      ? `Repository could not be inspected: ${repository.error}`
      : `Repository inspected as ${repository.framework?.name || 'unknown'} with ${repository.package_manager || 'unknown'} package manager.`,
    {
      repository_path: root,
      package_json_present: Boolean(repository.package_json_present)
    }
  );
  addCheck(
    checks,
    'adapter_plan_available',
    generatedAdapterPlan ? 'passed' : 'failed',
    generatedAdapterPlan
      ? `Generated adapter plan found at ${adapterPlanPath}.`
      : `Generated adapter plan not found at ${adapterPlanPath}. Run generate or apply before platform handoff review.`,
    {
      adapter_plan: adapterPlanPath
    }
  );
  addCheck(
    checks,
    'framework_handoff_mode',
    manualHandoffRequired ? (requireAutomaticRoutes ? 'failed' : 'warning') : 'passed',
    manualHandoffRequired
      ? `${plannedFramework} route registration is project-specific and requires manual host-router handoff.`
      : `${plannedFramework} supports additive automatic route file creation through wire-routes.`,
    {
      framework: plannedFramework,
      automatic_route_handoff_supported: AUTOMATIC_ROUTE_FRAMEWORKS.has(plannedFramework),
      manual_route_handoff_required: manualHandoffRequired
    }
  );
  addCheck(
    checks,
    'additive_route_policy',
    generatedAdapterPlan && generatedAdapterPlan.host_routes_modified === false && generatedAdapterPlan.host_registries_modified === false
      ? 'passed'
      : 'failed',
    generatedAdapterPlan && generatedAdapterPlan.host_routes_modified === false && generatedAdapterPlan.host_registries_modified === false
      ? 'Adapter plan preserves host routes and router registries.'
      : 'Adapter plan does not prove host routes and router registries are preserved.',
    {
      host_routes_modified: Boolean(generatedAdapterPlan?.host_routes_modified),
      host_registries_modified: Boolean(generatedAdapterPlan?.host_registries_modified)
    }
  );
  addCheck(
    checks,
    'route_proposal_evidence',
    routes.length === 0 || missingRouteEvidence.length > 0 ? 'failed' : 'passed',
    routes.length === 0
      ? 'No generated routes were available for platform handoff.'
      : missingRouteEvidence.length > 0
        ? `${missingRouteEvidence.length} route(s) are missing preview or route proposal files.`
        : 'Every generated route has a preview file and review-only route proposal wrapper.',
    {
      routes: routes.length,
      missing_preview_files: routes.filter((entry) => !entry.preview_file_exists).length,
      missing_route_proposal_files: routes.filter((entry) => !entry.route_proposal_file_exists).length
    }
  );
  addCheck(
    checks,
    'route_collision_status',
    routeCollisionStatus(routeCollisionAnalysis),
    routeCollisionMessage(routeCollisionAnalysis),
    routeCollisionDetails(routeCollisionAnalysis)
  );
  addCheck(
    checks,
    'host_script_readiness',
    hostScriptStatus(hostScripts),
    hostScriptMessage(hostScripts),
    hostScripts
  );
  addCheck(
    checks,
    'storyblok_content_api_runtime',
    'warning',
    'Runtime previews need one safe Storyblok Content API token variable in the deployed site; Management API tokens must never be exposed to the runtime.',
    {
      accepted_variable_names: STORYBLOK_RUNTIME_TOKEN_NAMES,
      detected_storyblok_sdk_packages: ensureArray(repository.storyblok_sdk).map((dependency) => dependency.name),
      detected_storyblok_variable_markers: ensureArray(repository.storyblok?.env_variable_names)
    }
  );

  const summary = summarizeReadiness(checks, routes, hostScripts);
  return {
    action: 'platform_readiness',
    status: summary.status,
    integration_id: manifest.integration_id,
    repository_path: root,
    repository_namespace: manifest.repository_namespace,
    adapter_plan_path: adapterPlanPath,
    framework: plannedFramework,
    framework_detected: repository.framework?.name || 'unknown',
    package_manager: repository.package_manager || 'unknown',
    automatic_route_handoff_supported: AUTOMATIC_ROUTE_FRAMEWORKS.has(plannedFramework),
    manual_route_handoff_required: manualHandoffRequired,
    additive_only: Boolean(generatedAdapterPlan?.additive_only),
    route_collision_analysis: routeCollisionAnalysis,
    checks,
    summary,
    routes,
    host_scripts: hostScripts,
    storyblok_runtime: {
      content_api_token_variables: STORYBLOK_RUNTIME_TOKEN_NAMES,
      management_token_runtime_allowed: false,
      note: 'Only Content API preview/delivery tokens belong in deployed preview/runtime environments.'
    },
    next_steps: nextSteps({
      status: summary.status,
      generatedAdapterPlan,
      manualHandoffRequired,
      plannedFramework,
      routeCollisionAnalysis,
      routes,
      hostScripts,
      manifest,
      root
    })
  };
}

export function renderPlatformReadinessMarkdown(result) {
  return `# Platform Readiness Report

Generated by HTML-to-Storyblok.

## Summary

- Status: ${result.status || 'recorded'}
- Integration: ${result.integration_id || 'unknown'}
- Repository: ${result.repository_path || 'unknown'}
- Namespace: ${result.repository_namespace || 'unknown'}
- Framework: ${result.framework || 'unknown'}
- Detected framework: ${result.framework_detected || 'unknown'}
- Package manager: ${result.package_manager || 'unknown'}
- Automatic route handoff supported: ${result.automatic_route_handoff_supported ? 'yes' : 'no'}
- Manual route handoff required: ${result.manual_route_handoff_required ? 'yes' : 'no'}
- Additive only: ${result.additive_only ? 'yes' : 'no'}

## Checks

${ensureArray(result.checks).map((check) => `- ${check.status}: ${check.name} - ${check.message}`).join('\n') || '- No checks recorded.'}

## Routes

${ensureArray(result.routes).map(renderRouteRow).join('\n') || '- No routes were checked.'}

## Host Scripts

${ensureArray(result.host_scripts).map((script) => `- ${script.script}: ${script.status}${script.command ? ` (\`${script.command}\`)` : ''}${script.reason ? ` - ${script.reason}` : ''}`).join('\n') || '- No scripts found.'}

## Storyblok Runtime

- Accepted Content API variables: ${STORYBLOK_RUNTIME_TOKEN_NAMES.map((name) => `\`${name}\``).join(', ')}
- Management token allowed at runtime: no
- Note: ${result.storyblok_runtime?.note || 'Content API token review required.'}

## Next Steps

${ensureArray(result.next_steps).map((step) => `- ${step}`).join('\n') || '- No next steps recorded.'}
`;
}

export function normalizePlatformFramework(framework) {
  const value = String(framework || '').toLowerCase();
  if (value.includes('astro')) return 'astro';
  if (value.includes('next')) return 'next';
  if (value.includes('nuxt')) return 'nuxt';
  if (value.includes('vue')) return 'vue';
  if (value.includes('react')) return 'react';
  if (value.includes('vite')) return 'static';
  return MANUAL_ROUTE_FRAMEWORKS.has(value) ? value : 'static';
}

async function safeInspectRepository(root) {
  try {
    return await inspectRepository(root);
  } catch (error) {
    return {
      action: 'inspect_repository',
      status: 'failed',
      repository_path: root,
      error: error.message || String(error),
      framework: { name: 'unknown' },
      package_manager: 'unknown',
      scripts: {},
      storyblok_sdk: [],
      storyblok: {
        env_variable_names: []
      }
    };
  }
}

async function readAdapterPlan(filePath) {
  try {
    if (!(await pathExists(filePath))) return null;
    return await readJson(filePath);
  } catch {
    return null;
  }
}

async function safeRouteCollisionAnalysis(manifest, { repoPath, adapterPlan, route }) {
  try {
    return await analyzeRouteCollisions(manifest, { repoPath, adapterPlan, route });
  } catch (error) {
    return {
      action: 'analyze_route_collisions',
      status: 'failed',
      error: error.message || String(error),
      routes: [],
      summary: {
        routes: 0,
        blocked: 0,
        warnings: 0
      }
    };
  }
}

async function buildRouteEvidence(root, framework, route, routeCollisionAnalysis) {
  const collision = ensureArray(routeCollisionAnalysis?.routes).find((entry) => entry.slug === route.slug) || null;
  const previewFile = route.preview_file || null;
  const routeProposalFile = route.route_proposal_file || route.proposal_file || null;
  return {
    slug: route.slug,
    suggested_site_path: route.suggested_site_path,
    storyblok_slug: route.storyblok_slug,
    preview_file: previewFile,
    preview_file_exists: previewFile ? await pathExists(path.join(root, previewFile)) : false,
    route_proposal_file: routeProposalFile,
    route_proposal_file_exists: routeProposalFile ? await pathExists(path.join(root, routeProposalFile)) : false,
    suggested_host_files: ensureArray(route.suggested_host_files),
    handoff_mode: AUTOMATIC_ROUTE_FRAMEWORKS.has(framework) ? 'automatic_route_file' : 'manual_host_router',
    route_collision_status: collision?.status || routeCollisionAnalysis?.status || 'not_run',
    route_collision_blockers: ensureArray(collision?.blockers),
    route_collision_warnings: ensureArray(collision?.warnings),
    next_step: AUTOMATIC_ROUTE_FRAMEWORKS.has(framework)
      ? 'Run wire-routes --dry-run, review the route proposal, then wire only missing host route files.'
      : 'Use the route proposal wrapper from the host router entry that matches this project.'
  };
}

function filterRoutes(routes, requestedRoute) {
  if (!requestedRoute) return routes;
  const normalized = normalizeRouteSelector(requestedRoute);
  return routes.filter((route) =>
    normalizeRouteSelector(route.slug) === normalized ||
    normalizeRouteSelector(route.suggested_site_path) === normalized ||
    normalizeRouteSelector(route.storyblok_slug) === normalized
  );
}

function normalizeRouteSelector(value) {
  const text = String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!text || text === 'index') return 'home';
  return text;
}

function summarizeHostScripts(repository) {
  const scripts = repository.scripts || {};
  return [...REQUIRED_HOST_SCRIPTS, ...RECOMMENDED_HOST_SCRIPTS].map((script) => ({
    script,
    required: REQUIRED_HOST_SCRIPTS.includes(script),
    status: scripts[script] ? 'available' : REQUIRED_HOST_SCRIPTS.includes(script) ? 'missing' : 'recommended_missing',
    command: scripts[script] ? `${repository.package_manager || 'npm'} run ${script}` : null,
    reason: scripts[script]
      ? null
      : REQUIRED_HOST_SCRIPTS.includes(script)
        ? 'Required before client handoff.'
        : 'Recommended before client handoff when the host project supports it.'
  }));
}

function hostScriptStatus(hostScripts) {
  if (hostScripts.some((script) => script.required && script.status === 'missing')) return 'warning';
  if (hostScripts.some((script) => script.status === 'recommended_missing')) return 'warning';
  return 'passed';
}

function hostScriptMessage(hostScripts) {
  const missingRequired = hostScripts.filter((script) => script.required && script.status === 'missing');
  const missingRecommended = hostScripts.filter((script) => script.status === 'recommended_missing');
  if (missingRequired.length > 0) return `${missingRequired.map((script) => script.script).join(', ')} script(s) were not detected; run equivalent checks manually.`;
  if (missingRecommended.length > 0) return `${missingRecommended.map((script) => script.script).join(', ')} script(s) were not detected; record equivalent client checks before handoff.`;
  return 'Standard host check scripts are available.';
}

function routeCollisionStatus(routeCollisionAnalysis) {
  if (!routeCollisionAnalysis) return 'skipped';
  if (routeCollisionAnalysis.status === 'blocked' || routeCollisionAnalysis.status === 'failed') return 'failed';
  if (routeCollisionAnalysis.status === 'warning') return 'warning';
  return 'passed';
}

function routeCollisionMessage(routeCollisionAnalysis) {
  if (!routeCollisionAnalysis) return 'Route collision analysis was skipped because no adapter plan was available.';
  if (routeCollisionAnalysis.status === 'blocked') return 'Route collision analysis found blockers before routes can be wired.';
  if (routeCollisionAnalysis.status === 'failed') return `Route collision analysis failed: ${routeCollisionAnalysis.error || 'unknown error'}`;
  if (routeCollisionAnalysis.status === 'warning') return 'Route collision analysis found warnings that need review before deployment.';
  return 'Route collision analysis passed.';
}

function routeCollisionDetails(routeCollisionAnalysis) {
  if (!routeCollisionAnalysis) return {};
  return {
    status: routeCollisionAnalysis.status,
    routes: routeCollisionAnalysis.summary?.routes || ensureArray(routeCollisionAnalysis.routes).length,
    blocked: routeCollisionAnalysis.summary?.blocked || 0,
    warnings: routeCollisionAnalysis.summary?.warnings || 0
  };
}

function addCheck(checks, name, status, message, details = {}) {
  checks.push({ name, status, message, details });
}

function summarizeReadiness(checks, routes, hostScripts) {
  const failed = checks.filter((check) => check.status === 'failed').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return {
    status: failed > 0 ? 'blocked' : warnings > 0 ? 'warning' : 'passed',
    checks: checks.length,
    failed_checks: failed,
    warning_checks: warnings,
    routes: routes.length,
    route_previews_available: routes.filter((route) => route.preview_file_exists).length,
    route_proposals_available: routes.filter((route) => route.route_proposal_file_exists).length,
    blocked_routes: routes.filter((route) => route.route_collision_status === 'blocked').length,
    warning_routes: routes.filter((route) => route.route_collision_status === 'warning').length,
    host_scripts_available: hostScripts.filter((script) => script.status === 'available').length,
    host_scripts_missing: hostScripts.filter((script) => script.status !== 'available').length
  };
}

function nextSteps({ status, generatedAdapterPlan, manualHandoffRequired, plannedFramework, routeCollisionAnalysis, routes, hostScripts, manifest, root }) {
  const steps = [];
  const manifestPath = '.tmp/html-to-storyblok/integration-manifest.json';
  if (!generatedAdapterPlan) {
    steps.push(`Run html-to-storyblok generate --manifest ${manifestPath} --repo ${root} --template ${manifest.template?.source_path || '<template-path>'} --framework ${plannedFramework}.`);
    return steps;
  }
  if (routeCollisionAnalysis?.status === 'blocked' || routeCollisionAnalysis?.status === 'failed') {
    steps.push(`Run html-to-storyblok route-collisions --manifest ${manifestPath} --repo ${root} and resolve blockers before wire-routes.`);
  }
  if (routes.some((route) => !route.preview_file_exists || !route.route_proposal_file_exists)) {
    steps.push('Regenerate the integration so every route has a preview and route proposal wrapper.');
  }
  if (manualHandoffRequired) {
    steps.push(`Review ${generatedAdapterPlan.route_proposals?.readme_file || `${manifest.repository_namespace}/route-proposals/README.md`} and register route proposals through the host ${plannedFramework} router manually.`);
  } else if (status !== 'blocked') {
    steps.push(`Run html-to-storyblok wire-routes --manifest ${manifestPath} --repo ${root} --dry-run.`);
  }
  if (hostScripts.some((script) => script.status !== 'available')) {
    steps.push('Run equivalent host lint/typecheck/build checks manually and attach evidence to the handoff report.');
  } else {
    steps.push('Run the target repository lint, typecheck, and build scripts before exposing imported routes.');
  }
  steps.push('Configure a Storyblok Content API preview/delivery token in the deployed site runtime, never a Management API token.');
  return steps;
}

function renderRouteRow(route) {
  return [
    `- ${route.suggested_site_path || route.slug}: ${route.handoff_mode}`,
    `  - Storyblok slug: \`${route.storyblok_slug || 'unknown'}\``,
    `  - Preview file: ${route.preview_file_exists ? 'yes' : 'no'}${route.preview_file ? ` (\`${route.preview_file}\`)` : ''}`,
    `  - Route proposal: ${route.route_proposal_file_exists ? 'yes' : 'no'}${route.route_proposal_file ? ` (\`${route.route_proposal_file}\`)` : ''}`,
    `  - Suggested host files: ${route.suggested_host_files?.length ? route.suggested_host_files.map((file) => `\`${file}\``).join(', ') : 'none'}`,
    `  - Collision status: ${route.route_collision_status || 'not_run'}`,
    `  - Next: ${route.next_step}`
  ].join('\n');
}
