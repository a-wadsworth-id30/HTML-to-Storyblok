const api = window.htmlToStoryblokDesktop;
const stateFields = ['workDir', 'templatePath', 'repoPath', 'manifestPath', 'integrationId', 'framework', 'route'];
const secretFields = ['storyblokManagementToken', 'storyblokSpaceId', 'storyblokPreviewToken', 'storyblokRegion'];

let state = {};
let actions = [];
let activeRequestId = null;

const elements = {
  actions: document.getElementById('actions'),
  artifacts: document.getElementById('artifacts'),
  output: document.getElementById('output'),
  commandPreview: document.getElementById('commandPreview'),
  cancelRun: document.getElementById('cancelRun'),
  refreshEvidence: document.getElementById('refreshEvidence'),
  clearSecrets: document.getElementById('clearSecrets')
};

initialize().catch((error) => {
  appendOutput(`Desktop failed to initialize: ${error.message || String(error)}\n`, 'error');
});

async function initialize() {
  const bootstrap = await api.bootstrap();
  actions = bootstrap.actions;
  state = {
    ...bootstrap.defaultState,
    ...readStoredState()
  };
  bindInputs();
  renderActions();
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
      renderActions();
    });
  }
}

function bindGlobalControls() {
  elements.refreshEvidence.addEventListener('click', refreshEvidence);
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

function renderActionButton(action) {
  const missing = missingFields(action);
  const button = document.createElement('button');
  button.className = 'action-button';
  button.type = 'button';
  button.disabled = missing.length > 0 || Boolean(activeRequestId);
  button.innerHTML = `
    <span>
      <span class="action-title">${escapeHtml(action.title)}</span>
      <span class="action-description">${escapeHtml(missing.length ? `Missing ${missing.join(', ')}` : action.description)}</span>
    </span>
    <span class="safety-tag ${escapeHtml(action.safety)}">${escapeHtml(action.safety)}</span>
  `;
  button.addEventListener('mouseenter', () => previewAction(action));
  button.addEventListener('focus', () => previewAction(action));
  button.addEventListener('click', () => runAction(action));
  return button;
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
    renderActions();
    refreshEvidence();
  }
}

async function refreshEvidence() {
  const artifacts = await api.readArtifacts({ state });
  elements.artifacts.innerHTML = '';
  for (const artifact of artifacts) {
    elements.artifacts.appendChild(renderArtifact(artifact));
  }
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
