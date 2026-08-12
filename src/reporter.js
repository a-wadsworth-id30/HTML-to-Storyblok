import path from 'node:path';
import { buildAssetIntegrityDashboard, renderAssetIntegrityMarkdown, summarizeManifestAssets } from './asset-integrity.js';
import { buildAssetReferenceGraph, renderAssetReferenceGraphMarkdown, summarizeManifestAssetReferenceGraph } from './asset-reference-graph.js';
import { readEvidence } from './evidence.js';
import { createNextActionModel } from './next-action.js';
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
  const latestStoryblokManagementVerification = latestSummary(artifactSummaries, ['storyblok_management_verification']);
  const latestNetlify = latestSummary(artifactSummaries, ['netlify_preview']);
  const latestRouteHandoff = latestSummary(artifactSummaries, ['route_handoff']);
  const latestRouteHandoffChecklist = latestSummary(artifactSummaries, ['route_handoff_checklist']);
  const latestRouteCollisionAnalysis = latestSummary(artifactSummaries, ['route_collision_analysis']);
  const latestPlatformReadiness = latestSummary(artifactSummaries, ['platform_readiness']);
  const latestClientReviewGate = latestSummary(artifactSummaries, ['client_review_gate']);
  const latestEvidenceIndex = latestSummary(artifactSummaries, ['handoff_evidence_index']);
  const latestRemoteTransactionLedger = latestSummary(artifactSummaries, ['remote_transaction_ledger']);
  const latestTemplateQuality = latestSummary(artifactSummaries, ['template_quality']);
  const latestRollback = latestSummary(artifactSummaries, ['rollback', 'rollback_preview']);
  const assetIntegrity = buildAssetIntegrityDashboard(artifactSummaries);
  const assetReferenceGraph = buildAssetReferenceGraph(artifactSummaries);
  const report = {
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
    latest_storyblok_management_verification: latestStoryblokManagementVerification,
    latest_netlify: latestNetlify,
    latest_route_handoff: latestRouteHandoff,
    latest_route_handoff_checklist: latestRouteHandoffChecklist,
    latest_route_collision_analysis: latestRouteCollisionAnalysis,
    latest_platform_readiness: latestPlatformReadiness,
    latest_client_review_gate: latestClientReviewGate,
    latest_evidence_index: latestEvidenceIndex,
    latest_remote_transaction_ledger: latestRemoteTransactionLedger,
    latest_template_quality: latestTemplateQuality,
    latest_rollback: latestRollback,
    asset_integrity: assetIntegrity,
    asset_reference_graph: assetReferenceGraph,
    safety_confirmation: {
      plan_valid: latestValidation?.status === 'passed' || latestValidation?.valid === true,
      storyblok_content_valid: latestStoryblokValidation?.status === 'passed' || latestStoryblokValidation?.status === 'skipped',
      storyblok_management_valid: latestStoryblokManagementVerification?.status === 'passed' || latestStoryblokManagementVerification?.status === 'skipped',
      asset_integrity_valid: assetIntegrity.status === 'passed' || assetIntegrity.status === 'pending',
      asset_reference_graph_valid: assetReferenceGraph.status === 'passed' || assetReferenceGraph.status === 'pending',
      client_review_ready: !latestClientReviewGate || latestClientReviewGate.status !== 'failed',
      route_handoff_checklist_ready: !latestRouteHandoffChecklist || latestRouteHandoffChecklist.status !== 'blocked',
      route_collision_safe: !latestRouteCollisionAnalysis || latestRouteCollisionAnalysis.status !== 'blocked',
      platform_ready: !latestPlatformReadiness || !['blocked', 'failed'].includes(latestPlatformReadiness.status),
      handoff_evidence_ready: !latestEvidenceIndex || latestEvidenceIndex.status !== 'attention',
      remote_transaction_ledger_valid: !latestRemoteTransactionLedger || latestRemoteTransactionLedger.status !== 'failed',
      deploy_preview_verified: latestNetlify?.status === 'passed',
      command_argument_redaction: 'token-like argument keys are redacted in evidence',
      unresolved_failures: failed.length
    }
  };
  report.next_actions = createNextActionModel({ report, workDir });
  return report;
}

