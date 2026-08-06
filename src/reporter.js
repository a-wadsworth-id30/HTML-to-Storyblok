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
    latest_netlify: latestNetlify,
    safety_confirmation: {
      plan_valid: latestValidation?.status === 'passed' || latestValidation?.valid === true,
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
  const latestNetlify = report.latest_netlify?.status || 'not run';
  const artifactRows = report.artifacts.length
    ? report.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.artifact}`).join('\n')
    : '- None recorded';
  const failureRows = report.commands_failed.length
    ? report.commands_failed.map((failure) => `- ${failure.command}: ${failure.message}`).join('\n')
    : '- None';

  return `# HTML-to-Storyblok Report

## Summary

- Work directory: ${report.work_dir}
- Evidence entries: ${report.evidence_entries}
- Commands completed: ${report.commands_completed}
- Latest validation: ${latestValidation}
- Latest Netlify: ${latestNetlify}

## Safety

- Plan valid: ${report.safety_confirmation.plan_valid ? 'yes' : 'no'}
- Deploy preview verified: ${report.safety_confirmation.deploy_preview_verified ? 'yes' : 'no'}
- Unresolved failures: ${report.safety_confirmation.unresolved_failures}
- Secret handling: ${report.safety_confirmation.command_argument_redaction}

## Artifacts

${artifactRows}

## Failures

${failureRows}
`;
}

async function summarizeArtifact(artifact) {
  const name = artifact.split('/').at(-1);
  try {
    const data = await readJson(artifact);
    if (name === 'integration-manifest.json') {
      return {
        type: 'integration_manifest',
        artifact,
        integration_id: data.integration_id,
        repository_files: data.repository?.files_to_create?.length || 0,
        storyblok_components: data.storyblok?.components_to_create?.length || 0,
        storyblok_stories: data.storyblok?.stories_to_create?.length || 0,
        storyblok_assets: data.storyblok?.assets_to_create?.length || 0
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

function latestSummary(summaries, types) {
  return [...summaries].reverse().find((summary) => types.includes(summary.type)) || null;
}
