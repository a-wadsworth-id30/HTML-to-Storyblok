import { getDesktopActions } from './desktop-actions.js';

const FIELD_GUIDANCE = {
  workDir: {
    label: 'Save location',
    help: 'Where this import keeps its plan, reports, previews, and review files.'
  },
  templatePath: {
    label: 'Template',
    help: 'The folder that contains the HTML pages and assets you want to import.'
  },
  repoPath: {
    label: 'Existing site',
    help: 'The site folder to add the import to. Leave this empty for a Storyblok-only test.'
  },
  manifestPath: {
    label: 'Plan file',
    help: 'The saved plan that tells the app what belongs to this import.'
  },
  integrationId: {
    label: 'Import name',
    help: 'A unique name that keeps this import separate from other templates on the same site.'
  },
  framework: {
    label: 'Site type',
    help: 'Use auto when a site is selected, or pick the type when testing without a site.'
  },
  route: {
    label: 'Review one page',
    help: 'Optional page name when you only want to review one imported page.'
  }
};

const SAFETY_GUIDANCE = {
  'read-only': 'Checks information only. It should not create, edit, publish, or delete anything.',
  'local-write': 'Creates local review files or generated files that belong only to this import.',
  'dry-run': 'Shows what would happen without creating site or Storyblok resources.',
  'remote-write': 'Creates Storyblok draft items for this import only. It does not publish or alter existing components.',
  'local-and-remote-write': 'Creates isolated site files and Storyblok draft items only after safety checks pass.'
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
    ['Select the save location that contains the import you want to review.'],
    ['dashboard terminal summary'],
    ['If the dashboard says attention is needed, open the report and evidence index next.']
  ),
  doctorFull: guidance(
    ['Use before adding a template to a site to check local tools, site health, Storyblok, and optional services.'],
    ['Choose the existing site and provide session access when remote checks are needed.'],
    ['doctor report in terminal output'],
    ['Missing Git, package manager, or credentials should be fixed before planning a client import.']
  ),
  doctorStoryblok: guidance(
    ['Use before Storyblok-only testing when no existing site is available.'],
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
    ['Checks what kind of site was selected and whether it is ready for a safe import.'],
    ['Choose the existing site. The command only reads information.'],
    ['site inspection summary'],
    ['If detection is inconclusive, choose the framework manually before planning.']
  ),
  inspectStoryblok: guidance(
    ['Reviews the target Storyblok space through the Management API without printing secrets.'],
    ['Provide session credentials or environment variables for Management API access.'],
    ['Storyblok inspection summary'],
    ['Some Storyblok account details may be unavailable on certain spaces; the app marks those as not checked.']
  ),
  planFull: guidance(
    ['Creates the safe import plan for site files, Storyblok blocks, images, and draft pages.'],
    ['Choose template, existing site, import name, and site type. Keep the import name unique per template.'],
    ['integration-manifest.json'],
    ['Planning stops on unsafe names, invalid pages, or a site that cannot be checked while site type is auto.']
  ),
  planStoryblokOnly: guidance(
    ['Creates a Storyblok-only plan without needing a client site.'],
    ['Choose template and import name. Use static site type unless testing a specific site shape.'],
    ['integration-manifest.json'],
    ['Use this workflow when proving blocks, images, links, and draft stories before site handoff.']
  ),
  validatePlan: guidance(
    ['Checks that the plan keeps this import separate and avoids unsafe changes.'],
    ['Run after planning and before any dry run or real apply.'],
    ['plan-validation.json'],
    ['Do not continue to apply if validation fails. Fix the plan or template first.']
  ),
  previewDiff: guidance(
    ['Shows which site files would be created and whether they already exist.'],
    ['Choose plan file and existing site.'],
    ['site change preview'],
    ['Existing non-generated files must never be overwritten; resolve collisions before apply.']
  ),
  clientReview: guidance(
    ['Creates a read-only review gate for an existing client site before local or remote writes.'],
    ['Choose plan file and existing site after the safety check passes.'],
    ['client-review-gate-report.md'],
    ['Treat failed review gates as blockers until the report is resolved.']
  ),
  platformReadiness: guidance(
    ['Checks whether the detected platform can host the generated integration and live draft preview handoff.'],
    ['Choose plan file and existing site.'],
    ['platform-readiness-report.md'],
    ['Manual-router frameworks may require handoff notes rather than automatic route files.']
  ),
  routeChecklist: guidance(
    ['Creates route-by-route acceptance checks for imported pages.'],
    ['Choose plan file and existing site. Optionally focus one page.'],
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
    ['Previews site file creation and Storyblok draft creation together.'],
    ['Run after plan validation and client review.'],
    ['apply-result.json', 'report.md'],
    ['Resolve existing-file conflicts, site check failures, or unresolved Storyblok links before the real import.']
  ),
  fullApply: guidance(
    ['Runs the full safe import against the selected site and Storyblok space.'],
    ['Run after full dry run passes. Confirm the safety prompt and keep credentials session-only.'],
    ['apply-result.json', 'report.md', 'storyblok-management-verification.json'],
    ['If a later remote step fails, the ledger and rollback preview show exactly what was created.']
  ),
  wireRoutesDryRun: guidance(
    ['Previews framework route handoff files without writing host routes.'],
    ['Choose plan file and existing site after generated import files exist.'],
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
    ['Checks the generated site files and confirms they still belong to this import.'],
    ['Choose plan file and existing site after a real site import.'],
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
    ['Verification drift means the Storyblok draft no longer matches the plan and should be reviewed.']
  ),
  report: guidance(
    ['Generates the main report from the plan, checks, import run, and review files.'],
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
    ['Choose the plan file, and existing site when site evidence matters.'],
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
    ['Shows exactly which items from this import rollback would target without deleting anything.'],
    ['Choose the plan file. Add existing site when local generated files should be included.'],
    ['rollback-preview.json'],
    ['Rollback must remain explicit and should never target production or content outside this import.']
  ),
  visualEditorReadiness: guidance(
    ['Checks whether Storyblok Visual Editor preview requirements are documented and ready.'],
    ['Choose plan file and optionally the existing site with generated preview files.'],
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