export async function writeMarkdownReport(workDir, report = null) {
  const resolvedReport = report || await createReport(workDir);
  const filePath = path.join(workDir, 'report.md');
  await writeText(filePath, renderMarkdownReport(resolvedReport));
  return filePath;
}

export async function writeHtmlReport(workDir, report = null) {
  const resolvedReport = report || await createReport(workDir);
  const filePath = path.join(workDir, 'report.html');
  await writeText(filePath, renderHtmlReport(resolvedReport));
  return filePath;
}

export function renderMarkdownReport(report) {
  const latestValidation = report.latest_validation
    ? `${report.latest_validation.status || (report.latest_validation.valid ? 'passed' : 'failed')}`
    : 'not run';
  const latestStoryblokValidation = report.latest_storyblok_validation?.status || 'not run';
  const latestStoryblokManagementVerification = report.latest_storyblok_management_verification?.status || 'not run';
  const latestNetlify = report.latest_netlify?.status || 'not run';
  const latestRouteHandoff = report.latest_route_handoff?.status || 'not run';
  const latestRouteHandoffChecklist = report.latest_route_handoff_checklist?.status || 'not run';
  const latestRouteCollisionAnalysis = report.latest_route_collision_analysis?.status || 'not run';
  const latestPlatformReadiness = report.latest_platform_readiness?.status || 'not run';
  const latestClientReviewGate = report.latest_client_review_gate?.status || 'not run';
  const latestEvidenceIndex = report.latest_evidence_index?.status || 'not run';
  const latestRemoteTransactionLedger = report.latest_remote_transaction_ledger?.status || 'not run';
  const latestTemplateQuality = report.latest_template_quality
    ? `${report.latest_template_quality.grade || '-'} (${report.latest_template_quality.score || 0}/100)`
    : 'not run';
  const latestRollback = report.latest_rollback
    ? `${report.latest_rollback.type} (${report.latest_rollback.risk_flags || 0} risk flag(s))`
    : 'not run';
  const artifactRows = report.artifacts.length
    ? report.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.artifact}`).join('\n')
    : '- None recorded';
  const failureRows = report.commands_failed.length
    ? report.commands_failed.map((failure) => `- ${failure.command}: ${failure.message}`).join('\n')
    : '- None';
  const skippedDuplicationRows = duplicationSkippedCandidates(report)
    .map((candidate) => `- ${candidate.source_path}: ${candidate.blockers.join('; ')}`)
    .join('\n') || '- None';
  const storyblokManagementRows = storyblokManagementVerificationRows(report).join('\n');
  const assetIntegrityMarkdown = renderAssetIntegrityMarkdown(report.asset_integrity);
  const assetReferenceGraphMarkdown = renderAssetReferenceGraphMarkdown(report.asset_reference_graph);
  const nextActionRows = renderNextActionRows(report);

  return `# HTML-to-Storyblok Report

## Summary

- Work directory: ${report.work_dir}
- Evidence entries: ${report.evidence_entries}
- Commands completed: ${report.commands_completed}
- Latest validation: ${latestValidation}
- Latest Storyblok validation: ${latestStoryblokValidation}
- Latest Storyblok management verification: ${latestStoryblokManagementVerification}
- Latest Netlify: ${latestNetlify}
- Latest route handoff: ${latestRouteHandoff}
- Latest route handoff checklist: ${latestRouteHandoffChecklist}
- Latest route collision analysis: ${latestRouteCollisionAnalysis}
- Latest platform readiness: ${latestPlatformReadiness}
- Latest client review gate: ${latestClientReviewGate}
- Latest handoff evidence index: ${latestEvidenceIndex}
- Latest remote transaction ledger: ${latestRemoteTransactionLedger}
- Latest template quality: ${latestTemplateQuality}
- Latest rollback: ${latestRollback}

## Safety

