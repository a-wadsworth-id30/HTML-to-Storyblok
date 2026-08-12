import path from 'node:path';
import { DEFAULT_WORK_DIR, writeArtifact, writeTextArtifact } from './evidence.js';
import { readIntegrationHistory } from './history.js';
import { createReadinessHandoff } from './readiness.js';
import { createReport } from './reporter.js';
import { createRollbackPreview } from './rollback.js';
import { ensureArray, pathExists, readJson } from './utils.js';

export async function createProductionHandoffPack({
  manifest,
  repoPath = null,
  templatePath = null,
  workDir = DEFAULT_WORK_DIR,
  cwd = process.cwd(),
  env = process.env,
  remote = false,
  requireStoryblok = false,
  requireRepository = false,
  skipReadiness = false
} = {}) {
  if (!manifest) throw new Error('handoff-pack requires a manifest');
  const resolvedRepoPath = repoPath ? path.resolve(cwd, repoPath) : null;
  const resolvedTemplatePath = templatePath || manifest.template?.source_path || null;
  const readiness = skipReadiness
    ? await readOptionalJson(path.join(workDir, 'readiness-result.json'))
    : await createReadinessHandoff({
      manifest,
      repoPath: resolvedRepoPath,
      templatePath: resolvedTemplatePath,
      workDir,
      env,
      remote,
      requireStoryblok,
      requireRepository
    });
  if (readiness && !skipReadiness) {
    await writeArtifact(workDir, 'readiness-result.json', readiness);
  }
  const report = await createReport(workDir);
  const history = await readIntegrationHistory(workDir, { limit: 5 });
  const artifacts = await readHandoffArtifacts(workDir);
  const latestApply = artifacts.apply_result || artifacts.storyblok_apply_result;
  const rollbackPreview = artifacts.rollback_preview || createRollbackPreview(manifest, {
    repoPath: resolvedRepoPath || cwd
  });
  const pack = {
    action: 'production_handoff_pack',
    status: handoffStatus({ readiness, report, latestApply }),
    generated_at: new Date().toISOString(),
    integration_id: manifest.integration_id,
    storyblok_prefix: manifest.storyblok_prefix,
    repository_namespace: manifest.repository_namespace,
    repository_path: resolvedRepoPath,
    template_path: resolvedTemplatePath,
    summary: buildSummary({ manifest, readiness, report, latestApply }),
    readiness: summarizeReadiness(readiness),
    storyblok: buildStoryblokHandoff({ manifest, latestApply, artifacts, report }),
    repository: buildRepositoryHandoff({ manifest, latestApply, artifacts }),
    assets: buildAssetHandoff(report),
    validation: buildValidationHandoff({ report, artifacts }),
    rollback: buildRollbackHandoff({ manifest, rollbackPreview, repoPath: resolvedRepoPath, workDir }),
    review_links: buildReviewLinks({ latestApply, artifacts, report, workDir }),
    evidence: buildEvidence({ report, history, readiness, artifacts, workDir }),
    sign_off_checklist: buildSignOffChecklist({ readiness, report, latestApply, artifacts }),
    next_actions: buildNextActions({ readiness, report, latestApply, artifacts })
  };
  pack.markdown_report = path.join(workDir, 'production-handoff-pack.md');
  pack.json_report = path.join(workDir, 'production-handoff-pack.json');
  await writeTextArtifact(workDir, 'production-handoff-pack.md', renderProductionHandoffMarkdown(pack));
  await writeArtifact(workDir, 'production-handoff-pack.json', pack);
  return pack;
}

