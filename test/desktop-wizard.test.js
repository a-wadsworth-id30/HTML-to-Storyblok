import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDesktopActions } from '../src/desktop-actions.js';
import { findDesktopWorkflow, getDesktopWorkflows, workflowActionIds } from '../src/desktop-wizard.js';

test('desktop workflows expose guided paths for primary import outcomes', () => {
  const workflows = getDesktopWorkflows();

  assert.ok(workflows.length >= 4);
  assert.deepEqual(
    workflows.filter((workflow) => workflow.primary).map((workflow) => workflow.id),
    ['storyblok-only', 'full-import']
  );
  assert.ok(workflows.every((workflow) => workflow.steps.every((step, index) => step.number === index + 1)));
});

test('desktop workflows use outcome-led non-technical labels', () => {
  const workflows = getDesktopWorkflows();

  assert.deepEqual(workflows.map((workflow) => workflow.title), [
    'Test In Storyblok Only',
    'Add To An Existing Site',
    'Check Previous Work',
    'Prepare Handoff'
  ]);
  assert.ok(workflows.every((workflow) => !/repository|manifest/i.test(workflow.title)));
});

test('desktop workflow steps all map to known desktop actions', () => {
  const knownActionIds = new Set(getDesktopActions().map((action) => action.id));

  for (const workflow of getDesktopWorkflows()) {
    assert.ok(workflow.id);
    assert.ok(workflow.title);
    assert.ok(workflow.outcome);
    for (const actionId of workflowActionIds(workflow)) {
      assert.equal(knownActionIds.has(actionId), true, `${workflow.id} references unknown action ${actionId}`);
    }
  }
});

test('full import workflow keeps review and dry-run gates before real apply', () => {
  const steps = workflowActionIds('full-import');

  assert.ok(steps.indexOf('validatePlan') < steps.indexOf('clientReview'));
  assert.ok(steps.indexOf('clientReview') < steps.indexOf('fullDryRun'));
  assert.ok(steps.indexOf('fullDryRun') < steps.indexOf('fullApply'));
  assert.ok(steps.indexOf('fullApply') < steps.indexOf('validateLocal'));
});

test('Storyblok-only workflow avoids repository-only steps', () => {
  const steps = workflowActionIds(findDesktopWorkflow('storyblok-only'));

  assert.ok(steps.includes('planStoryblokOnly'));
  assert.ok(steps.includes('storyblokApply'));
  assert.equal(steps.includes('inspectRepository'), false);
  assert.equal(steps.includes('fullApply'), false);
});

test('desktop renderer contains guided workflow screens and advanced action fallback', async () => {
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');

  assert.match(html, /Quick Setup/);
  assert.match(html, /data-quick-setup="storyblok-only"/);
  assert.match(html, /data-quick-setup="full-import"/);
  assert.match(html, /id="setupSummary"/);
  assert.match(html, /What do you want to do\?/);
  assert.match(html, /Advanced controls/);
  assert.match(html, /id="workflows"/);
  assert.match(html, /id="workflowSteps"/);
  assert.match(renderer, /applyQuickSetup/);
  assert.match(renderer, /renderQuickSetup/);
  assert.match(renderer, /selectedSetupId/);
  assert.match(renderer, /renderWorkflows/);
  assert.match(renderer, /renderWorkflowSteps/);
  assert.match(renderer, /runAction\(action\)/);
});

test('desktop renderer presents an import assistant before technical controls', async () => {
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');

  assert.match(html, /Desktop import assistant/);
  assert.match(html, /Bring an HTML template into Storyblok safely/);
  assert.match(html, /Test Storyblok/);
  assert.match(html, /Add To Existing Site/);
  assert.match(html, /Check Previous Work/);
  assert.match(html, /<details class="control-section advanced-setup">/);
  assert.match(html, /<details class="actions-panel">/);
  assert.doesNotMatch(html, /Guided GUI for non-terminal team members/);
  assert.doesNotMatch(html, /Action Guidance/);
});
