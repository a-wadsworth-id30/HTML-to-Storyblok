import path from 'node:path';
import { DEFAULT_WORK_DIR } from './evidence.js';
import { ensureArray } from './utils.js';

export function createNextActionModel({
  manifest = null,
  result = null,
  report = null,
  workDir = report?.work_dir || DEFAULT_WORK_DIR,
  repoPath = null,
  repositorySkipped = false
} = {}) {
  const context = createContext({ manifest, result, report, workDir, repoPath, repositorySkipped });
  const actions = [
    actionForFailedState(context),
    actionForInvalidPlan(context),
    actionForDryRun(context),
    actionForUnresolvedLinks(context),
    actionForAssetIntegrity(context),
    actionForAssetReferenceGraph(context),
    actionForPlatformReadiness(context),
    actionForRouteCollision(context),
    actionForRouteChecklist(context),
    actionForRouteHandoff(context),
    actionForStoryblokManagement(context),
    actionForStoryblokContent(context),
    actionForLocalValidation(context),
    actionForHandoffPack(context)
  ].filter(Boolean);
  const uniqueActions = dedupeActions(actions)
    .sort((left, right) => priorityOrder(left.priority) - priorityOrder(right.priority));
  if (uniqueActions.length === 0) {
    uniqueActions.push({
      id: 'review-report',
      label: 'Review Evidence',
      reason: 'No blocking next action was detected. Review the latest report before handoff.',
      command: `html-to-storyblok view-report --work-dir ${workDir}`,
      menu_action: 'report',
      priority: 'low',
      status: 'available'
    });
  }
  return {
    action: 'next_actions',
    status: uniqueActions.some((entry) => entry.priority === 'critical') ? 'attention' : 'ready',
    primary: uniqueActions[0],
    actions: uniqueActions
  };
}

function createContext({ manifest, result, report, workDir, repoPath, repositorySkipped }) {
  const applyResult = result?.result || result?.dry_run || result;
  const latestApply = latestApplyArtifact(report) || applyResult;
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  const resolvedRepoPath = repoPath || result?.repo_path || latestApply?.repo_path || null;
  return {
    manifest,
    result,
    report,
    workDir,
    manifestPath,
    repoPath: resolvedRepoPath,
    repositorySkipped: Boolean(repositorySkipped || result?.repository_skipped || result?.action === 'storyblok_only_integration'),
    latestApply,
    summary: summarizeApply(latestApply),
    routeHandoff: report?.latest_route_handoff || null,
    validation: result?.validation || report?.latest_validation || null,
    localValidation: result?.local_validation || latestArtifact(report, ['integration_validation']) || null,
    storyblokValidation: report?.latest_storyblok_validation || latestArtifact(report, ['storyblok_content_validation']) || null,
    storyblokManagement: report?.latest_storyblok_management_verification || latestArtifact(report, ['storyblok_management_verification']) || null,
    assetIntegrity: report?.asset_integrity || null,
    assetReferenceGraph: report?.asset_reference_graph || null,
    platformReadiness: report?.latest_platform_readiness || latestArtifact(report, ['platform_readiness']) || null,
    routeChecklist: report?.latest_route_handoff_checklist || latestArtifact(report, ['route_handoff_checklist']) || null,
    routeCollision: report?.latest_route_collision_analysis || latestArtifact(report, ['route_collision_analysis']) || null,
    commandsFailed: ensureArray(report?.commands_failed),
    artifacts: ensureArray(report?.artifacts)
  };
}

function actionForFailedState(context) {
  const failedStep = ensureArray(context.latestApply?.steps).find((step) => step.status === 'failed');
  const failedCommand = context.commandsFailed.at(-1);
  if (!failedStep && !failedCommand && !['failed', 'blocked'].includes(context.result?.status)) return null;
  return {
    id: 'recover-failure',
    label: 'Open Recovery Options',
    reason: failedStep?.message || failedCommand?.message || 'The last action needs attention before continuing.',
    command: `html-to-storyblok view-report --work-dir ${context.workDir}`,
    menu_action: 'report',
    priority: 'critical',
    status: 'needs_attention'
  };
}