export function renderProductionHandoffMarkdown(pack) {
  return `# HTML-to-Storyblok Production Handoff Pack

## Overview

- Integration: ${pack.integration_id || 'unknown'}
- Status: ${pack.status}
- Generated: ${pack.generated_at}
- Repository: ${pack.repository_path || 'not supplied'}
- Template: ${pack.template_path || 'not supplied'}
- Storyblok prefix: ${pack.storyblok_prefix || 'unknown'}
- Repository namespace: ${pack.repository_namespace || 'unknown'}

## Executive Summary

- Planned repository files: ${pack.summary.repository_files}
- Planned Storyblok components: ${pack.summary.storyblok_components}
- Planned Storyblok presets: ${pack.summary.storyblok_presets}
- Planned draft stories: ${pack.summary.draft_stories}
- Planned Storyblok assets: ${pack.summary.storyblok_assets}
- Latest readiness: ${pack.summary.readiness_status}
- Latest validation: ${pack.summary.plan_validation}
- Latest Storyblok management verification: ${pack.summary.storyblok_management_verification}
- Asset integrity: ${pack.summary.asset_integrity}

## Storyblok Review

${renderStoryblokMarkdown(pack.storyblok)}

## Repository Review

${renderRepositoryMarkdown(pack.repository)}

## Validation And Evidence

${renderValidationMarkdown(pack.validation)}

## Assets

- Status: ${pack.assets.status}
- Planned Storyblok assets: ${pack.assets.planned_storyblok_assets}
- Uploaded or reused: ${pack.assets.uploaded_or_reused}
- Missing local sources: ${pack.assets.missing_sources}
- Unresolved draft asset fields: ${pack.assets.unresolved_asset_fields}

## Rollback Scope

- Preview command: \`${pack.rollback.preview_command}\`
- Local files in scope: ${pack.rollback.local_targets}
- Storyblok components in scope: ${pack.rollback.storyblok_components}
- Draft stories in scope: ${pack.rollback.storyblok_stories}
- Remote rollback requires explicit confirmation: ${pack.rollback.remote_requires_confirmation ? 'yes' : 'no'}

## Review Links

${renderReviewLinksMarkdown(pack.review_links)}

## Sign-Off Checklist

${pack.sign_off_checklist.map((item) => `- [${item.status === 'done' ? 'x' : ' '}] ${item.label}: ${item.detail}`).join('\n')}

## Next Actions

${pack.next_actions.map((action) => `- ${action}`).join('\n')}

## Evidence Files

${pack.evidence.key_artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`).join('\n') || '- No evidence artifacts recorded.'}
`;
}

function buildSummary({ manifest, readiness, report, latestApply }) {
  return {
    repository_files: count(manifest.repository?.files_to_create),
    storyblok_component_groups: count(manifest.storyblok?.component_groups_to_create),
    storyblok_components: count(manifest.storyblok?.components_to_create),
    storyblok_presets: count(manifest.storyblok?.presets_to_create),
    draft_stories: count(manifest.storyblok?.stories_to_create),
    storyblok_assets: count(manifest.storyblok?.assets_to_upload || manifest.storyblok?.assets_to_create),
    latest_apply: latestApply?.status || 'not_run',
    latest_apply_dry_run: latestApply ? Boolean(latestApply.dry_run) : null,
    readiness_status: readiness?.status || 'not_run',
    plan_validation: report.latest_validation?.status || (report.latest_validation?.valid ? 'passed' : 'not_run'),
    storyblok_content_validation: report.latest_storyblok_validation?.status || 'not_run',
    storyblok_management_verification: report.latest_storyblok_management_verification?.status || 'not_run',
    route_handoff: report.latest_route_handoff?.status || 'not_run',
    template_quality: report.latest_template_quality?.grade
      ? `${report.latest_template_quality.grade} (${report.latest_template_quality.score}/100)`
      : 'not_run',
    asset_integrity: report.asset_integrity?.status || 'not_run',
    unresolved_failures: report.safety_confirmation?.unresolved_failures || 0
  };
}

function summarizeReadiness(readiness) {
  if (!readiness) {
    return {
      status: 'not_run',
      summary: { total: 0, passed: 0, warnings: 0, failed: 0 },
      report: null,
      sections: []
    };
  }
  return {
    status: readiness.status,
    summary: readiness.summary,
    report: readiness.markdown_report || null,
    sections: ensureArray(readiness.sections).map((section) => ({
      name: section.name,
      status: section.status,
      summary: section.summary,
      artifact: section.artifact || null
    }))
  };
}

function buildStoryblokHandoff({ manifest, latestApply, artifacts, report }) {
  const draftLinks = collectDraftEditorLinks(latestApply);
  const verification = artifacts.storyblok_management_verification || report.latest_storyblok_management_verification || null;
  const contentValidation = artifacts.storyblok_content_validation || report.latest_storyblok_validation || null;
  return {
    folder: manifest.storyblok?.story_folder || manifest.integration_id,
    component_groups: count(manifest.storyblok?.component_groups_to_create),
    internal_tags: count(manifest.storyblok?.internal_tags_to_create),
    components: count(manifest.storyblok?.components_to_create),
    presets: count(manifest.storyblok?.presets_to_create),
    draft_stories: count(manifest.storyblok?.stories_to_create),
    assets: count(manifest.storyblok?.assets_to_upload || manifest.storyblok?.assets_to_create),
    draft_editor_links: draftLinks,
    story_slugs: ensureArray(manifest.storyblok?.stories_to_create).map((story) => story.slug).filter(Boolean),
    content_validation: contentValidation
      ? {
        status: contentValidation.status,
        stories: contentValidation.summary?.stories || contentValidation.stories || 0,
        failed: contentValidation.summary?.failed || contentValidation.failed_stories || 0,
        unresolved_generated_story_links: contentValidation.summary?.unresolved_generated_story_links || contentValidation.unresolved_generated_story_links || 0
      }
      : null,
    management_verification: verification
      ? {
        status: verification.status,
        resources: verification.summary?.resources || verification.resources || 0,
        failed_story_checks: verification.summary?.failed_story_checks || verification.failed_story_checks || 0,
        unresolved_generated_story_links: verification.summary?.unresolved_generated_story_links || verification.unresolved_generated_story_links || 0,
        unresolved_asset_fields: verification.summary?.unresolved_asset_fields || verification.unresolved_asset_fields || 0
      }
      : null
  };
}

function buildRepositoryHandoff({ manifest, latestApply, artifacts }) {
  const routePreviews = collectRepositoryRoutePreviews(latestApply);
  const routeHandoff = artifacts.route_handoff || null;
  return {
    namespace: manifest.repository_namespace,
    files_planned: count(manifest.repository?.files_to_create),
    assets_planned: count(manifest.repository?.assets_to_copy),
    duplicated_components: count(manifest.repository?.components_to_duplicate),
    route_previews: routePreviews,
    route_handoff: routeHandoff
      ? {
        status: routeHandoff.status,
        dry_run: Boolean(routeHandoff.dry_run),
        total_routes: routeHandoff.summary?.total || ensureArray(routeHandoff.routes).length,
        created: routeHandoff.summary?.created || 0,
        blocked: routeHandoff.summary?.blocked || 0,
        manual_handoff_routes: ensureArray(routeHandoff.routes).filter((route) => route.manual_handoff).length,
        markdown_report: routeHandoff.markdown_report || null
      }
      : null
  };
}

function buildAssetHandoff(report) {
  const assetIntegrity = report.asset_integrity || {};
  return {
    status: assetIntegrity.status || 'not_run',
    planned_repository_assets: assetIntegrity.planned_repository_assets || 0,
    planned_storyblok_assets: assetIntegrity.planned_storyblok_assets || 0,
    local_sources_available: assetIntegrity.local_sources_available || 0,
    missing_sources: assetIntegrity.missing_sources || 0,
    uploaded_or_reused: assetIntegrity.uploaded_or_reused || 0,
    unresolved_asset_fields: assetIntegrity.unresolved_asset_fields || 0,
    assets: ensureArray(assetIntegrity.assets).slice(0, 20).map((asset) => ({
      filename: asset.filename || asset.local_path || 'asset',
      source_status: asset.source_status || 'unknown',
      upload_status: asset.upload_status || 'not_run',
      id: asset.id || null
    }))
  };
}

function buildValidationHandoff({ report, artifacts }) {
  return {
    plan: report.latest_validation || null,
    local: artifacts.validation_result || null,
    storyblok_content: artifacts.storyblok_content_validation || report.latest_storyblok_validation || null,
    storyblok_management: artifacts.storyblok_management_verification || report.latest_storyblok_management_verification || null,
    netlify: artifacts.netlify_preview || report.latest_netlify || null,
    route_handoff: artifacts.route_handoff || report.latest_route_handoff || null,
    safety_confirmation: report.safety_confirmation
  };
}

function buildRollbackHandoff({ manifest, rollbackPreview, repoPath, workDir }) {
  const manifestPath = path.join(workDir, 'integration-manifest.json');
  return {
    preview_command: repoPath
      ? `html-to-storyblok rollback-preview --manifest ${manifestPath} --repo ${repoPath}`
      : `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
    local_rollback_command: repoPath
      ? `html-to-storyblok rollback --manifest ${manifestPath} --repo ${repoPath} --confirm-integration-id ${manifest.integration_id} --dry-run`
      : `html-to-storyblok rollback --manifest ${manifestPath} --repo <repo-path> --confirm-integration-id ${manifest.integration_id} --dry-run`,
    remote_rollback_command: repoPath
      ? `html-to-storyblok rollback --manifest ${manifestPath} --repo ${repoPath} --confirm-integration-id ${manifest.integration_id} --remote --confirm-remote-delete --dry-run`
      : `html-to-storyblok rollback --manifest ${manifestPath} --repo <repo-path> --confirm-integration-id ${manifest.integration_id} --remote --confirm-remote-delete --dry-run`,
    local_targets: count(rollbackPreview.repository_files_to_remove),
    storyblok_components: count(rollbackPreview.storyblok_components_to_remove),
    storyblok_stories: count(rollbackPreview.storyblok_stories_to_remove),
    storyblok_assets: count(rollbackPreview.storyblok_assets_to_remove),
    validation_valid: rollbackPreview.validation?.valid === true,
    remote_requires_confirmation: true
  };
}

