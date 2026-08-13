const api = window.htmlToStoryblokDesktop;
const stateFields = ['workDir', 'templatePath', 'repoPath', 'manifestPath', 'integrationId', 'framework', 'route'];
const secretFields = ['storyblokManagementToken', 'storyblokSpaceId', 'storyblokPreviewToken', 'storyblokRegion'];

let state = {};
let actions = [];
let workflows = [];
let guidanceByActionId = new Map();
let runHistory = [];
let selectedWorkflowId = '';
let selectedActionId = '';
let activeRequestId = null;

const elements = {
  workflows: document.getElementById('workflows'),
  workflowSteps: document.getElementById('workflowSteps'),
  actionGuidance: document.getElementById('actionGuidance'),
  guidanceSubtitle: document.getElementById('guidanceSubtitle'),
  actions: document.getElementById('actions'),
  artifacts: document.getElementById('artifacts'),
  runHistory: document.getElementById('runHistory'),
  output: document.getElementById('output'),
  commandPreview: document.getElementById('commandPreview'),
  cancelRun: document.getElementById('cancelRun'),
  refreshEvidence: document.getElementById('refreshEvidence'),
  refreshHistory: document.getElementById('refreshHistory'),
  clearSecrets: document.getElementById('clearSecrets')
};

initialize().catch((error) => {
  appendOutput(`Desktop failed to initialize: ${error.message || String(error)}\n`, 'error');
});

async function initialize() {
  const bootstrap = await api.bootstrap();
  actions = bootstrap.actions;
  workflows = bootstrap.workflows || [];
  guidanceByActionId = new Map((bootstrap.guidance || []).map((entry) => [entry.action_id, entry]));
  runHistory = bootstrap.runHistory || [];
  selectedWorkflowId = workflows.find((workflow) => workflow.primary)?.id || workflows[0]?.id || '';
  selectedActionId = workflows.find((workflow) => workflow.id === selectedWorkflowId)?.steps[0]?.action_id || actions[0]?.id || '';
  state = {
    ...bootstrap.defaultState,
    ...readStoredState()
  };
  bindInputs();
  renderWorkflows();
  renderWorkflowSteps();
  renderActionGuidance();
  renderActions();
  renderRunHistory();
  bindGlobalControls();
  await refreshEvidence();
  api.onCliEvent(handleCliEvent);
}

function bindInputs() {
  for (const field of stateFields) {
    const element = document.getElementById(field);
    if (!element) continue;
    element.value = state[field] || '';
    element.addEventListener('input', () => {
      state[field] = element.value.trim();
      if (field === 'workDir' && !document.getElementById('manifestPath').value.trim()) {
        state.manifestPath = `${state.workDir}/integration-manifest.json`;
      }
      storeState();
      renderWorkflowSteps();
      renderActions();
    });
  }

  for (const button of document.querySelectorAll('[data-browse]')) {
    button.addEventListener('click', async () => {
      const field = button.dataset.browse;
      const selected = await api.selectDirectory({
        title: field === 'repoPath' ? 'Choose target repository' : 'Choose template folder',
        defaultPath: state[field] || state.cwd
      });
      if (!selected) return;
      state[field] = selected;
      document.getElementById(field).value = selected;
      storeState();
      renderWorkflowSteps();
      renderActions();
    });
  }
}

function bindGlobalControls() {
  elements.refreshEvidence.addEventListener('click', refreshEvidence);
  elements.refreshHistory.addEventListener('click', refreshRunHistory);
  elements.cancelRun.addEventListener('click', async () => {
    if (!activeRequestId) return;
    await api.cancelAction(activeRequestId);
    appendOutput('\nRun cancelled by user.\n', 'warn');
    activeRequestId = null;
    elements.cancelRun.disabled = true;
  });
  elements.clearSecrets.addEventListener('click', () => {
    for (const field of secretFields) {
      const element = document.getElementById(field);
      if (element) element.value = '';
    }
    appendOutput('\nSession credentials cleared.\n', 'info');
  });
}