- Plan valid: ${report.safety_confirmation.plan_valid ? 'yes' : 'no'}
- Storyblok content valid: ${report.safety_confirmation.storyblok_content_valid ? 'yes' : 'no'}
- Storyblok management valid: ${report.safety_confirmation.storyblok_management_valid ? 'yes' : 'no'}
- Asset integrity valid: ${report.safety_confirmation.asset_integrity_valid ? 'yes' : 'no'}
- Asset reference graph valid: ${report.safety_confirmation.asset_reference_graph_valid ? 'yes' : 'no'}
- Client review ready: ${report.safety_confirmation.client_review_ready ? 'yes' : 'no'}
- Route handoff checklist ready: ${report.safety_confirmation.route_handoff_checklist_ready ? 'yes' : 'no'}
- Route collision safe: ${report.safety_confirmation.route_collision_safe ? 'yes' : 'no'}
- Platform ready: ${report.safety_confirmation.platform_ready ? 'yes' : 'no'}
- Handoff evidence ready: ${report.safety_confirmation.handoff_evidence_ready ? 'yes' : 'no'}
- Remote transaction ledger valid: ${report.safety_confirmation.remote_transaction_ledger_valid ? 'yes' : 'no'}
- Deploy preview verified: ${report.safety_confirmation.deploy_preview_verified ? 'yes' : 'no'}
- Unresolved failures: ${report.safety_confirmation.unresolved_failures}
- Secret handling: ${report.safety_confirmation.command_argument_redaction}

${assetIntegrityMarkdown}

${assetReferenceGraphMarkdown}

## Recommended Next Actions

${nextActionRows}

## Artifacts

${artifactRows}

## Duplication Diagnostics

${skippedDuplicationRows}

## Storyblok Management Verification

${storyblokManagementRows}

## Failures