function actionForInvalidPlan(context) {
  if (!context.validation) return null;
  const valid = context.validation.valid ?? context.validation.status === 'passed';
  if (valid !== false) return null;
  const violationCount = Array.isArray(context.validation.violations)
    ? context.validation.violations.length
    : context.validation.violation_count || context.validation.violations || 'One or more';
  return {
    id: 'fix-plan-validation',
    label: 'Fix Plan Validation',
    reason: `${violationCount} additive-only validation issue(s) must be resolved before apply.`,
    command: `html-to-storyblok validate-plan --manifest ${context.manifestPath}`,
    menu_action: 'validate',
    priority: 'critical',
    status: 'blocked'
  };
}

function actionForDryRun(context) {
  const status = context.result?.status || context.latestApply?.status;
  if (status !== 'dry_run_complete' && context.latestApply?.dry_run !== true) return null;
  const command = context.repositorySkipped
    ? `html-to-storyblok storyblok-apply --manifest ${context.manifestPath}`
    : `html-to-storyblok apply --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'}`;
  return {
    id: context.repositorySkipped ? 'run-real-storyblok-apply' : 'run-real-apply',
    label: context.repositorySkipped ? 'Run Real Storyblok Apply' : 'Run Real Apply',
    reason: 'The dry run completed. Confirm the target and run the real apply when the preview diff is approved.',
    command,
    menu_action: 'home',
    priority: 'high',
    status: 'ready'
  };
}

function actionForUnresolvedLinks(context) {
  if (!context.summary.unresolved_story_links) return null;
  return {
    id: 'review-story-links',
    label: 'Review Story Links',
    reason: `${context.summary.unresolved_story_links} generated Storyblok story link(s) are unresolved.`,
    command: 'html-to-storyblok # Continue Existing Integration -> Review/Edit Story Links',
    menu_action: 'home',
    priority: 'high',
    status: 'needs_review'
  };
}

function actionForAssetIntegrity(context) {
  const assets = context.assetIntegrity;
  if (!assets) return null;
  if (assets.status === 'passed' || assets.status === 'pending') return null;
  const missingSources = assets.local_sources_missing ?? assets.missing_sources ?? 0;
  return {
    id: 'review-assets',
    label: 'Review Asset Integrity',
    reason: `${missingSources} missing source(s), ${assets.unresolved_asset_fields || 0} unresolved asset field(s).`,
    command: `html-to-storyblok asset-dashboard --work-dir ${context.workDir}`,
    menu_action: 'report',
    priority: assets.status === 'failed' ? 'critical' : 'high',
    status: assets.status || 'needs_review'
  };
}

function actionForAssetReferenceGraph(context) {
  const graph = context.assetReferenceGraph;
  if (!graph) return null;
  if (graph.status === 'passed' || graph.status === 'pending') return null;
  const summary = graph.summary || {};
  return {
    id: 'review-asset-graph',
    label: 'Review Asset Reference Graph',
    reason: `${summary.unresolved_story_asset_fields || 0} story asset field(s), ${summary.remote_unresolved_asset_fields || 0} remote draft asset field(s), and ${summary.ambiguous_story_asset_fields || 0} ambiguous reference(s) need review.`,
    command: `html-to-storyblok asset-graph --work-dir ${context.workDir}`,
    menu_action: 'report',
    priority: graph.status === 'failed' ? 'critical' : 'high',
    status: graph.status || 'needs_review'
  };
}