function renderActions() {
  const grouped = groupActions(actions);
  elements.actions.innerHTML = '';
  for (const [group, entries] of grouped) {
    const section = document.createElement('section');
    section.className = 'action-group';
    const title = document.createElement('h4');
    title.textContent = group;
    const list = document.createElement('div');
    list.className = 'action-list';
    for (const action of entries) list.appendChild(renderActionButton(action));
    section.append(title, list);
    elements.actions.appendChild(section);
  }
}

function renderWorkflows() {
  elements.workflows.innerHTML = '';
  for (const workflow of workflows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `workflow-card ${workflow.id === selectedWorkflowId ? 'selected' : ''}`;
    button.innerHTML = `
      <span>
        <span class="workflow-title">${escapeHtml(workflow.title)}</span>
        <span class="workflow-summary">${escapeHtml(workflow.summary)}</span>
      </span>
      <span class="workflow-count">${workflow.steps.length} steps</span>
    `;
    button.addEventListener('click', () => {
      selectedWorkflowId = workflow.id;
      if (!workflow.steps.some((step) => step.action_id === selectedActionId)) {
        selectedActionId = workflow.steps[0]?.action_id || selectedActionId;
      }
      renderWorkflows();
      renderWorkflowSteps();
      renderActionGuidance();
    });
    elements.workflows.appendChild(button);
  }
}

function renderWorkflowSteps() {
  const workflow = workflows.find((entry) => entry.id === selectedWorkflowId);
  if (!workflow) {
    elements.workflowSteps.innerHTML = '';
    return;
  }

  const actionById = new Map(actions.map((action) => [action.id, action]));
  elements.workflowSteps.innerHTML = `
    <div class="workflow-outcome">
      <strong>Outcome:</strong> ${escapeHtml(workflow.outcome)}
    </div>
  `;
  for (const step of workflow.steps) {
    const action = actionById.get(step.action_id);
    if (!action) continue;
    elements.workflowSteps.appendChild(renderWorkflowStep(step, action));
  }
}

function renderWorkflowStep(step, action) {
  const missing = missingFields(action);
  const row = document.createElement('article');
  row.className = `workflow-step ${missing.length ? 'blocked' : 'ready'} ${action.id === selectedActionId ? 'selected' : ''}`;
  row.tabIndex = 0;
  row.innerHTML = `
    <div class="step-number">${step.number}</div>
    <div>
      <h4>${escapeHtml(action.title)}</h4>
      <p>${escapeHtml(missing.length ? `Fill ${missing.join(', ')} before running this step.` : step.guidance)}</p>
    </div>
    <button class="action-button compact" type="button" ${missing.length || activeRequestId ? 'disabled' : ''}>
      <span class="action-title">Run</span>
      <span class="safety-tag ${escapeHtml(action.safety)}">${escapeHtml(action.safety)}</span>
    </button>
  `;
  const button = row.querySelector('button');
  row.addEventListener('mouseenter', () => selectAction(action));
  row.addEventListener('focusin', () => selectAction(action));
  button.addEventListener('mouseenter', () => selectAction(action, { preview: true }));
  button.addEventListener('focus', () => selectAction(action, { preview: true }));
  button.addEventListener('click', () => runAction(action));
  return row;
}

function renderActionButton(action) {
  const missing = missingFields(action);
  const button = document.createElement('button');
  button.className = `action-button ${action.id === selectedActionId ? 'selected' : ''}`;
  button.type = 'button';
  button.disabled = missing.length > 0 || Boolean(activeRequestId);
  button.innerHTML = `
    <span>
      <span class="action-title">${escapeHtml(action.title)}</span>
      <span class="action-description">${escapeHtml(missing.length ? `Missing ${missing.join(', ')}` : action.description)}</span>
    </span>
    <span class="safety-tag ${escapeHtml(action.safety)}">${escapeHtml(action.safety)}</span>
  `;
  button.addEventListener('mouseenter', () => selectAction(action, { preview: true }));
  button.addEventListener('focus', () => selectAction(action, { preview: true }));
  button.addEventListener('click', () => runAction(action));
  return button;
}