${failureRows}
`;
}

export function renderHtmlReport(report) {
  const latestValidation = report.latest_validation
    ? report.latest_validation.status || (report.latest_validation.valid ? 'passed' : 'failed')
    : 'not run';
  const latestStoryblokValidation = report.latest_storyblok_validation?.status || 'not run';
  const latestStoryblokManagementVerification = report.latest_storyblok_management_verification?.status || 'not run';
  const latestRouteHandoff = report.latest_route_handoff?.status || 'not run';
  const latestRouteHandoffChecklist = report.latest_route_handoff_checklist?.status || 'not run';
  const latestRouteCollisionAnalysis = report.latest_route_collision_analysis?.status || 'not run';
  const latestPlatformReadiness = report.latest_platform_readiness?.status || 'not run';
  const latestClientReviewGate = report.latest_client_review_gate?.status || 'not run';
  const latestEvidenceIndex = report.latest_evidence_index?.status || 'not run';
  const latestRemoteTransactionLedger = report.latest_remote_transaction_ledger?.status || 'not run';
  const latestTemplateQuality = report.latest_template_quality
    ? `${report.latest_template_quality.grade || '-'} (${report.latest_template_quality.score || 0}/100)`
    : 'not run';
  const latestRollback = report.latest_rollback
    ? `${report.latest_rollback.type} (${report.latest_rollback.risk_flags || 0} risk flag(s))`
    : 'not run';
  const assetIntegrity = report.asset_integrity || {};
  const assetReferenceGraph = report.asset_reference_graph || {};
  const assetIntegrityRows = (assetIntegrity.assets || [])
    .slice(0, 20)
    .map((asset) => `<tr><td>${escapeHtml(asset.filename || asset.local_path || 'asset')}</td><td>${escapeHtml(asset.source_status || 'unknown')}</td><td>${escapeHtml(asset.upload_status || 'not_run')}</td><td>${escapeHtml(asset.id || '')}</td></tr>`)
    .join('\n') || '<tr><td colspan="4">None recorded</td></tr>';
  const assetGraphRows = (assetReferenceGraph.assets || [])
    .slice(0, 20)
    .map((asset) => `<tr><td>${escapeHtml(asset.filename || asset.local_path || asset.asset_key || 'asset')}</td><td>${escapeHtml(asset.usage_count || 0)}</td><td>${escapeHtml(asset.upload_status || 'not_run')}</td><td>${escapeHtml(asset.remote_id || '')}</td></tr>`)
    .join('\n') || '<tr><td colspan="4">None recorded</td></tr>';
  const storyblokManagementRows = storyblokManagementVerificationRows(report)
    .map((row) => `<li>${escapeHtml(row.replace(/^- /, ''))}</li>`)
    .join('\n') || '<li>Not run</li>';
  const nextActionRows = ensureArray(report.next_actions?.actions)
    .map((action) => `<li><strong>${escapeHtml(action.label)}</strong>: ${escapeHtml(action.reason)} <code>${escapeHtml(action.command || '')}</code></li>`)
    .join('\n') || '<li>No recommended action recorded.</li>';
  const artifactRows = report.artifacts.map((artifact) => `<tr><td>${escapeHtml(artifact.type)}</td><td>${escapeHtml(artifact.status || 'recorded')}</td><td><code>${escapeHtml(artifact.artifact)}</code></td></tr>`).join('\n') ||
    '<tr><td colspan="3">None recorded</td></tr>';
  const failureRows = report.commands_failed.map((failure) => `<li><strong>${escapeHtml(failure.command)}</strong>: ${escapeHtml(failure.message)}</li>`).join('\n') ||
    '<li>None</li>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>HTML-to-Storyblok Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #1f2933; line-height: 1.45; }
      h1, h2 { margin: 0 0 12px; }
      section { margin: 28px 0; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #d8dee4; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f6f8fa; }
      code { background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }
      .ok { color: #116329; }
      .warn { color: #9a6700; }
    </style>
  </head>
  <body>
    <h1>HTML-to-Storyblok Report</h1>
    <section>
      <h2>Summary</h2>
      <p><strong>Work directory:</strong> <code>${escapeHtml(report.work_dir)}</code></p>
      <p><strong>Latest validation:</strong> ${escapeHtml(latestValidation)}</p>
      <p><strong>Latest Storyblok validation:</strong> ${escapeHtml(latestStoryblokValidation)}</p>
      <p><strong>Latest Storyblok management verification:</strong> ${escapeHtml(latestStoryblokManagementVerification)}</p>
      <p><strong>Latest route handoff:</strong> ${escapeHtml(latestRouteHandoff)}</p>
      <p><strong>Latest route handoff checklist:</strong> ${escapeHtml(latestRouteHandoffChecklist)}</p>
      <p><strong>Latest route collision analysis:</strong> ${escapeHtml(latestRouteCollisionAnalysis)}</p>
      <p><strong>Latest platform readiness:</strong> ${escapeHtml(latestPlatformReadiness)}</p>
      <p><strong>Latest client review gate:</strong> ${escapeHtml(latestClientReviewGate)}</p>
      <p><strong>Latest handoff evidence index:</strong> ${escapeHtml(latestEvidenceIndex)}</p>
      <p><strong>Latest remote transaction ledger:</strong> ${escapeHtml(latestRemoteTransactionLedger)}</p>
      <p><strong>Latest template quality:</strong> ${escapeHtml(latestTemplateQuality)}</p>
      <p><strong>Latest rollback:</strong> ${escapeHtml(latestRollback)}</p>
      <p><strong>Commands completed:</strong> ${report.commands_completed}</p>
    </section>
    <section>
      <h2>Safety</h2>
      <ul>
        <li class="${report.safety_confirmation.plan_valid ? 'ok' : 'warn'}">Plan valid: ${report.safety_confirmation.plan_valid ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.storyblok_content_valid ? 'ok' : 'warn'}">Storyblok content valid: ${report.safety_confirmation.storyblok_content_valid ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.storyblok_management_valid ? 'ok' : 'warn'}">Storyblok management valid: ${report.safety_confirmation.storyblok_management_valid ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.asset_integrity_valid ? 'ok' : 'warn'}">Asset integrity valid: ${report.safety_confirmation.asset_integrity_valid ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.client_review_ready ? 'ok' : 'warn'}">Client review ready: ${report.safety_confirmation.client_review_ready ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.route_handoff_checklist_ready ? 'ok' : 'warn'}">Route handoff checklist ready: ${report.safety_confirmation.route_handoff_checklist_ready ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.platform_ready ? 'ok' : 'warn'}">Platform ready: ${report.safety_confirmation.platform_ready ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.handoff_evidence_ready ? 'ok' : 'warn'}">Handoff evidence ready: ${report.safety_confirmation.handoff_evidence_ready ? 'yes' : 'no'}</li>
        <li class="${report.safety_confirmation.remote_transaction_ledger_valid ? 'ok' : 'warn'}">Remote transaction ledger valid: ${report.safety_confirmation.remote_transaction_ledger_valid ? 'yes' : 'no'}</li>
        <li>Secret handling: ${escapeHtml(report.safety_confirmation.command_argument_redaction)}</li>
      </ul>
    </section>
    <section>
      <h2>Asset Integrity</h2>
      <p><strong>Status:</strong> ${escapeHtml(assetIntegrity.status || 'not_run')}</p>
      <p><strong>Planned Storyblok assets:</strong> ${assetIntegrity.planned_storyblok_assets || 0}; <strong>Uploaded or reused:</strong> ${assetIntegrity.uploaded_or_reused || 0}; <strong>Unresolved asset fields:</strong> ${assetIntegrity.unresolved_asset_fields || 0}</p>
      <table>
        <thead><tr><th>Asset</th><th>Source</th><th>Upload</th><th>ID</th></tr></thead>
        <tbody>${assetIntegrityRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Asset Reference Graph</h2>
      <p><strong>Status:</strong> ${escapeHtml(assetReferenceGraph.status || 'not_run')}; <strong>Story asset fields:</strong> ${assetReferenceGraph.summary?.story_asset_fields || 0}; <strong>Resolved:</strong> ${assetReferenceGraph.summary?.resolved_story_asset_fields || 0}; <strong>Unresolved:</strong> ${assetReferenceGraph.summary?.unresolved_story_asset_fields || 0}</p>
      <table>
        <thead><tr><th>Asset</th><th>Story Fields</th><th>Upload</th><th>Remote ID</th></tr></thead>
        <tbody>${assetGraphRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Recommended Next Actions</h2>
      <ul>${nextActionRows}</ul>
    </section>
    <section>
      <h2>Storyblok Management Verification</h2>
      <ul>${storyblokManagementRows}</ul>
    </section>
    <section>
      <h2>Artifacts</h2>
      <table>
        <thead><tr><th>Type</th><th>Status</th><th>Path</th></tr></thead>
        <tbody>${artifactRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Failures</h2>
      <ul>${failureRows}</ul>
    </section>
  </body>
</html>
`;
}