function buildReviewLinks({ latestApply, artifacts, report, workDir }) {
  const draftLinks = collectDraftEditorLinks(latestApply);
  const livePreview = artifacts.demo_sites_live_preview || artifacts.demo_sites_e2e || null;
  return {
    storyblok_drafts: draftLinks,
    route_previews: collectRepositoryRoutePreviews(latestApply),
    netlify_deploy_url: artifacts.netlify_preview?.deploy?.deploy_url || artifacts.netlify_preview?.deploys?.[0]?.deploy_url || report.latest_netlify?.deploy_url || null,
    live_demo_sites_report: livePreview?.preview_report || livePreview?.markdown_report || null,
    latest_report: path.join(workDir, 'report.md'),
    readiness_report: artifacts.readiness_result?.markdown_report || null
  };
}

function buildEvidence({ report, history, readiness, artifacts, workDir }) {
  const keyArtifacts = [
    ['Manifest', path.join(workDir, 'integration-manifest.json')],
    ['Report', path.join(workDir, 'report.md')],
    ['Production Handoff Pack', path.join(workDir, 'production-handoff-pack.md')],
    ...(readiness?.markdown_report ? [['Readiness Report', readiness.markdown_report]] : []),
    ...(artifacts.rollback_preview ? [['Rollback Preview', path.join(workDir, 'rollback-preview.json')]] : []),
    ...(artifacts.route_handoff?.markdown_report ? [['Route Handoff Report', artifacts.route_handoff.markdown_report]] : [])
  ].map(([label, artifactPath]) => ({ label, path: artifactPath }));
  return {
    work_dir: workDir,
    evidence_entries: report.evidence_entries,
    commands_completed: report.commands_completed,
    commands_failed: report.commands_failed,
    artifacts_recorded: report.artifacts.length,
    history_entries: history.total,
    latest_history: history.entries[0] || null,
    key_artifacts: keyArtifacts
  };
}