function selectAction(action, options = {}) {
  if (selectedActionId === action.id) {
    if (options.preview) previewAction(action);
    return;
  }
  selectedActionId = action.id;
  renderWorkflowSteps();
  renderActionGuidance();
  renderActions();
  if (options.preview) previewAction(action);
}

function renderActionGuidance() {
  const guidance = guidanceByActionId.get(selectedActionId);
  if (!guidance) {
    elements.guidanceSubtitle.textContent = 'Choose a workflow step or advanced action to see what it needs and what evidence it creates.';
    elements.actionGuidance.innerHTML = `
      <div class="empty-state">
        Select a step to view its purpose, safety level, required inputs, output evidence, and recovery notes.
      </div>
    `;
    return;
  }

  elements.guidanceSubtitle.textContent = guidance.summary;
  elements.actionGuidance.innerHTML = `
    <div class="guidance-grid">
      <section class="guidance-card">
        <h4>Before Running</h4>
        ${renderList(guidance.before_run)}
      </section>
      <section class="guidance-card">
        <h4>Required Inputs</h4>
        ${renderRequirements(guidance.requirements)}
      </section>
      <section class="guidance-card">
        <h4>Safety</h4>
        <p><span class="safety-tag ${escapeHtml(guidance.safety.level)}">${escapeHtml(guidance.safety.level)}</span></p>
        <p>${escapeHtml(guidance.safety.description)}</p>
      </section>
      <section class="guidance-card">
        <h4>Evidence Created</h4>
        ${renderList(guidance.evidence)}
      </section>
      <section class="guidance-card wide">
        <h4>Failure Guidance</h4>
        ${renderList(guidance.recovery)}
      </section>
    </div>
  `;
}

async function previewAction(action) {
  if (missingFields(action).length) {
    elements.commandPreview.textContent = `${action.title}: fill the required fields first.`;
    return;
  }
  try {
    const preview = await api.previewAction({
      actionId: action.id,
      state,
      sessionEnv: readSessionEnv()
    });
    const envText = preview.visibleSessionEnvKeys.length ? ` | session env: ${preview.visibleSessionEnvKeys.join(', ')}` : '';
    elements.commandPreview.textContent = `${preview.commandLine}${envText}`;
  } catch (error) {
    elements.commandPreview.textContent = error.message || String(error);
  }
}

function renderRequirements(requirements) {
  if (!requirements.length) return '<p>No required form fields for this action.</p>';
  return `
    <ul>
      ${requirements.map((requirement) => `
        <li><strong>${escapeHtml(requirement.label)}:</strong> ${escapeHtml(requirement.help)}</li>
      `).join('')}
    </ul>
  `;
}

function renderList(items) {
  if (!items.length) return '<p>No additional guidance.</p>';
  return `
    <ul>
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
    </ul>
  `;
}

async function runAction(action) {
  if (action.confirmation && !window.confirm(`${action.confirmation}\n\nThe CLI safety gates will still run before changes are made.`)) {
    return;
  }
  elements.output.textContent = '';
  try {
    const run = await api.runAction({
      actionId: action.id,
      state,
      sessionEnv: readSessionEnv()
    });
    activeRequestId = run.requestId;
    elements.cancelRun.disabled = false;
    elements.commandPreview.textContent = run.commandLine;
    renderWorkflowSteps();
    renderActions();
  } catch (error) {
    appendOutput(`${error.message || String(error)}\n`, 'error');
  }
}

