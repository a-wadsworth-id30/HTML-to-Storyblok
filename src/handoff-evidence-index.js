import path from 'node:path';
import { DEFAULT_WORK_DIR } from './evidence.js';
import { collectDraftEditorLinks, collectRepositoryRoutePreviews, readHandoffArtifacts } from './handoff-pack.js';
import { readIntegrationHistory } from './history.js';
import { createReport } from './reporter.js';
import { ensureArray, pathExists } from './utils.js';

const CORE_EVIDENCE = [
  {
    key: 'manifest',
    label: 'Integration Manifest',
    category: 'foundation',
    files: ['integration-manifest.json'],
    required: true,
    command: 'html-to-storyblok plan --integration-id <id> --template <path>'
  },
  {
    key: 'plan_validation',
    label: 'Plan Validation',
    category: 'foundation',
    files: ['plan-validation.json'],
    required: true,
    command: 'html-to-storyblok validate-plan --manifest .tmp/html-to-storyblok/integration-manifest.json'
  },
  {
    key: 'apply_result',
    label: 'Apply Result',
    category: 'execution',
    files: ['apply-result.json', 'storyblok-apply-result.json'],
    required: true,
    any: true,
    command: 'html-to-storyblok apply --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'main_report',
    label: 'Main Report',
    category: 'review',
    files: ['report.md'],
    required: true,
    command: 'html-to-storyblok report'
  },
  {
    key: 'rollback_preview',
    label: 'Rollback Preview',
    category: 'safety',
    files: ['rollback-preview.json'],
    required: true,
    command: 'html-to-storyblok rollback-preview --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'production_handoff_pack',
    label: 'Production Handoff Pack',
    category: 'review',
    files: ['production-handoff-pack.md', 'production-handoff-pack.json'],
    required: false,
    any: true,
    command: 'html-to-storyblok handoff-pack --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'storyblok_management',
    label: 'Storyblok Management Verification',
    category: 'storyblok',
    files: ['storyblok-management-verification.json'],
    required: false,
    command: 'html-to-storyblok storyblok-verify --manifest .tmp/html-to-storyblok/integration-manifest.json'
  },
  {
    key: 'storyblok_content',
    label: 'Storyblok Content Validation',
    category: 'storyblok',
    files: ['storyblok-content-validation.json'],
    required: false,
    command: 'html-to-storyblok validate-storyblok --manifest .tmp/html-to-storyblok/integration-manifest.json'
  },
  {
    key: 'asset_reference_graph',
    label: 'Asset Reference Graph',
    category: 'assets',
    files: ['asset-reference-graph.json'],
    required: false,
    command: 'html-to-storyblok asset-graph'
  },
  {
    key: 'client_review',
    label: 'Client Apply Review Gate',
    category: 'repository',
    files: ['client-review-gate.json', 'client-review-gate-report.md'],
    required: false,
    any: true,
    command: 'html-to-storyblok client-review --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'platform_readiness',
    label: 'Platform Readiness',
    category: 'repository',
    files: ['platform-readiness.json', 'platform-readiness-report.md'],
    required: false,
    any: true,
    command: 'html-to-storyblok platform-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'route_collision_analysis',
    label: 'Route Collision Analysis',
    category: 'repository',
    files: ['route-collision-analysis.json', 'route-collision-analysis-report.md'],
    required: false,
    any: true,
    command: 'html-to-storyblok route-collisions --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path>'
  },
  {
    key: 'route_handoff',
    label: 'Route Handoff',
    category: 'repository',
    files: ['route-handoff-result.json', 'route-handoff-report.md'],
    required: false,
    any: true,
    command: 'html-to-storyblok wire-routes --manifest .tmp/html-to-storyblok/integration-manifest.json --repo <repo-path> --dry-run'
  },
  {
    key: 'deployed_preview',
    label: 'Deployed Preview Evidence',
    category: 'deployment',
    files: ['netlify-preview.json', 'demo-sites-live-preview-result.json', 'demo-sites-e2e-result.json'],
    required: false,
    any: true,
    command: 'html-to-storyblok demo-sites-e2e --require-live --integration-id <id>'
  }
];

