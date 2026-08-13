import { getDesktopActions } from './desktop-actions.js';

const FIELD_GUIDANCE = {
  workDir: {
    label: 'Work directory',
    help: 'Where manifests, reports, dry-run output, and handoff evidence are stored.'
  },
  templatePath: {
    label: 'Template folder',
    help: 'The HTML template folder to inspect and convert.'
  },
  repoPath: {
    label: 'Target repository',
    help: 'The existing site repository. Required only for full repository imports and route handoff checks.'
  },
  manifestPath: {
    label: 'Manifest path',
    help: 'The generated integration manifest that drives validation, apply, evidence, and rollback.'
  },
  integrationId: {
    label: 'Integration ID',
    help: 'Unique import name used for Storyblok prefixes, draft story folders, CSS roots, and repository namespaces.'
  },
  framework: {
    label: 'Framework',
    help: 'Use auto for repository detection, or pick the target framework when running without a detected repository.'
  },
  route: {
    label: 'Route filter',
    help: 'Optional route name for route handoff checks when reviewing one imported page at a time.'
  }
};

const SAFETY_GUIDANCE = {
  'read-only': 'Reads local files or remote state only. It should not create, edit, publish, or delete project resources.',
  'local-write': 'Writes local evidence or generated files inside the configured work directory or integration namespace.',
  'dry-run': 'Previews the operations and evidence without creating repository or Storyblok resources.',
  'remote-write': 'Creates namespaced Storyblok draft resources only. It does not publish content or alter existing components.',
  'local-and-remote-write': 'Creates isolated repository files and namespaced Storyblok draft resources after safety gates pass.'
};