function buildSignOffChecklist({ readiness, report, latestApply, artifacts }) {
  const safety = report.safety_confirmation || {};
  return [
    checklistItem('Additive-only plan passed', safety.plan_valid || readiness?.status === 'passed'),
    checklistItem('Storyblok drafts created or reused', collectDraftEditorLinks(latestApply).length > 0),
    checklistItem('Storyblok Management verification passed', safety.storyblok_management_valid),
    checklistItem('Storyblok Content API validation passed or skipped intentionally', safety.storyblok_content_valid),
    checklistItem('Asset integrity passed or pending only before apply', safety.asset_integrity_valid),
    checklistItem('Repository route handoff reviewed', Boolean(artifacts.route_handoff || collectRepositoryRoutePreviews(latestApply).length > 0)),
    checklistItem('Rollback preview reviewed', Boolean(artifacts.rollback_preview || artifacts.readiness_result || readiness)),
    checklistItem('Client/editor visual QA completed', false, 'Manual sign-off required after preview review.')
  ];
}

function buildNextActions({ readiness, report, latestApply, artifacts }) {
  const actions = [];
  if (!latestApply || latestApply.dry_run) actions.push('Run the real apply only after the dry run and plan validation are approved.');
  if (!report.safety_confirmation?.storyblok_management_valid) actions.push('Run html-to-storyblok storyblok-verify after apply to confirm remote Storyblok state.');
  if (!report.safety_confirmation?.storyblok_content_valid) actions.push('Run html-to-storyblok validate-storyblok with a preview token to verify draft content.');
  if (!report.safety_confirmation?.asset_integrity_valid) actions.push('Review html-to-storyblok asset-dashboard and resolve missing or unresolved asset fields.');
  if (!artifacts.route_handoff) actions.push('Run html-to-storyblok wire-routes --dry-run before exposing imported routes on the host site.');
  if (!artifacts.netlify_preview && !artifacts.demo_sites_live_preview && !artifacts.demo_sites_e2e) actions.push('Validate deployed previews through Netlify or demo-site live preview checks.');
  if (readiness?.status === 'failed') actions.push('Resolve failed readiness sections before client handoff.');
  actions.push('Attach production-handoff-pack.md, report.md, readiness-report.md, and rollback preview evidence to the project handoff.');
  return [...new Set(actions)];
}

