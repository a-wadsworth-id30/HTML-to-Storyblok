import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDesktopActions } from '../src/desktop-actions.js';
import { fieldGuidance, findDesktopGuidance, getDesktopGuidance } from '../src/desktop-guidance.js';

test('desktop guidance covers every desktop action with safety and evidence context', () => {
  const actions = getDesktopActions();
  const guidance = getDesktopGuidance();
  const guidanceById = new Map(guidance.map((entry) => [entry.action_id, entry]));

  assert.equal(guidance.length, actions.length);

  for (const action of actions) {
    const entry = guidanceById.get(action.id);
    assert.ok(entry, `missing guidance for ${action.id}`);
    assert.equal(entry.title, action.title);
    assert.equal(entry.safety.level, action.safety);
    assert.ok(entry.safety.description);
    assert.ok(entry.before_run.length > 0);
    assert.ok(entry.evidence.length > 0);
    assert.ok(entry.recovery.length > 0);
  }
});

test('desktop guidance mirrors action requirements with readable field help', () => {
  for (const action of getDesktopActions()) {
    const entry = findDesktopGuidance(action.id);
    assert.deepEqual(entry.requirements.map((requirement) => requirement.field), action.requirements);

    for (const requirement of entry.requirements) {
      assert.equal(requirement.label, fieldGuidance(requirement.field).label);
      assert.ok(requirement.help);
    }
  }
});

test('desktop guidance documents write actions without weakening additive-only safety', () => {
  const remote = findDesktopGuidance('storyblokApply');
  const full = findDesktopGuidance('fullApply');

  assert.match(remote.safety.description, /draft resources/i);
  assert.match(remote.recovery.join(' '), /not overwritten/i);
  assert.match(full.safety.description, /isolated repository files/i);
  assert.match(full.recovery.join(' '), /rollback preview/i);
});

test('desktop bootstrap exposes guidance to the renderer', async () => {
  const mainSource = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');

  assert.match(mainSource, /getDesktopGuidance/);
  assert.match(mainSource, /guidance:\s*getDesktopGuidance\(\)/);
  assert.match(html, /Action Guidance/);
  assert.match(html, /id="actionGuidance"/);
  assert.match(renderer, /renderActionGuidance/);
  assert.match(renderer, /Evidence Created/);
  assert.match(renderer, /Failure Guidance/);
});