const ACTION_GUIDANCE = {
  onboarding: guidance(
    ['Run this first on a new workstation or before onboarding a team member.'],
    ['No project inputs are required.'],
    ['onboarding-guide.md'],
    ['If setup is incomplete, follow the generated checklist before planning an import.']
  ),
  dashboard: guidance(
    ['Use this to understand the latest local integration state before resuming work.'],
    ['Select the work directory that contains the integration artifacts you want to review.'],
    ['dashboard terminal summary'],
    ['If the dashboard says attention is needed, open the report and evidence index next.']
  ),
  doctorFull: guidance(
    ['Use before a full repository import to check local tools, repository health, Storyblok, and optional services.'],
    ['Choose the target repository and provide session credentials when remote checks are needed.'],
    ['doctor report in terminal output'],
    ['Missing Git, package manager, or credentials should be fixed before planning a client import.']
  ),
  doctorStoryblok: guidance(
    ['Use before Storyblok-only testing when no target repository is available.'],
    ['Provide Management API token, Space ID, Preview token, and region when available.'],
    ['doctor report in terminal output'],
    ['Remote credential failures do not change the Storyblok space; correct credentials and rerun.']
  ),
  inspectTemplate: guidance(
    ['Checks pages, assets, scripts, forms, headings, links, and import warnings from the template folder.'],
    ['Choose a template folder that contains HTML entry files and local assets.'],
    ['template inspection summary'],
    ['Blocked templates usually need missing assets or unsafe script references fixed before planning.']
  ),
  templateQuality: guidance(
    ['Scores template readiness so design issues can be returned before import work begins.'],
    ['Choose the template folder and run after template inspection.'],
    ['template-quality.json', 'template-readiness.md'],
    ['Low scores should be resolved with the design/source template owner.']
  ),
  inspectRepository: guidance(
    ['Detects framework, package manager, Storyblok packages, route files, Netlify config, and build commands.'],
    ['Choose the target repository. The command is read-only.'],
    ['repository inspection summary'],
    ['If detection is inconclusive, choose the framework manually before planning.']
  ),
  inspectStoryblok: guidance(
    ['Reviews the target Storyblok space through the Management API without printing secrets.'],
    ['Provide session credentials or environment variables for Management API access.'],
    ['Storyblok inspection summary'],
    ['Optional Management API collections can be unavailable on some spaces; the CLI marks those as not queried.']
  ),
  planFull: guidance(
    ['Creates the full additive manifest for repository files, Storyblok schemas, assets, presets, and draft stories.'],
    ['Choose template, repository, integration ID, and framework. Keep the integration ID unique per template import.'],
    ['integration-manifest.json'],
    ['Planning fails on unsafe names, invalid routes, or a repository that cannot be inspected when framework is auto.']
  ),
  planStoryblokOnly: guidance(
    ['Creates a manifest for Storyblok-only testing without requiring a client repository.'],
    ['Choose template and integration ID. Use static framework unless testing a specific renderer shape.'],
    ['integration-manifest.json'],
    ['Use this workflow when proving components, assets, links, and draft stories before repository handoff.']
  ),
  validatePlan: guidance(
    ['Validates additive-only policy, namespacing, route safety, and Storyblok ownership boundaries.'],
    ['Run after planning and before any dry run or real apply.'],
    ['plan-validation.json'],
    ['Do not continue to apply if validation fails. Fix the plan or template first.']
  ),
  previewDiff: guidance(
    ['Shows which generated repository files would be created and whether they already exist.'],
    ['Choose manifest and target repository.'],
    ['repository diff summary'],
    ['Existing non-generated files must never be overwritten; resolve collisions before apply.']
  ),
  clientReview: guidance(
    ['Creates a read-only review gate for an existing client site before local or remote writes.'],
    ['Choose manifest and target repository after plan validation passes.'],
    ['client-review-gate-report.md'],
    ['Treat failed review gates as blockers until the report is resolved.']
  ),
  platformReadiness: guidance(
    ['Checks whether the detected platform can host the generated integration and live draft preview handoff.'],
    ['Choose manifest and target repository.'],
    ['platform-readiness-report.md'],
    ['Manual-router frameworks may require handoff notes rather than automatic route files.']
  ),
  routeChecklist: guidance(
    ['Creates route-by-route acceptance checks for imported pages.'],
    ['Choose manifest and repository. Optionally set a route filter.'],
    ['route-handoff-checklist.md'],
    ['Use this before connecting preview URLs or asking QA to review imported pages.']
  ),
  storyblokDryRun: guidance(
    ['Previews component folders, components, asset folders, assets, presets, and draft stories.'],
    ['Run after plan validation. Provide session credentials for remote access checks.'],
    ['storyblok-apply-result.json', 'remote-transaction-ledger.json'],
    ['A dry run with unresolved links is safe, but links should be reviewed before final handoff.']
  ),
  storyblokApply: guidance(
    ['Creates namespaced Storyblok resources as drafts and uploads planned assets.'],
    ['Run only after Storyblok dry run passes and the confirmation prompt is accepted.'],
    ['storyblok-apply-result.json', 'storyblok-draft-stories-result.json', 'remote-transaction-ledger.json'],
    ['If drift is detected, use recovery or rollback preview. Existing non-matching drafts are not overwritten.']
  ),
  fullDryRun: guidance(
    ['Previews local repository generation and Storyblok remote operations together.'],
    ['Run after plan validation and client review.'],
    ['apply-result.json', 'report.md'],
    ['Resolve repository collisions, host baseline failures, or unresolved Storyblok links before real apply.']
  ),
  fullApply: guidance(
    ['Runs the full additive import against the target repository and Storyblok space.'],
    ['Run after full dry run passes. Confirm the safety prompt and keep credentials session-only.'],
    ['apply-result.json', 'report.md', 'storyblok-management-verification.json'],
    ['If a later remote step fails, the ledger and rollback preview show exactly what was created.']
  ),
  wireRoutesDryRun: guidance(
    ['Previews framework route handoff files without writing host routes.'],
    ['Choose manifest and repository after generated integration files exist.'],
    ['route-handoff-report.md'],
    ['Route collisions must be resolved manually; automatic route writing remains additive-only.']
  ),
  wireRoutesApply: guidance(
    ['Creates additive route handoff files when the target framework and safety gates allow it.'],
    ['Run after route dry run and route checklist have been reviewed.'],
    ['route-handoff-report.md'],
    ['The command refuses to overwrite an existing route file.']
  ),
  validateLocal: guidance(
    ['Validates generated repository files, hash ledgers, runtime coupling, and adapter output.'],
    ['Choose manifest and repository after a real repository apply.'],
    ['validation-result.json'],
    ['Failures usually mean generated files were edited or a required host adapter file is missing.']
  ),
  validateStoryblok: guidance(
    ['Uses the Content API to validate draft stories, asset fields, and generated internal links.'],
    ['Provide Preview API token and run after Storyblok apply.'],
    ['storyblok-content-validation.json'],
    ['Missing UUIDs or unresolved story links should be fixed before editor/client handoff.']
  ),
  storyblokVerify: guidance(
    ['Uses the Management API to verify created folders, components, presets, assets, and draft stories.'],
    ['Provide Management API credentials and run after Storyblok apply.'],
    ['storyblok-management-verification.json'],
    ['Verification drift means the remote draft no longer matches the manifest and should be reviewed.']
  ),
  report: guidance(
    ['Generates the main Markdown report from manifest, validation, apply, and evidence artifacts.'],
    ['Run whenever you need a current written summary.'],
    ['report.md'],
    ['Missing evidence sections mean the related command has not been run yet.']
  ),
  reportHtml: guidance(
    ['Generates a browser-friendly HTML report for non-technical review.'],
    ['Run after report evidence exists.'],
    ['report.html'],
    ['Use the Markdown report if the HTML artifact is unavailable.']
  ),
  evidenceIndex: guidance(
    ['Creates a compact index of required evidence and whether each artifact is present.'],
    ['Choose the manifest, and repository when repository evidence matters.'],
    ['handoff-evidence-index.md'],
    ['Use missing entries as the next-action checklist before sign-off.']
  ),
  handoffPack: guidance(
    ['Builds a production handoff pack for David, QA, editors, or client review.'],
    ['Run after validation, apply, route checks, and reports are complete.'],
    ['production-handoff-pack.md'],
    ['The pack should not be treated as complete while required evidence is marked missing.']
  ),
  rollbackPreview: guidance(
    ['Shows exactly which integration-owned resources rollback would target without deleting anything.'],
    ['Choose the manifest. Add repository path when local generated files should be included.'],
    ['rollback-preview.json'],
    ['Rollback must remain explicit and should never target production or non-namespaced content.']
  ),
  visualEditorReadiness: guidance(
    ['Checks whether Storyblok Visual Editor preview requirements are documented and ready.'],
    ['Choose manifest and optionally the repository with generated preview adapters.'],
    ['visual-editor-readiness-report.md'],
    ['Non-HTTPS or missing preview URLs should be resolved before editor testing.']
  )
};

export function getDesktopGuidance() {
  return getDesktopActions().map((action) => createActionGuidance(action));
}

export function findDesktopGuidance(actionId) {
  return getDesktopGuidance().find((entry) => entry.action_id === actionId) || null;
}

export function fieldGuidance(field) {
  return FIELD_GUIDANCE[field] || {
    label: field,
    help: 'Required before this action can run.'
  };
}

function createActionGuidance(action) {
  const detail = ACTION_GUIDANCE[action.id] || guidance(
    [action.description],
    ['Review the command preview before running.'],
    ['terminal output'],
    ['If the command fails, open the report or evidence index for the next action.']
  );

  return {
    action_id: action.id,
    title: action.title,
    group: action.group,
    summary: action.description,
    command: action.command,
    safety: {
      level: action.safety,
      description: SAFETY_GUIDANCE[action.safety] || 'Review the command preview before running.'
    },
    requirements: action.requirements.map((field) => ({
      field,
      ...fieldGuidance(field)
    })),
    before_run: detail.before_run,
    evidence: detail.evidence,
    recovery: detail.recovery
  };
}

function guidance(beforeRun, preconditions, evidence, recovery) {
  return {
    before_run: [...beforeRun, ...preconditions],
    evidence,
    recovery
  };
}