function handoffStatus({ readiness, report, latestApply }) {
  if (readiness?.status === 'failed') return 'failed';
  if (report.safety_confirmation?.unresolved_failures > 0) return 'failed';
  if (report.latest_validation && report.safety_confirmation?.plan_valid === false) return 'failed';
  if (!latestApply || latestApply.dry_run) return 'warning';
  if (
    report.safety_confirmation?.storyblok_management_valid === false ||
    report.safety_confirmation?.storyblok_content_valid === false ||
    report.safety_confirmation?.asset_integrity_valid === false
  ) {
    return 'warning';
  }
  if (readiness?.status === 'warning') return 'warning';
  return 'passed';
}

function checklistItem(label, done, detail = '') {
  return {
    label,
    status: done ? 'done' : 'pending',
    detail: detail || (done ? 'Evidence available.' : 'Needs review.')
  };
}

function renderStoryblokMarkdown(storyblok) {
  const links = storyblok.draft_editor_links.length
    ? storyblok.draft_editor_links.map((entry) => `- ${entry.slug}: ${entry.editor_url}`).join('\n')
    : '- No draft editor links recorded yet.';
  return `- Folder: ${storyblok.folder}
- Component folders: ${storyblok.component_groups}
- Components: ${storyblok.components}
- Presets: ${storyblok.presets}
- Draft stories: ${storyblok.draft_stories}
- Assets: ${storyblok.assets}
- Content validation: ${storyblok.content_validation?.status || 'not_run'}
- Management verification: ${storyblok.management_verification?.status || 'not_run'}

Draft editor links:
${links}`;
}

function renderRepositoryMarkdown(repository) {
  const routeRows = repository.route_previews.length
    ? repository.route_previews.map((route) => `- ${route.suggested_site_path || route.slug}: ${route.preview_file || 'manual'}${route.route_proposal_file ? ` -> ${route.route_proposal_file}` : ''}`).join('\n')
    : '- No route previews recorded yet.';
  return `- Namespace: ${repository.namespace || 'not planned'}
- Files planned: ${repository.files_planned}
- Assets planned: ${repository.assets_planned}
- Duplicated components: ${repository.duplicated_components}
- Route handoff: ${repository.route_handoff?.status || 'not_run'}

Route previews:
${routeRows}`;
}