function actionForRouteCollision(context) {
  if (context.repositorySkipped) return null;
  const collision = context.routeCollision;
  if (!collision || !['blocked', 'warning'].includes(collision.status)) return null;
  const command = `html-to-storyblok route-collisions --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'}`;
  if (collision.status === 'blocked') {
    return {
      id: 'resolve-route-collisions',
      label: 'Resolve Route Collisions',
      reason: `${collision.blocked || collision.summary?.blocked || 0} imported route(s) are blocked by existing route files, dynamic route overlaps, duplicate paths, or unsafe targets.`,
      command,
      menu_action: 'report',
      priority: 'critical',
      status: 'blocked'
    };
  }
  return {
    id: 'review-route-rewrites',
    label: 'Review Route Rewrite Warnings',
    reason: `${collision.warnings || collision.summary?.warnings || 0} route warning(s) may affect deployed previews, usually Netlify redirects or rewrites.`,
    command,
    menu_action: 'report',
    priority: 'high',
    status: 'needs_review'
  };
}

function actionForRouteChecklist(context) {
  if (context.repositorySkipped) return null;
  if (!hasRoutePreviews(context)) return null;
  if (context.routeCollision?.status === 'blocked') return null;
  const command = `html-to-storyblok route-checklist --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'}`;
  const checklist = context.routeChecklist;
  if (!checklist) {
    return {
      id: 'route-checklist',
      label: 'Create Route Handoff Checklist',
      reason: 'Generated route previews are available; create a per-route checklist before wiring or manually registering routes.',
      command,
      menu_action: 'report',
      priority: 'medium',
      status: 'available'
    };
  }
  if (checklist.status === 'blocked') {
    return {
      id: 'resolve-route-checklist',
      label: 'Resolve Route Checklist Blockers',
      reason: `${checklist.blocked_routes || 1} route handoff checklist route(s) are blocked.`,
      command,
      menu_action: 'report',
      priority: 'critical',
      status: 'blocked'
    };
  }
  if (checklist.status === 'manual_required') {
    return {
      id: 'review-route-checklist',
      label: 'Review Manual Route Checklist',
      reason: `${checklist.manual_routes || 1} route(s) require manual host-router handoff evidence.`,
      command,
      menu_action: 'report',
      priority: 'medium',
      status: 'needs_review'
    };
  }
  return null;
}

function actionForPlatformReadiness(context) {
  if (context.repositorySkipped) return null;
  if (!hasRoutePreviews(context)) return null;
  const command = `html-to-storyblok platform-readiness --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'}`;
  const readiness = context.platformReadiness;
  if (!readiness) {
    return {
      id: 'platform-readiness',
      label: 'Check Platform Readiness',
      reason: 'Generated route previews are available; confirm framework handoff mode, adapter evidence, route proposals, and host checks before wiring routes.',
      command,
      menu_action: 'report',
      priority: 'medium',
      status: 'available'
    };
  }
  if (['blocked', 'failed'].includes(readiness.status)) {
    return {
      id: 'resolve-platform-readiness',
      label: 'Resolve Platform Readiness',
      reason: `${readiness.failed_checks || 1} platform readiness check(s) block route exposure.`,
      command,
      menu_action: 'report',
      priority: 'critical',
      status: 'blocked'
    };
  }
  if (readiness.manual_route_handoff_required) {
    return {
      id: 'review-platform-manual-handoff',
      label: 'Review Manual Platform Handoff',
      reason: `${readiness.framework || 'This framework'} requires host-router registration outside automatic wire-routes.`,
      command,
      menu_action: 'report',
      priority: 'medium',
      status: 'needs_review'
    };
  }
  return null;
}

function actionForRouteHandoff(context) {
  if (context.repositorySkipped) return null;
  if (context.routeCollision?.status === 'blocked') return null;
  if (context.routeHandoff && !['skipped', 'blocked'].includes(context.routeHandoff.status)) return null;
  if (!hasRoutePreviews(context)) return null;
  return {
    id: 'wire-routes',
    label: 'Review Route Handoff',
    reason: `${context.summary.route_previews || 'Generated'} route preview(s) are available and host routes still need explicit review.`,
    command: `html-to-storyblok wire-routes --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'} --dry-run`,
    menu_action: 'home',
    priority: 'medium',
    status: 'available'
  };
}

function hasRoutePreviews(context) {
  return Boolean(context.summary.route_previews || context.manifest?.repository?.route_previews);
}