export async function createHandoffEvidenceIndex({
  manifest,
  workDir = DEFAULT_WORK_DIR,
  repoPath = null
} = {}) {
  if (!manifest) throw new Error('evidence-index requires a manifest');
  const report = await createReport(workDir);
  const artifacts = await readHandoffArtifacts(workDir);
  const history = await readIntegrationHistory(workDir, { limit: 5 });
  const latestApply = artifacts.apply_result || artifacts.storyblok_apply_result || null;
  const evidence = await buildEvidenceEntries(workDir);
  const draftLinks = collectDraftEditorLinks(latestApply);
  const routePreviews = collectRepositoryRoutePreviews(latestApply);
  const checklist = buildChecklist({ report, artifacts, latestApply, draftLinks, routePreviews });
  const nextCommands = buildNextCommands({ manifest, repoPath, evidence, checklist, report, routePreviews });
  const summary = summarizeIndex({ evidence, checklist, report, draftLinks, routePreviews, history });

  return {
    action: 'handoff_evidence_index',
    status: summary.status,
    generated_at: new Date().toISOString(),
    integration_id: manifest.integration_id,
    storyblok_prefix: manifest.storyblok_prefix,
    repository_namespace: manifest.repository_namespace,
    repository_path: repoPath || null,
    work_dir: workDir,
    summary,
    sign_off_checklist: checklist,
    evidence_files: evidence,
    review_links: {
      storyblok_drafts: draftLinks,
      route_previews: routePreviews,
      netlify_deploy_url: artifacts.netlify_preview?.deploy?.deploy_url || artifacts.netlify_preview?.deploys?.[0]?.deploy_url || report.latest_netlify?.deploy_url || null,
      live_demo_report: artifacts.demo_sites_e2e?.markdown_report || artifacts.demo_sites_live_preview?.preview_report || null,
      report: path.join(workDir, 'report.md'),
      production_handoff_pack: path.join(workDir, 'production-handoff-pack.md')
    },
    latest: {
      validation: report.latest_validation || null,
      storyblok_content_validation: report.latest_storyblok_validation || null,
      storyblok_management_verification: report.latest_storyblok_management_verification || null,
      asset_integrity: report.asset_integrity?.status || 'not_run',
      asset_reference_graph: report.asset_reference_graph?.status || 'not_run',
      client_review: report.latest_client_review_gate || null,
      platform_readiness: report.latest_platform_readiness || null,
      route_collision_analysis: report.latest_route_collision_analysis || null,
      route_handoff: report.latest_route_handoff || null,
      netlify: report.latest_netlify || null,
      remote_transaction_ledger: report.latest_remote_transaction_ledger || null,
      next_actions: report.next_actions || null
    },
    history: {
      total: history.total,
      latest_entries: ensureArray(history.entries).slice(0, 5).map((entry) => ({
        timestamp: entry.timestamp,
        integration_id: entry.integration_id,
        action: entry.action,
        status: entry.status,
        repository_path: entry.repository_path || null,
        manifest_snapshot: entry.manifest_snapshot || null
      }))
    },
    next_commands: nextCommands
  };
}

