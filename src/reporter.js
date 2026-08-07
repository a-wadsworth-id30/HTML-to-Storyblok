import path from 'node:path';
import { readEvidence } from './evidence.js';
import { readJson, writeText } from './utils.js';

export async function createReport(workDir) {
  const evidence = await readEvidence(workDir);
  const artifacts = evidence.filter((entry) => entry.type === 'artifact_written').map((entry) => entry.artifact);
  const artifactSummaries = [];
  for (const artifact of artifacts) {
    artifactSummaries.push(await summarizeArtifact(artifact));
  }
  const completed = evidence.filter((entry) => entry.type === 'command_completed');
  const failed = evidence.filter((entry) => entry.type === 'command_failed');
  const latestValidation = latestSummary(artifactSummaries, ['plan_validation', 'integration_validation']);
  const latestStoryblokValidation = latestSummary(artifactSummaries, ['storyblok_content_validation']);
  const latestNetlify = latestSummary(artifactSummaries, ['netlify_preview']);
  return {
    work_dir: workDir,
    evidence_entries: evidence.length,
    commands_started: evidence.filter((entry) => entry.type === 'command_started').length,
    commands_completed: completed.length,
    commands_failed: failed.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      message: entry.message,
      timestamp: entry.timestamp
    })),
    commands: completed.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      timestamp: entry.timestamp
    })),
    artifacts: artifactSummaries,
    latest_validation: latestValidation,
    latest_storyblok_validation: latestStoryblokValidation,
    latest_netlify: latestNetlify,
    safety_confirmation: {
      plan_valid: latestValidation?.status === 'passed' || latestValidation?.valid === true,
      storyblok_content_valid: latestStoryblokValidation?.status === 'passed' || latestStoryblokValidation?.status === 'skipped',
      deploy_preview_verified: latestNetlify?.status === 'passed',
      command_argument_redaction: 'token-like argument keys are redacted in evidence',
      unresolved_failures: failed.length
    }
  };
}

export async function writeMarkdownReport(workDir, report = null) {
  const resolvedReport = report || await createReport(workDir);
  const filePath = path.join(workDir, 'report.md');
  await writeText(filePath, renderMarkdownReport(resolvedReport));
  return filePath;
}

export function renderMarkdownReport(report) {
  const latestValidation = report.latest_validation
    ? `${report.latest_validation.status || (report.latest_validation.valid ? 'passed' : 'failed')}`
    : 'not run';
  const latestStoryblokValidation = report.latest_storyblok_validation?.status || 'not run';
  const latestNetlify = report.latest_netlify?.status || 'not run';
  const artifactRows = report.artifacts.length
    ? report.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.artifact}`).join('\n')
    : '- None recorded';
  const failureRows = report.commands_failed.length
    ? report.commands_failed.map((failure) => `- ${failure.command}: ${failure.message}`).join('\n')
    : '- None';
  const skippedDuplicationRows = duplicationSkippedCandidates(report)
    .map((candidate) => `- ${candidate.source_path}: ${candidate.blockers.join('; ')}`)
    .join('\n') || '- None';

  return `# HTML-to-Storyblok Report

## Summary

- Work directory: ${report.work_dir}
- Evidence entries: ${report.evidence_entries}
- Commands completed: ${report.commands_completed}
- Latest validation: ${latestValidation}
- Latest Storyblok validation: ${latestStoryblokValidation}
- Latest Netlify: ${latestNetlify}

## Safety

- Plan valid: ${report.safety_confirmation.plan_valid ? 'yes' : 'no'}
- Storyblok content valid: ${report.safety_confirmation.storyblok_content_valid ? 'yes' : 'no'}
- Deploy preview verified: ${report.safety_confirmation.deploy_preview_verified ? 'yes' : 'no'}
- Unresolved failures: ${report.safety_confirmation.unresolved_failures}
- Secret handling: ${report.safety_confirmation.command_argument_redaction}

## Artifacts

${artifactRows}

## Duplication Diagnostics

${skippedDuplicationRows}

## Failures