function handleCliEvent(event) {
  if (event.type === 'started') {
    activeRequestId = event.requestId;
    elements.cancelRun.disabled = false;
    appendOutput(`$ ${event.commandLine}\n`, 'info');
    if (event.envKeys?.length) appendOutput(`session env: ${event.envKeys.join(', ')}\n`, 'info');
    renderActions();
    return;
  }
  if (event.type === 'stdout' || event.type === 'stderr') {
    appendOutput(event.text, event.type === 'stderr' ? 'warn' : 'info');
    return;
  }
  if (event.type === 'error') {
    appendOutput(`\n${event.text}\n`, 'error');
    return;
  }
  if (event.type === 'closed') {
    appendOutput(`\nProcess finished with exit code ${event.exitCode}.\n`, event.exitCode === 0 ? 'info' : 'error');
    activeRequestId = null;
    elements.cancelRun.disabled = true;
    renderWorkflowSteps();
    renderActions();
    refreshEvidence();
    refreshRunHistory();
  }
}

async function refreshEvidence() {
  const artifacts = await api.readArtifacts({ state });
  elements.artifacts.innerHTML = '';
  for (const artifact of artifacts) {
    elements.artifacts.appendChild(renderArtifact(artifact));
  }
}

async function refreshRunHistory() {
  runHistory = await api.readRunHistory();
  renderRunHistory();
}

function renderRunHistory() {
  elements.runHistory.innerHTML = '';
  if (!runHistory.length) {
    elements.runHistory.innerHTML = `
      <div class="empty-state">
        No desktop runs recorded yet. Run a guided workflow step to create a local audit trail.
      </div>
    `;
    return;
  }

  for (const run of runHistory.slice(0, 12)) {
    elements.runHistory.appendChild(renderRunHistoryItem(run));
  }
}

function renderRunHistoryItem(run) {
  const item = document.createElement('article');
  item.className = `run-history-item ${escapeHtml(run.status)}`;
  item.innerHTML = `
    <div>
      <h4>${escapeHtml(run.action_title || run.action_id)}</h4>
      <p>${escapeHtml(formatRunMeta(run))}</p>
      <code>${escapeHtml(run.command_line)}</code>
    </div>
    <span class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
  `;
  return item;
}

function renderArtifact(artifact) {
  const item = document.createElement('article');
  item.className = `artifact ${artifact.exists ? '' : 'missing'}`;
  item.innerHTML = `
    <h4>${escapeHtml(artifact.label)}</h4>
    <p>${escapeHtml(artifact.path)}</p>
    <div class="artifact-actions">
      <span class="safety-tag">${artifact.exists ? 'available' : 'missing'}</span>
      <button class="secondary-button" type="button" ${artifact.exists ? '' : 'disabled'}>Open</button>
    </div>
  `;
  const button = item.querySelector('button');
  button.addEventListener('click', () => api.openArtifact(artifact.path));
  return item;
}

function appendOutput(text) {
  elements.output.textContent += text;
  elements.output.scrollTop = elements.output.scrollHeight;
}

function formatRunMeta(run) {
  const ended = run.ended_at ? new Date(run.ended_at).toLocaleString() : 'unknown time';
  const duration = run.duration_ms ? `${Math.round(run.duration_ms / 100) / 10}s` : '0s';
  const env = run.env_keys?.length ? ` | env: ${run.env_keys.join(', ')}` : '';
  return `${ended} | ${duration} | ${run.safety || 'unknown safety'}${env}`;
}

function missingFields(action) {
  const labels = {
    templatePath: 'template folder',
    repoPath: 'target repository',
    manifestPath: 'manifest path',
    integrationId: 'integration ID',
    route: 'route'
  };
  return (action.requirements || [])
    .filter((field) => !String(state[field] || '').trim())
    .map((field) => labels[field] || field);
}

function groupActions(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return groups;
}

function readSessionEnv() {
  const values = {};
  for (const field of secretFields) {
    const element = document.getElementById(field);
    values[field] = element ? element.value.trim() : '';
  }
  return values;
}

function readStoredState() {
  try {
    return JSON.parse(window.localStorage.getItem('html-to-storyblok-desktop-state') || '{}');
  } catch {
    return {};
  }
}

function storeState() {
  const persisted = {};
  for (const field of stateFields) persisted[field] = state[field] || '';
  window.localStorage.setItem('html-to-storyblok-desktop-state', JSON.stringify(persisted));
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
