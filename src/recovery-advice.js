import path from 'node:path';
import { DEFAULT_WORK_DIR } from './evidence.js';

const MANIFEST_NAME = 'integration-manifest.json';

export function createRecoveryAdvice({ error, action = 'unknown', manifest = null, workDir = DEFAULT_WORK_DIR } = {}) {
  const message = redactCredentialError(error?.message || String(error || 'Unknown error'));
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  const commonCommands = [
    `html-to-storyblok view-report --work-dir ${workDir}`,
    manifest ? `html-to-storyblok validate-plan --manifest ${manifestPath}` : null
  ].filter(Boolean);
  const base = {
    code: 'HTS_RECOVERY_GENERIC',
    problem: 'The selected CLI action did not complete.',
    likely_cause: 'The command failed before the workflow reached a confirmed safe completion point.',
    recommended_fix: 'Review the report, validate the current plan, then retry or return to the main menu.',
    affected_resource: null,
    actions: ['retry', 'report'],
    commands: commonCommands
  };

  const driftMatch = message.match(/Storyblok draft story drift detected for\s+([^;()\s]+)/i);
  if (driftMatch) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_DRAFT_DRIFT',
      problem: 'A generated draft story already exists but does not match the current manifest.',
      likely_cause: 'The same integration ID was reused after the Storyblok draft was edited or generated from an older plan.',
      recommended_fix: 'Use a new integration ID for a fresh import, or inspect rollback targets before removing integration-owned drafts.',
      affected_resource: driftMatch[1],
      actions: ['details', 'start-new', 'rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-reconcile --manifest ${manifestPath}`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/429|rate limit/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_RATE_LIMIT',
      problem: 'Storyblok rate-limited the Management API requests.',
      likely_cause: 'The space rejected requests faster than its current API allowance.',
      recommended_fix: 'Wait briefly and retry. If this repeats, increase STORYBLOK_REQUEST_INTERVAL_MS or lower the request rate for this session.',
      actions: ['retry', 'report'],
      commands: [
        `STORYBLOK_REQUEST_INTERVAL_MS=250 html-to-storyblok storyblok-apply --manifest ${manifestPath} --dry-run`,
        ...commonCommands
      ]
    };
  }

  if (/credential|token|space id|Management API credentials|Storyblok credentials unavailable/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_CREDENTIALS',
      problem: 'Storyblok credentials are missing or not valid for the requested action.',
      likely_cause: 'The Management token, Space ID, region, or Preview token is missing, expired, or does not have enough access.',
      recommended_fix: 'Run the credential test, enter values for this session, or set them in .env.local without committing secrets.',
      actions: ['credentials', 'retry', 'report'],
      commands: [
        'html-to-storyblok env --init',
        'html-to-storyblok doctor',
        ...commonCommands
      ]
    };
  }

  const storyblokPreflightMatch = message.match(/Storyblok preflight failed(?::\s*(.+))?/i);
  if (storyblokPreflightMatch) {
    const check = storyblokPreflightMatch[1] || 'remote access';
    return {
      ...base,
      code: 'HTS_STORYBLOK_PREFLIGHT',
      problem: 'Storyblok preflight checks failed before remote resources were changed.',
      likely_cause: `The failed check was ${check}. The token may not have the required permission, or an optional API area may be unavailable for the space.`,
      recommended_fix: 'Review the preflight artifact and credentials. Retry only after the failed check is understood.',
      affected_resource: check,
      actions: ['details', 'credentials', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-preflight --manifest ${manifestPath}`,
        'html-to-storyblok doctor',
        ...commonCommands
      ]
    };
  }

  const repositoryPreflightMatch = message.match(/repository preflight failed(?::\s*(.+))?/i);
  if (repositoryPreflightMatch) {
    const check = repositoryPreflightMatch[1] || 'repository safety';
    return {
      ...base,
      code: 'HTS_REPOSITORY_PREFLIGHT',
      problem: 'Repository safety checks failed before generated files were written.',
      likely_cause: check.includes('planned_targets_available')
        ? 'One or more planned generated target files already exists in the selected repository.'
        : `The failed repository check was ${check}.`,
      recommended_fix: 'Choose the intended repository, use a new integration ID, or inspect the planned targets before retrying.',
      affected_resource: check,
      actions: ['details', 'start-new', 'retry', 'report'],
      commands: [
        `html-to-storyblok repository-preflight --manifest ${manifestPath} --repo <repo-path>`,
        `html-to-storyblok diff --manifest ${manifestPath} --repo <repo-path>`,
        ...commonCommands
      ]
    };
  }

  if (/host repository checks failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_HOST_CHECKS',
      problem: 'The host repository checks failed.',
      likely_cause: 'A lint, typecheck, build, or post-generation validation script failed.',
      recommended_fix: 'Open the generated report, fix the host check failure in the selected repository, then retry the apply.',
      actions: ['retry', 'report'],
      commands: [
        'html-to-storyblok build --repo <repo-path> --script build',
        `html-to-storyblok validate --manifest ${manifestPath} --repo <repo-path>`,
        ...commonCommands
      ]
    };
  }

  if (/Content API validation failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_CONTENT_VALIDATION',
      problem: 'Storyblok draft content was created, but Content API validation failed.',
      likely_cause: 'Drafts remain unpublished for review; the Preview token, links, assets, or draft availability may need inspection.',
      recommended_fix: 'View the report, inspect Storyblok links/assets, then run validation again before deciding whether to roll back.',
      actions: ['rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok validate-storyblok --manifest ${manifestPath} --version draft`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/Management API verification failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_MANAGEMENT_VERIFICATION',
      problem: 'Storyblok remote resources were created as drafts, but final Management API verification failed.',
      likely_cause: 'The remote state could not be verified after apply, often because of temporary API consistency, permissions, or drift.',
      recommended_fix: 'Run reconcile/verify, inspect the report, and use rollback preview before deleting integration-owned resources.',
      actions: ['rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-reconcile --manifest ${manifestPath}`,
        `html-to-storyblok storyblok-verify --manifest ${manifestPath}`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/manifest failed|additive-only|Policy|violations/i.test(message)) {
    return {
      ...base,
      code: 'HTS_POLICY_VALIDATION',
      problem: 'The plan failed the additive-only safety policy.',
      likely_cause: 'The manifest contains a planned mutation, collision, unnamespaced resource, or unsafe dependency.',
      recommended_fix: 'Review the first validation violation, adjust the plan or integration ID, then validate again.',
      actions: ['start-new', 'retry', 'report'],
      commands: commonCommands
    };
  }

  return {
    ...base,
    problem: `${labelForAction(action)} failed.`,
    likely_cause: message
  };
}

export function renderRecoveryAssistant(terminal, advice) {
  terminal.panel('Recovery Assistant', [
    ['Problem', advice.problem, 'error'],
    ['Error Code', advice.code, advice.code === 'HTS_RECOVERY_GENERIC' ? 'warning' : 'error'],
    ['Likely Cause', advice.likely_cause, 'warning'],
    ['Recommended Fix', advice.recommended_fix, 'info'],
    ['Affected Resource', advice.affected_resource || 'Not detected', advice.affected_resource ? 'warning' : 'info']
  ]);
  if (advice.commands.length > 0) {
    terminal.panel('Useful Commands', advice.commands.slice(0, 4).map((command, index) => [
      index === 0 ? 'First' : `Option ${index + 1}`,
      command,
      index === 0 ? 'success' : 'info'
    ]));
  }
}

export function renderRecoveryDetails(terminal, advice) {
  terminal.panel('Recovery Details', [
    ['Error Code', advice.code, advice.code === 'HTS_RECOVERY_GENERIC' ? 'warning' : 'error'],
    ['Affected Resource', advice.affected_resource || 'Not detected', advice.affected_resource ? 'warning' : 'info'],
    ['Recommended Fix', advice.recommended_fix, 'info'],
    ['Safety', 'No rollback or deletion runs automatically from this screen', 'success']
  ]);
}

function redactCredentialError(message) {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*[A-Za-z0-9._-]+/gi, 'Authorization: [REDACTED]')
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function labelForAction(action) {
  return labelForSetting(String(action || 'unknown').replaceAll('-', '_'));
}

function labelForSetting(key) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