export function renderHandoffEvidenceIndexMarkdown(index) {
  return `# HTML-to-Storyblok Handoff Evidence Index

## Summary

- Status: ${index.status}
- Integration: ${index.integration_id || 'unknown'}
- Repository: ${index.repository_path || 'not supplied'}
- Work directory: ${index.work_dir}
- Required evidence: ${index.summary.required_available} / ${index.summary.required_total}
- Required missing: ${index.summary.required_missing}
- Checklist done: ${index.summary.checklist_done} / ${index.summary.checklist_total}
- Checklist blocked: ${index.summary.checklist_blocked}
- Storyblok draft links: ${index.summary.storyblok_draft_links}
- Route previews: ${index.summary.route_previews}
- Unresolved failures: ${index.summary.unresolved_failures}

## Sign-Off Checklist

${ensureArray(index.sign_off_checklist).map((item) => `- [${item.status === 'done' ? 'x' : ' '}] ${item.label}: ${item.detail}`).join('\n')}

## Evidence Files

${renderEvidenceGroups(index.evidence_files)}

## Review Links

${renderReviewLinks(index.review_links)}

## Next Commands

${ensureArray(index.next_commands).map((command) => `- ${command.reason}\n  \`${command.command}\``).join('\n') || '- No next commands required by this index.'}
`;
}

async function buildEvidenceEntries(workDir) {
  return Promise.all(CORE_EVIDENCE.map(async (entry) => {
    const files = await Promise.all(entry.files.map(async (file) => {
      const absolute = path.join(workDir, file);
      return {
        path: absolute,
        relative_path: file,
        available: await pathExists(absolute)
      };
    }));
    const available = entry.any
      ? files.some((file) => file.available)
      : files.every((file) => file.available);
    return {
      key: entry.key,
      label: entry.label,
      category: entry.category,
      required: Boolean(entry.required),
      status: available ? 'available' : 'missing',
      files,
      command: entry.command
    };
  }));
}

function buildChecklist({ report, artifacts, latestApply, draftLinks, routePreviews }) {
  const safety = report.safety_confirmation || {};
  return [
    checklistItem('Additive-only plan passed', safety.plan_valid, safety.plan_valid ? 'Plan validation evidence is available.' : 'Run validate-plan and resolve additive-only violations.', true),
    checklistItem('Real apply result recorded', latestApply && !latestApply.dry_run, latestApply?.dry_run ? 'Only a dry run is recorded.' : latestApply ? 'Real apply evidence is available.' : 'Run a real apply after dry-run approval.', true),
    checklistItem('Storyblok draft links available', draftLinks.length > 0, draftLinks.length ? `${draftLinks.length} draft editor link(s) recorded.` : 'No Storyblok draft editor links recorded yet.', false),
    checklistItem('Storyblok Management verification passed', safety.storyblok_management_valid, safety.storyblok_management_valid ? 'Management verification is clean.' : 'Run storyblok-verify or review intentional skipped state.', false),
    checklistItem('Storyblok Content API validation passed or skipped intentionally', safety.storyblok_content_valid, safety.storyblok_content_valid ? 'Content validation is passed or intentionally skipped.' : 'Run validate-storyblok with a preview token.', false),
    checklistItem('Asset reference graph has no unresolved story fields', safety.asset_reference_graph_valid, safety.asset_reference_graph_valid ? 'Asset graph is passed or pending.' : 'Run asset-graph and resolve unresolved story asset fields.', false),
    checklistItem('Platform readiness reviewed', Boolean(artifacts.platform_readiness || report.latest_platform_readiness), report.latest_platform_readiness?.status ? `Platform readiness status is ${report.latest_platform_readiness.status}.` : 'Run platform-readiness before exposing imported routes.', false),
    checklistItem('Route collision and handoff reviewed', Boolean(artifacts.route_handoff || report.latest_route_handoff || artifacts.route_collision_analysis || report.latest_route_collision_analysis), routePreviews.length ? 'Route preview evidence exists; route handoff should be reviewed before live URLs are exposed.' : 'No repository route preview evidence recorded.', false),
    checklistItem('Rollback preview available', Boolean(artifacts.rollback_preview), artifacts.rollback_preview ? 'Rollback scope evidence is available.' : 'Run rollback-preview before client handoff.', true),
    checklistItem('Deployed preview or demo evidence available', Boolean(artifacts.netlify_preview || artifacts.demo_sites_live_preview || artifacts.demo_sites_e2e), 'Record deployed preview evidence once the client/site preview is online.', false),
    checklistItem('No unresolved command failures', Number(safety.unresolved_failures || 0) === 0, `${safety.unresolved_failures || 0} unresolved command failure(s) recorded.`, true)
  ];
}

function checklistItem(label, done, detail, blocking = false) {
  return {
    label,
    status: done ? 'done' : blocking ? 'blocked' : 'pending',
    blocking,
    detail
  };
}

function summarizeIndex({ evidence, checklist, report, draftLinks, routePreviews, history }) {
  const required = evidence.filter((entry) => entry.required);
  const requiredMissing = required.filter((entry) => entry.status !== 'available').length;
  const blockedChecklist = checklist.filter((entry) => entry.blocking && entry.status !== 'done').length;
  const unresolvedFailures = Number(report.safety_confirmation?.unresolved_failures || 0);
  const status = blockedChecklist > 0 || unresolvedFailures > 0
    ? 'attention'
    : requiredMissing > 0
      ? 'incomplete'
      : 'ready';
  return {
    status,
    required_total: required.length,
    required_available: required.length - requiredMissing,
    required_missing: requiredMissing,
    optional_available: evidence.filter((entry) => !entry.required && entry.status === 'available').length,
    optional_missing: evidence.filter((entry) => !entry.required && entry.status !== 'available').length,
    checklist_total: checklist.length,
    checklist_done: checklist.filter((entry) => entry.status === 'done').length,
    checklist_blocked: checklist.filter((entry) => entry.status === 'blocked').length,
    checklist_pending: checklist.filter((entry) => entry.status === 'pending').length,
    storyblok_draft_links: draftLinks.length,
    route_previews: routePreviews.length,
    unresolved_failures: unresolvedFailures,
    history_entries: history.total || 0
  };
}

function buildNextCommands({ manifest, repoPath, evidence, checklist, report, routePreviews }) {
  const manifestPath = '.tmp/html-to-storyblok/integration-manifest.json';
  const repoArg = repoPath ? ` --repo ${repoPath}` : ' --repo <repo-path>';
  const commands = [];
  for (const entry of evidence.filter((item) => item.required && item.status !== 'available')) {
    commands.push({
      id: `create-${entry.key}`,
      reason: `${entry.label} evidence is missing.`,
      command: hydrateCommand(entry.command, { manifest, manifestPath, repoArg })
    });
  }
  if (routePreviews.length > 0 && !report.latest_platform_readiness) {
    commands.push({
      id: 'platform-readiness',
      reason: 'Generated route previews exist; platform readiness has not been indexed yet.',
      command: `html-to-storyblok platform-readiness --manifest ${manifestPath}${repoArg}`
    });
  }
  if (routePreviews.length > 0 && !report.latest_route_handoff) {
    commands.push({
      id: 'route-handoff',
      reason: 'Generated route previews exist; route handoff evidence is missing.',
      command: `html-to-storyblok wire-routes --manifest ${manifestPath}${repoArg} --dry-run`
    });
  }
  if (checklist.some((item) => item.label === 'Deployed preview or demo evidence available' && item.status !== 'done')) {
    commands.push({
      id: 'deployed-preview',
      reason: 'Deployed preview evidence has not been recorded.',
      command: `html-to-storyblok demo-sites-e2e --require-live --integration-id ${manifest.integration_id || '<integration-id>'}`
    });
  }
  if (!evidence.some((entry) => entry.key === 'production_handoff_pack' && entry.status === 'available')) {
    commands.push({
      id: 'handoff-pack',
      reason: 'Production handoff pack has not been generated.',
      command: `html-to-storyblok handoff-pack --manifest ${manifestPath}${repoPath ? repoArg : ''}`
    });
  }
  return dedupeCommands(commands);
}

function hydrateCommand(command, { manifest, manifestPath, repoArg }) {
  return String(command)
    .replaceAll('.tmp/html-to-storyblok/integration-manifest.json', manifestPath)
    .replaceAll('--repo <repo-path>', repoArg.trim())
    .replaceAll('<id>', manifest.integration_id || '<id>')
    .replaceAll('<integration-id>', manifest.integration_id || '<integration-id>');
}

function dedupeCommands(commands) {
  const seen = new Set();
  return commands.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
}

function renderEvidenceGroups(evidence) {
  const groups = [...new Set(ensureArray(evidence).map((entry) => entry.category))];
  return groups.map((group) => {
    const rows = evidence.filter((entry) => entry.category === group)
      .map((entry) => `- ${entry.status === 'available' ? 'Available' : 'Missing'}: ${entry.label}${entry.required ? ' (required)' : ''} - ${entry.files.map((file) => `\`${file.path}\``).join(', ')}`)
      .join('\n');
    return `### ${titleCase(group)}\n\n${rows}`;
  }).join('\n\n');
}

function renderReviewLinks(links) {
  const storyLinks = ensureArray(links.storyblok_drafts);
  const routePreviews = ensureArray(links.route_previews);
  return [
    storyLinks.length
      ? storyLinks.map((entry) => `- Storyblok draft ${entry.slug}: ${entry.editor_url}`).join('\n')
      : '- Storyblok drafts: no editor links recorded.',
    routePreviews.length
      ? routePreviews.map((entry) => `- Route preview ${entry.suggested_site_path || entry.slug}: ${entry.preview_file || 'not recorded'}`).join('\n')
      : '- Route previews: no repository route preview evidence recorded.',
    links.netlify_deploy_url ? `- Netlify deploy: ${links.netlify_deploy_url}` : '- Netlify deploy: not recorded.',
    links.live_demo_report ? `- Live demo report: ${links.live_demo_report}` : '- Live demo report: not recorded.',
    `- Main report: ${links.report}`,
    `- Production handoff pack: ${links.production_handoff_pack}`
  ].join('\n');
}

function titleCase(value) {
  return String(value || '')
    .replaceAll(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
