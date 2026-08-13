export const DESKTOP_WORKFLOWS = [
  {
    id: 'storyblok-only',
    title: 'Test In Storyblok Only',
    summary: 'Use this when you want to prove pages, blocks, images, and draft stories before touching a site.',
    outcome: 'Draft-only Storyblok pages with review evidence and a rollback preview.',
    primary: true,
    steps: [
      step('doctorStoryblok', 'Check your Storyblok access.'),
      step('inspectTemplate', 'Read the template and flag anything that needs attention.'),
      step('inspectStoryblok', 'Check the Storyblok space before creating anything.'),
      step('planStoryblokOnly', 'Prepare the safe import plan.'),
      step('validatePlan', 'Confirm the plan will not overwrite anything.'),
      step('storyblokDryRun', 'Preview what would be created.'),
      step('storyblokApply', 'Create draft-only Storyblok content after confirmation.'),
      step('validateStoryblok', 'Check that draft content and images resolve.'),
      step('storyblokVerify', 'Confirm the created Storyblok items exist.'),
      step('handoffPack', 'Prepare evidence for review.')
    ]
  },
  {
    id: 'full-import',
    title: 'Add To An Existing Site',
    summary: 'Use this when you are ready to place the imported template into a selected site safely.',
    outcome: 'A safe site integration plus draft Storyblok pages and handoff evidence.',
    primary: true,
    steps: [
      step('doctorFull', 'Check this machine, the site, and Storyblok access.'),
      step('inspectTemplate', 'Review the template before planning.'),
      step('inspectRepository', 'Check what kind of site you selected.'),
      step('inspectStoryblok', 'Check the Storyblok space before creating anything.'),
      step('planFull', 'Prepare the safe import plan.'),
      step('validatePlan', 'Confirm the plan will not overwrite anything.'),
      step('clientReview', 'Create a review checkpoint before changes.'),
      step('fullDryRun', 'Preview all site and Storyblok changes.'),
      step('fullApply', 'Run the safe import after confirmation.'),
      step('routeChecklist', 'Review how imported pages should be opened.'),
      step('wireRoutesDryRun', 'Preview page link-up where supported.'),
      step('validateLocal', 'Check the generated site files.'),
      step('validateStoryblok', 'Check Storyblok draft content.'),
      step('handoffPack', 'Prepare final handoff evidence.')
    ]
  },
  {
    id: 'validate-existing',
    title: 'Check Previous Work',
    summary: 'Use this when an import already exists and you want to see what is done or needs attention.',
    outcome: 'A clear pass/fail review with next recommended actions.',
    steps: [
      step('dashboard', 'Review the latest import status.'),
      step('validatePlan', 'Check the current plan.'),
      step('platformReadiness', 'Check whether the selected site can preview the import.'),
      step('routeChecklist', 'Create page-by-page review checks.'),
      step('validateLocal', 'Check generated site files.'),
      step('validateStoryblok', 'Check draft stories and links.'),
      step('storyblokVerify', 'Confirm Storyblok items still match the plan.'),
      step('evidenceIndex', 'List the evidence that is ready or missing.')
    ]
  },
  {
    id: 'handoff-recovery',
    title: 'Prepare Handoff',
    summary: 'Use this when you need a report, evidence pack, or rollback preview for review.',
    outcome: 'A review-ready evidence pack and clear rollback visibility.',
    steps: [
      step('report', 'Create the written report.'),
      step('reportHtml', 'Create an easy-to-read HTML report.'),
      step('evidenceIndex', 'Check which evidence is ready.'),
      step('handoffPack', 'Build the handoff pack.'),
      step('rollbackPreview', 'Preview what rollback would target.'),
      step('visualEditorReadiness', 'Check editor preview readiness.')
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