${failureRows}
`;
}

async function summarizeArtifact(artifact) {
  const name = artifact.split('/').at(-1);
  try {
    const data = await readJson(artifact);
    if (name === 'integration-manifest.json') {
      const skippedCandidates = normalizeSkippedCandidates(data.duplication_inference?.skipped_repository_candidates);
      return {
        type: 'integration_manifest',
        artifact,
        integration_id: data.integration_id,
        repository_files: data.repository?.files_to_create?.length || 0,
        repository_components_to_duplicate: data.repository?.components_to_duplicate?.length || 0,
        repository_assets_to_create: data.repository?.assets_to_create?.length || 0,
        storyblok_component_groups: data.storyblok?.component_groups_to_create?.length || 0,
        storyblok_internal_tags: data.storyblok?.internal_tags_to_create?.length || 0,
        storyblok_components: data.storyblok?.components_to_create?.length || 0,
        storyblok_presets: data.storyblok?.presets_to_create?.length || 0,
        storyblok_stories: data.storyblok?.stories_to_create?.length || 0,
        storyblok_assets: data.storyblok?.assets_to_create?.length || 0,
        duplication_inference: data.duplication_inference
          ? {
            repository_components: data.duplication_inference.repository_components || 0,
            repository_dependency_files: data.duplication_inference.repository_dependency_files || 0,
            repository_asset_files: data.duplication_inference.repository_asset_files || 0,
            skipped_repository_candidates: skippedCandidates.length,
            skipped_candidates: skippedCandidates.slice(0, 10)
          }
          : null
      };
    }
    if (name === 'plan-validation.json') {
      return {
        type: 'plan_validation',
        artifact,
        valid: data.valid,
        status: data.valid ? 'passed' : 'failed',
        violations: data.violations?.length || 0
      };
    }
    if (name === 'validation-result.json') {
      return {
        type: 'integration_validation',
        artifact,
        status: data.status,
        failed_checks: data.failed_checks || 0
      };
    }
    if (name === 'netlify-preview.json') {
      return {
        type: 'netlify_preview',
        artifact,
        status: data.status,
        deploy_url: data.deploy?.deploy_url || data.deploys?.[0]?.deploy_url || null,
        failed_checks: data.failed_checks || 0
      };
    }
    if (name === 'storyblok-preflight.json' || name.endsWith('storyblok-preflight.json') || name.endsWith('-preflight.json')) {
      return summarizeStoryblokPreflight(data, artifact);
    }
    if (name === 'storyblok-content-validation.json' || name.endsWith('storyblok-content-validation.json') || name.endsWith('-content-validation.json')) {
      return summarizeStoryblokContentValidation(data, artifact);
    }
    if (name === 'storyblok-reconcile.json') {
      return summarizeStoryblokReconcile(data, artifact);
    }
    if (name === 'storyblok-management-verification.json' || name.endsWith('management-verification.json')) {
      return summarizeStoryblokManagementVerification(data, artifact);
    }
    if (name === 'storyblok-audit.json') {
      return summarizeStoryblokAudit(data, artifact);
    }
    if (name === 'storyblok-activity-evidence.json' || name.endsWith('activity-evidence.json')) {
      return summarizeStoryblokActivityEvidence(data, artifact);
    }
    if (name === 'storyblok-apply-result.json' || name === 'apply-result.json') {
      return summarizeStoryblokApplyResult(data, artifact, name);
    }
    if (name === 'github-pr-result.json') {
      return {
        type: 'github_pull_request',
        artifact,
        dry_run: Boolean(data.dry_run),
        url: data.url || null,
        number: data.number || null,
        status: data.status || null
      };
    }
    if (name === 'gitlab-mr-result.json') {
      return {
        type: 'gitlab_merge_request',
        artifact,
        dry_run: Boolean(data.dry_run),
        url: data.url || data.web_url || null,
        iid: data.iid || null,
        status: data.status || null
      };
    }
    return {
      type: name.replace(/\.json$/, '').replaceAll('-', '_'),
      artifact,
      status: data.status || data.action || 'recorded'
    };
  } catch {
    return {
      type: 'unreadable_artifact',
      artifact,
      status: 'unreadable'
    };
  }
}

function summarizeStoryblokPreflight(data, artifact) {
  return {
    type: 'storyblok_preflight',
    artifact,
    status: data.status || 'recorded',
    required_checks: ensureArray(data.checks).filter((check) => check.required !== false).length,
    failed_checks: ensureArray(data.checks).filter((check) => check.required !== false && check.status !== 'passed').length,
    content_api: data.capabilities?.content_api || 'unknown',
    requirements: data.requirements?.counts || null
  };
}

function summarizeStoryblokContentValidation(data, artifact) {
  return {
    type: 'storyblok_content_validation',
    artifact,
    status: data.status || 'recorded',
    version: data.version || null,
    stories: data.summary?.stories || ensureArray(data.stories).length,
    failed_stories: data.summary?.failed || ensureArray(data.stories).filter((story) => story.status === 'failed').length,
    components: data.summary?.components || 0,
    assets: data.summary?.assets || 0,
    story_links: data.summary?.story_links || 0,
    unresolved_generated_story_links: data.summary?.unresolved_generated_story_links || 0
  };
}

function summarizeStoryblokReconcile(data, artifact) {
  return {
    type: 'storyblok_reconcile',
    artifact,
    status: data.status || 'recorded',
    total: data.summary?.total || 0,
    matching: data.summary?.matching || 0,
    missing: data.summary?.missing || 0,
    drifted: data.summary?.drifted || 0,
    blocked: data.summary?.blocked || 0
  };
}

function summarizeStoryblokManagementVerification(data, artifact) {
  return {
    type: 'storyblok_management_verification',
    artifact,
    status: data.status || 'recorded',
    resources: data.summary?.resources || 0,
    matching: data.summary?.matching || 0,
    missing: data.summary?.missing || 0,
    drifted: data.summary?.drifted || 0,
    blocked: data.summary?.blocked || 0,
    failed_story_checks: data.summary?.failed_story_checks || 0,
    unresolved_generated_story_links: data.summary?.unresolved_generated_story_links || 0,
    unresolved_asset_fields: data.summary?.unresolved_asset_fields || 0
  };
}

function summarizeStoryblokAudit(data, artifact) {
  const audit = data.audit || {};
  return {
    type: 'storyblok_audit',
    artifact,
    status: audit.status || data.status || 'recorded',
    unavailable_collections: ensureArray(audit.unavailable).length,
    core_counts: data.readiness?.core_counts || null,
    governance: data.readiness?.governance || null,
    automation: data.readiness?.automation || null
  };
}

function summarizeStoryblokActivityEvidence(data, artifact) {
  return {
    type: 'storyblok_activity_evidence',
    artifact,
    status: data.status || 'recorded',
    total: data.summary?.total || 0,
    related: data.summary?.related || 0
  };
}

function summarizeStoryblokApplyResult(data, artifact, name) {
  const steps = ensureArray(data.steps);
  const stepResults = steps.flatMap((step) => ensureArray(step.results));
  const draftResults = stepResults.filter((result) => result.action === 'create_draft_story');
  const assetResults = stepResults.filter((result) => result.action === 'upload_asset');
  const componentResults = stepResults.filter((result) => result.action === 'create_component');
  const componentGroupResults = stepResults.filter((result) => result.action === 'create_component_group');
  const internalTagResults = stepResults.filter((result) => result.action === 'create_internal_tag');
  const presetResults = stepResults.filter((result) => result.action === 'create_component_preset');
  const linkSummary = draftResults.reduce((summary, result) => ({
    total_links: summary.total_links + Number(result.link_summary?.total_links || 0),
    story_links: summary.story_links + Number(result.link_summary?.story_links || 0),
    resolved_story_links: summary.resolved_story_links + Number(result.link_summary?.resolved_story_links || 0),
    unresolved_story_links: summary.unresolved_story_links + Number(result.link_summary?.unresolved_story_links || 0)
  }), {
    total_links: 0,
    story_links: 0,
    resolved_story_links: 0,
    unresolved_story_links: 0
  });
  return {
    type: name === 'apply-result.json' ? 'apply_result' : 'storyblok_apply_result',
    artifact,
    status: data.status || data.action || 'recorded',
    dry_run: Boolean(data.dry_run),
    component_groups_created_or_reused: componentGroupResults.length,
    internal_tags_created_or_reused: internalTagResults.length,
    components_created_or_reused: componentResults.length,
    presets_created_or_reused: presetResults.length,
    assets_created_or_reused: assetResults.length,
    draft_stories_created_or_reused: draftResults.length,
    link_summary: linkSummary
  };
}

function latestSummary(summaries, types) {
  return [...summaries].reverse().find((summary) => types.includes(summary.type)) || null;
}

function duplicationSkippedCandidates(report) {
  return report.artifacts
    .filter((artifact) => artifact.type === 'integration_manifest')
    .flatMap((artifact) => artifact.duplication_inference?.skipped_candidates || [])
    .slice(0, 10);
}

function normalizeSkippedCandidates(candidates) {
  return Array.isArray(candidates)
    ? candidates.map((candidate) => ({
      source_path: String(candidate.source_path || 'unknown source'),
      confidence: candidate.confidence || null,
      matched_signal: candidate.matched_signal || null,
      blockers: Array.isArray(candidate.blockers) ? candidate.blockers.map(String) : []
    }))
    : [];
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}