function actionForStoryblokManagement(context) {
  if (context.storyblokManagement?.status === 'passed' || context.latestApply?.dry_run) return null;
  const completed = context.result?.status === 'complete' || context.latestApply?.status === 'complete';
  if (!completed) return null;
  return {
    id: 'verify-storyblok-management',
    label: 'Verify Storyblok Management State',
    reason: 'Run post-apply Management API verification to confirm components, assets, links, and draft stories match the manifest.',
    command: `html-to-storyblok storyblok-verify --manifest ${context.manifestPath}`,
    menu_action: 'report',
    priority: 'medium',
    status: 'recommended'
  };
}

function actionForStoryblokContent(context) {
  if (context.storyblokValidation?.status === 'passed' || context.latestApply?.dry_run) return null;
  const completed = context.result?.status === 'complete' || context.latestApply?.status === 'complete';
  if (!completed) return null;
  return {
    id: 'validate-storyblok-content',
    label: 'Validate Storyblok Draft Content',
    reason: 'Use the Content API preview token to verify imported draft stories render as expected.',
    command: `html-to-storyblok validate-storyblok --manifest ${context.manifestPath}`,
    menu_action: 'report',
    priority: 'medium',
    status: 'recommended'
  };
}

function actionForLocalValidation(context) {
  if (context.repositorySkipped || context.localValidation?.status === 'passed' || context.latestApply?.dry_run) return null;
  const completed = context.result?.status === 'complete' || context.latestApply?.status === 'complete';
  if (!completed) return null;
  return {
    id: 'validate-local-output',
    label: 'Validate Local Output',
    reason: 'Generated repository output should pass local validation before handoff.',
    command: `html-to-storyblok validate --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ' --repo <repo-path>'}`,
    menu_action: 'validate',
    priority: 'medium',
    status: 'recommended'
  };
}

function actionForHandoffPack(context) {
  if (context.artifacts.some((artifact) => artifact.type === 'production_handoff_pack' || /production-handoff-pack/.test(artifact.artifact || ''))) return null;
  const completed = ['complete', 'dry_run_complete'].includes(context.result?.status) || context.latestApply;
  if (!completed) return null;
  return {
    id: 'create-handoff-pack',
    label: 'Create Handoff Pack',
    reason: 'Package the report, readiness, Storyblok links, rollback scope, and next actions for review.',
    command: `html-to-storyblok handoff-pack --manifest ${context.manifestPath}${context.repoPath ? ` --repo ${context.repoPath}` : ''}`,
    menu_action: 'home',
    priority: 'low',
    status: 'available'
  };
}

function summarizeApply(result) {
  const steps = ensureArray(result?.steps);
  const flatResults = steps.flatMap((step) => ensureArray(step?.results));
  const linkSummary = result?.link_summary || flatResults.reduce((summary, entry) => ({
    total_links: summary.total_links + Number(entry?.link_summary?.total_links || 0),
    story_links: summary.story_links + Number(entry?.link_summary?.story_links || 0),
    resolved_story_links: summary.resolved_story_links + Number(entry?.link_summary?.resolved_story_links || 0),
    unresolved_story_links: summary.unresolved_story_links + Number(entry?.link_summary?.unresolved_story_links || 0)
  }), {
    total_links: 0,
    story_links: 0,
    resolved_story_links: 0,
    unresolved_story_links: 0
  });
  return {
    ...linkSummary,
    route_previews: Number(result?.route_previews || 0) || steps.flatMap((step) => ensureArray(step?.route_previews)).length
  };
}

function latestApplyArtifact(report) {
  return [...ensureArray(report?.artifacts)].reverse().find((artifact) => ['apply_result', 'storyblok_apply_result'].includes(artifact.type)) || null;
}

function latestArtifact(report, types) {
  return [...ensureArray(report?.artifacts)].reverse().find((artifact) => types.includes(artifact.type)) || null;
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

function priorityOrder(priority) {
  return {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3
  }[priority] ?? 4;
}