async function summarizeArtifact(artifact) {
  const name = artifact.split('/').at(-1);
  if (name === 'route-handoff-report.md') {
    return {
      type: 'route_handoff_report',
      artifact,
      status: 'recorded'
    };
  }
  if (name === 'route-handoff-checklist.md') {
    return {
      type: 'route_handoff_checklist_report',
      artifact,
      status: 'recorded'
    };
  }
  if (name === 'platform-readiness-report.md') {
    return {
      type: 'platform_readiness_report',
      artifact,
      status: 'recorded'
    };
  }
  if (name === 'handoff-evidence-index.md') {
    return {
      type: 'handoff_evidence_index_report',
      artifact,
      status: 'recorded'
    };
  }
  try {
    const data = await readJson(artifact);
    if (name === 'integration-manifest.json') {
      const skippedCandidates = normalizeSkippedCandidates(data.duplication_inference?.skipped_repository_candidates);
      const assetIntegrity = await summarizeManifestAssets(data);
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
        asset_integrity: assetIntegrity,
        asset_reference_graph: await summarizeManifestAssetReferenceGraph(data, { assetIntegrity }),
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
    if (name === 'template-quality.json') {
      return summarizeTemplateQuality(data, artifact);
    }
    if (name === 'template-readiness.json') {
      return summarizeTemplateReadiness(data, artifact);
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
    if (name === 'route-handoff-result.json') {
      return summarizeRouteHandoff(data, artifact);
    }
    if (name === 'route-handoff-checklist.json' || name.endsWith('route-handoff-checklist.json')) {
      return summarizeRouteHandoffChecklist(data, artifact);
    }
    if (name === 'route-collision-analysis.json' || name.endsWith('route-collision-analysis.json')) {
      return summarizeRouteCollisionAnalysis(data, artifact);
    }
    if (name === 'platform-readiness.json' || name.endsWith('platform-readiness.json')) {
      return summarizePlatformReadiness(data, artifact);
    }
    if (name === 'handoff-evidence-index.json' || name.endsWith('handoff-evidence-index.json')) {
      return summarizeHandoffEvidenceIndex(data, artifact);
    }
    if (name === 'client-review-gate.json' || name.endsWith('client-review-gate.json')) {
      return summarizeClientReviewGate(data, artifact);
    }
    if (name === 'asset-reference-graph.json' || name.endsWith('asset-reference-graph.json')) {
      return summarizeAssetReferenceGraph(data, artifact);
    }
    if (name === 'remote-transaction-ledger.json' || name.endsWith('remote-transaction-ledger.json')) {
      return summarizeRemoteTransactionLedger(data, artifact);
    }
    if (name === 'rollback-preview.json') {
      return summarizeRollbackArtifact(data, artifact, 'rollback_preview');
    }
    if (name === 'rollback-result.json') {
      return summarizeRollbackArtifact(data, artifact, 'rollback');
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

function summarizeTemplateQuality(data, artifact) {
  return {
    type: 'template_quality',
    artifact,
    status: data.status || 'recorded',
    score: data.score || 0,
    grade: data.grade || null,
    risks: ensureArray(data.risks).length,
    categories: ensureArray(data.categories).length
  };
}

function summarizeTemplateReadiness(data, artifact) {
  const quality = data.quality_profile || {};
  return {
    type: 'template_quality',
    artifact,
    status: data.status || 'recorded',
    readiness_level: data.readiness_level || null,
    readiness_score: data.score || 0,
    score: quality.score || data.quality_score || 0,
    grade: quality.grade || data.quality_grade || null,
    risks: ensureArray(quality.risks).length,
    categories: ensureArray(quality.categories).length
  };
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
    story_checks: data.summary?.story_checks || 0,
    failed_story_checks: data.summary?.failed_story_checks || 0,
    unresolved_generated_story_links: data.summary?.unresolved_generated_story_links || 0,
    unresolved_asset_fields: data.summary?.unresolved_asset_fields || 0,
    asset_fields: data.summary?.asset_fields || 0,
    content_drifted_stories: data.summary?.content_drifted_stories || 0
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
    route_previews: steps.flatMap((step) => ensureArray(step?.route_previews)).length,
    asset_results: assetResults.map((asset) => ({
      status: asset.status || (asset.dry_run ? 'dry_run' : 'recorded'),
      dry_run: Boolean(asset.dry_run),
      local_path: asset.local_path || null,
      filename: asset.filename || asset.verification?.filename || null,
      asset_folder_path: asset.asset_folder_path || null,
      bytes: asset.bytes || 0,
      source_sha256: asset.source_sha256 || null,
      id: asset.id || asset.verification?.id || null,
      verification: asset.verification || null
    })),
    link_summary: linkSummary
  };
}

function summarizeRouteHandoff(data, artifact) {
  return {
    type: 'route_handoff',
    artifact,
    status: data.status || 'recorded',
    dry_run: Boolean(data.dry_run),
    total_routes: data.summary?.total || ensureArray(data.routes).length,
    created: data.summary?.created || 0,
    would_create: data.summary?.would_create || 0,
    blocked: data.summary?.blocked || 0,
    skipped: data.summary?.skipped || 0,
    manual_handoff_routes: ensureArray(data.routes).filter((route) => route.manual_handoff).length,
    route_collision_status: data.route_collision_analysis?.status || null,
    route_collision_blocked: data.route_collision_analysis?.summary?.blocked || 0,
    route_collision_warnings: data.route_collision_analysis?.summary?.warnings || 0,
    markdown_report: data.markdown_report || null
  };
}

function summarizeRouteHandoffChecklist(data, artifact) {
  return {
    type: 'route_handoff_checklist',
    artifact,
    status: data.status || 'recorded',
    integration_id: data.integration_id || null,
    framework: data.framework || null,
    automatic_route_handoff_supported: Boolean(data.automatic_route_handoff_supported),
    manual_route_handoff_required: Boolean(data.manual_route_handoff_required),
    routes: data.summary?.routes || ensureArray(data.routes).length,
    ready_routes: data.summary?.ready_routes || 0,
    manual_routes: data.summary?.manual_routes || 0,
    blocked_routes: data.summary?.blocked_routes || 0,
    warning_routes: data.summary?.warning_routes || 0,
    checklist_items: data.summary?.checklist_items || 0,
    manual_checklist_items: data.summary?.manual_checklist_items || 0,
    next_commands: ensureArray(data.next_steps).length,
    markdown_report: data.markdown_report || null
  };
}

function summarizeRouteCollisionAnalysis(data, artifact) {
  return {
    type: 'route_collision_analysis',
    artifact,
    status: data.status || 'recorded',
    framework: data.framework || null,
    total_routes: data.summary?.routes || ensureArray(data.routes).length,
    blocked: data.summary?.blocked || 0,
    warnings: data.summary?.warnings || 0,
    exact_route_file_collisions: data.summary?.exact_route_file_collisions || 0,
    dynamic_route_overlaps: data.summary?.dynamic_route_overlaps || 0,
    rewrite_overlaps: data.summary?.rewrite_overlaps || 0,
    existing_route_files: data.summary?.existing_route_files || 0,
    rewrite_rules: data.summary?.rewrite_rules || 0,
    markdown_report: data.markdown_report || null
  };
}

function summarizePlatformReadiness(data, artifact) {
  return {
    type: 'platform_readiness',
    artifact,
    status: data.status || 'recorded',
    integration_id: data.integration_id || null,
    framework: data.framework || null,
    automatic_route_handoff_supported: Boolean(data.automatic_route_handoff_supported),
    manual_route_handoff_required: Boolean(data.manual_route_handoff_required),
    failed_checks: data.summary?.failed_checks || ensureArray(data.checks).filter((check) => check.status === 'failed').length,
    warning_checks: data.summary?.warning_checks || ensureArray(data.checks).filter((check) => check.status === 'warning').length,
    routes: data.summary?.routes || ensureArray(data.routes).length,
    route_previews_available: data.summary?.route_previews_available || 0,
    route_proposals_available: data.summary?.route_proposals_available || 0,
    host_scripts_available: data.summary?.host_scripts_available || 0,
    markdown_report: data.markdown_report || null
  };
}

function summarizeHandoffEvidenceIndex(data, artifact) {
  return {
    type: 'handoff_evidence_index',
    artifact,
    status: data.status || 'recorded',
    integration_id: data.integration_id || null,
    required_total: data.summary?.required_total || 0,
    required_available: data.summary?.required_available || 0,
    required_missing: data.summary?.required_missing || 0,
    checklist_done: data.summary?.checklist_done || 0,
    checklist_blocked: data.summary?.checklist_blocked || 0,
    storyblok_draft_links: data.summary?.storyblok_draft_links || 0,
    route_previews: data.summary?.route_previews || 0,
    next_commands: ensureArray(data.next_commands).length,
    markdown_report: data.markdown_report || null
  };
}

function summarizeClientReviewGate(data, artifact) {
  return {
    type: 'client_review_gate',
    artifact,
    status: data.status || 'recorded',
    ready_for_apply: Boolean(data.ready_for_apply),
    ready_for_route_handoff: Boolean(data.ready_for_route_handoff),
    failed_checks: data.failed_checks || ensureArray(data.checks).filter((check) => check.status === 'failed').length,
    warning_checks: data.warning_checks || ensureArray(data.checks).filter((check) => check.status === 'warning').length,
    framework: data.framework || null,
    planned_repository_files: ensureArray(data.diff?.repository_files).length,
    planned_repository_assets: ensureArray(data.diff?.repository_assets).length,
    route_handoff_status: data.route_handoff_preview?.status || 'not_run',
    host_scripts_available: ensureArray(data.host_scripts).filter((script) => script.command).length
  };
}

function summarizeRemoteTransactionLedger(data, artifact) {
  const summary = data.summary || {};
  const rollbackScope = data.rollback_scope || {};
  return {
    type: 'remote_transaction_ledger',
    artifact,
    status: data.status || (data.safety?.unnamespaced_resources > 0 || data.safety?.published_stories > 0 ? 'failed' : 'recorded'),
    workflow: data.workflow || null,
    dry_run: Boolean(data.dry_run),
    transaction_count: data.transaction_count || ensureArray(data.transactions).length,
    created: summary.created || 0,
    already_exists: summary.already_exists || 0,
    updated_link_metadata: summary.updated_link_metadata || 0,
    skipped_optional: summary.skipped_optional || 0,
    rollback_allowed: summary.rollback_allowed || 0,
    remote_mutations: data.safety?.remote_mutations || 0,
    published_stories: data.safety?.published_stories || 0,
    unnamespaced_resources: data.safety?.unnamespaced_resources || 0,
    rollback_scope: Object.fromEntries(Object.entries(rollbackScope).map(([key, value]) => [key, ensureArray(value).length]))
  };
}

function summarizeAssetReferenceGraph(data, artifact) {
  const summary = data.summary || {};
  return {
    type: 'asset_reference_graph',
    artifact,
    status: data.status || 'recorded',
    asset_nodes: summary.asset_nodes || ensureArray(data.assets).length,
    story_asset_fields: summary.story_asset_fields || ensureArray(data.story_usages).length,
    resolved_story_asset_fields: summary.resolved_story_asset_fields || 0,
    unresolved_story_asset_fields: summary.unresolved_story_asset_fields || 0,
    uploaded_or_reused: summary.uploaded_or_reused || 0,
    remote_unresolved_asset_fields: summary.remote_unresolved_asset_fields || 0
  };
}

function summarizeRollbackArtifact(data, artifact, type) {
  const ledger = data.rollback_ledger || {};
  return {
    type,
    artifact,
    status: data.action || type,
    dry_run: Boolean(data.dry_run),
    integration_id: data.integration_id || ledger.integration_id || null,
    local_targets: ledger.local?.targets || ensureArray(data.repository_files_to_remove).length || ensureArray(data.repository_files_removed).length,
    local_removed: ledger.local?.removed?.length || ensureArray(data.repository_files_removed).length,
    local_missing: ledger.local?.missing?.length || ensureArray(data.repository_files_missing).length,
    remote_targets: ledger.remote?.total_targets || 0,
    remote_requested: Boolean(ledger.remote?.requested),
    hash_status: ledger.local?.hash_verification?.status || data.repository_file_hash_verification?.status || 'not_run',
    risk_flags: ensureArray(ledger.risk_flags).length,
    risk_flag_names: ensureArray(ledger.risk_flags).slice(0, 10)
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

function renderNextActionRows(report) {
  const actions = ensureArray(report.next_actions?.actions);
  if (actions.length === 0) return '- None recorded';
  return actions
    .slice(0, 8)
    .map((action) => `- ${action.label}: ${action.reason}${action.command ? `\n  \`${action.command}\`` : ''}`)
    .join('\n');
}

function storyblokManagementVerificationRows(report) {
  const verification = report.latest_storyblok_management_verification;
  if (!verification) return ['- Not run'];
  return [
    `- Status: ${verification.status || 'recorded'}`,
    `- Story checks: ${verification.story_checks || 0}`,
    `- Failed story checks: ${verification.failed_story_checks || 0}`,
    `- Content drifted stories: ${verification.content_drifted_stories || 0}`,
    `- Unresolved story links: ${verification.unresolved_generated_story_links || 0}`,
    `- Unresolved asset fields: ${verification.unresolved_asset_fields || 0}`
  ];
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