function renderValidationMarkdown(validation) {
  return `- Plan validation: ${validation.plan?.status || (validation.plan?.valid ? 'passed' : 'not_run')}
- Local validation: ${validation.local?.status || 'not_run'}
- Storyblok Content API validation: ${validation.storyblok_content?.status || 'not_run'}
- Storyblok Management verification: ${validation.storyblok_management?.status || 'not_run'}
- Netlify preview: ${validation.netlify?.status || 'not_run'}
- Route handoff: ${validation.route_handoff?.status || 'not_run'}
- Unresolved command failures: ${validation.safety_confirmation?.unresolved_failures || 0}`;
}

function renderReviewLinksMarkdown(reviewLinks) {
  const storyLinks = reviewLinks.storyblok_drafts.length
    ? reviewLinks.storyblok_drafts.map((entry) => `- Storyblok ${entry.slug}: ${entry.editor_url}`).join('\n')
    : '- Storyblok drafts: no editor links recorded yet.';
  const routeLinks = reviewLinks.route_previews.length
    ? reviewLinks.route_previews.map((entry) => `- Route preview ${entry.suggested_site_path || entry.slug}: ${entry.preview_file}`).join('\n')
    : '- Route previews: no generated route previews recorded yet.';
  return [
    storyLinks,
    routeLinks,
    reviewLinks.netlify_deploy_url ? `- Netlify deploy: ${reviewLinks.netlify_deploy_url}` : '- Netlify deploy: not recorded.',
    reviewLinks.live_demo_sites_report ? `- Live demo report: ${reviewLinks.live_demo_sites_report}` : '- Live demo report: not recorded.',
    `- Latest report: ${reviewLinks.latest_report}`,
    reviewLinks.readiness_report ? `- Readiness report: ${reviewLinks.readiness_report}` : '- Readiness report: not recorded.'
  ].join('\n');
}

async function readHandoffArtifacts(workDir) {
  return {
    apply_result: await readOptionalJson(path.join(workDir, 'apply-result.json')),
    storyblok_apply_result: await readOptionalJson(path.join(workDir, 'storyblok-apply-result.json')),
    validation_result: await readOptionalJson(path.join(workDir, 'validation-result.json')),
    storyblok_content_validation: await readOptionalJson(path.join(workDir, 'storyblok-content-validation.json')),
    storyblok_management_verification: await readOptionalJson(path.join(workDir, 'storyblok-management-verification.json')),
    netlify_preview: await readOptionalJson(path.join(workDir, 'netlify-preview.json')),
    route_handoff: await readOptionalJson(path.join(workDir, 'route-handoff-result.json')),
    rollback_preview: await readOptionalJson(path.join(workDir, 'rollback-preview.json')),
    readiness_result: await readOptionalJson(path.join(workDir, 'readiness-result.json')),
    demo_sites_live_preview: await readOptionalJson(path.join(workDir, 'demo-sites-live-preview-result.json')),
    demo_sites_e2e: await readOptionalJson(path.join(workDir, 'demo-sites-e2e-result.json'))
  };
}

async function readOptionalJson(filePath) {
  if (!(await pathExists(filePath))) return null;
  return readJson(filePath);
}

function collectDraftEditorLinks(result) {
  return ensureArray(result?.steps)
    .flatMap((step) => ensureArray(step?.results))
    .filter((entry) => entry?.action === 'create_draft_story' && entry.editor_url)
    .map((entry) => ({
      slug: entry.slug || entry.story_slug || `story-${entry.id}`,
      editor_url: entry.editor_url
    }));
}

function collectRepositoryRoutePreviews(result) {
  return ensureArray(result?.steps)
    .flatMap((step) => ensureArray(step?.route_previews))
    .filter((route) => route?.slug)
    .map((route) => ({
      slug: route.slug,
      suggested_site_path: route.suggested_site_path || null,
      preview_file: route.preview_file || null,
      route_proposal_file: route.route_proposal_file || null
    }));
}

function count(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}
