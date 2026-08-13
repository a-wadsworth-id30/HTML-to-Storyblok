export const DESKTOP_WORKFLOWS = [
  {
    id: 'storyblok-only',
    title: 'Storyblok-Only Test',
    summary: 'Create and validate namespaced Storyblok components, assets, presets, and draft stories before a client repository is available.',
    outcome: 'Draft Storyblok import with evidence and rollback preview.',
    primary: true,
    steps: [
      step('doctorStoryblok', 'Check local and Storyblok credential readiness.'),
      step('inspectTemplate', 'Inspect the selected template pages, fields, assets, and warnings.'),
      step('inspectStoryblok', 'Review the target Storyblok space without exposing secrets.'),
      step('planStoryblokOnly', 'Create a Storyblok-only additive manifest.'),
      step('validatePlan', 'Confirm namespacing and additive-only policy.'),
      step('storyblokDryRun', 'Preview all remote Storyblok operations.'),
      step('storyblokApply', 'Create draft-only Storyblok resources after confirmation.'),
      step('validateStoryblok', 'Validate draft stories through the Content API.'),
      step('storyblokVerify', 'Verify Management API state.'),
      step('handoffPack', 'Package evidence for review.')
    ]
  },
  {
    id: 'full-import',
    title: 'Full Repository Import',
    summary: 'Plan, dry-run, apply, route-check, and validate an HTML template inside an existing site without mutating existing routes or content.',
    outcome: 'Isolated repository integration plus draft Storyblok content and handoff evidence.',
    primary: true,
    steps: [
      step('doctorFull', 'Check machine, repository, Storyblok, and optional service readiness.'),
      step('inspectTemplate', 'Inspect the selected template before planning.'),
      step('inspectRepository', 'Detect the target framework and repository safety signals.'),
      step('inspectStoryblok', 'Inspect Storyblok Management API state.'),
      step('planFull', 'Create a full additive integration manifest.'),
      step('validatePlan', 'Validate policy, namespacing, and collisions.'),
      step('clientReview', 'Produce a read-only client apply review gate.'),
      step('fullDryRun', 'Preview repository and Storyblok operations.'),
      step('fullApply', 'Run the confirmed additive apply.'),
      step('routeChecklist', 'Review route handoff requirements.'),
      step('wireRoutesDryRun', 'Preview route wiring if the framework supports it.'),
      step('validateLocal', 'Validate generated local output.'),
      step('validateStoryblok', 'Validate Storyblok draft content.'),
      step('handoffPack', 'Package final handoff evidence.')
    ]
  },
  {
    id: 'validate-existing',
    title: 'Validate Existing Integration',
    summary: 'Review an existing manifest, generated files, platform readiness, draft stories, and evidence state.',
    outcome: 'Clear pass/fail evidence and next recommended actions.',
    steps: [
      step('dashboard', 'Review the latest local integration status.'),
      step('validatePlan', 'Validate the current manifest.'),
      step('platformReadiness', 'Check framework handoff readiness.'),
      step('routeChecklist', 'Produce per-route acceptance checks.'),
      step('validateLocal', 'Validate generated repository files.'),
      step('validateStoryblok', 'Validate draft stories and links.'),
      step('storyblokVerify', 'Verify Management API resources.'),
      step('evidenceIndex', 'Create a compact evidence index.')
    ]
  },
  {
    id: 'handoff-recovery',
    title: 'Handoff & Recovery',
    summary: 'Generate reports, review evidence, and preview rollback targets before client or internal sign-off.',
    outcome: 'Review-ready evidence pack and rollback visibility.',
    steps: [
      step('report', 'Generate the consolidated Markdown report.'),
      step('reportHtml', 'Generate an HTML report for easier review.'),
      step('evidenceIndex', 'Index required handoff evidence.'),
      step('handoffPack', 'Build the production handoff pack.'),
      step('rollbackPreview', 'Preview rollback targets without deleting anything.'),
      step('visualEditorReadiness', 'Check Visual Editor readiness for imported drafts.')
    ]
  }
];

export function getDesktopWorkflows() {
  return DESKTOP_WORKFLOWS.map((workflow) => ({
    ...workflow,
    steps: workflow.steps.map((entry, index) => ({
      ...entry,
      number: index + 1
    }))
  }));
}

export function findDesktopWorkflow(id) {
  return getDesktopWorkflows().find((workflow) => workflow.id === id) || null;
}

export function workflowActionIds(workflowOrId) {
  const workflow = typeof workflowOrId === 'string' ? findDesktopWorkflow(workflowOrId) : workflowOrId;
  return workflow ? workflow.steps.map((entry) => entry.action_id) : [];
}

function step(actionId, guidance) {
  return {
    action_id: actionId,
    guidance
  };
}
