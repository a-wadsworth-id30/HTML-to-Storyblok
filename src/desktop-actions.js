import path from 'node:path';

export const DEFAULT_DESKTOP_WORK_DIR = '.tmp/html-to-storyblok';
export const DEFAULT_DESKTOP_MANIFEST = `${DEFAULT_DESKTOP_WORK_DIR}/integration-manifest.json`;

const FIELD_LABELS = {
  templatePath: 'template folder',
  repoPath: 'target repository',
  manifestPath: 'integration manifest',
  integrationId: 'integration ID',
  route: 'route'
};

export const DESKTOP_ACTIONS = [
  {
    id: 'onboarding',
    group: 'Start',
    title: 'First-Time Setup Guide',
    description: 'Check what is configured and what the team needs before an import.',
    command: 'onboarding',
    safety: 'read-only',
    requirements: []
  },
  {
    id: 'dashboard',
    group: 'Start',
    title: 'Project Dashboard',
    description: 'Show the latest integration status, validation, and environment summary.',
    command: 'dashboard',
    safety: 'read-only',
    requirements: []
  },
  {
    id: 'doctorFull',
    group: 'Start',
    title: 'Doctor - Full Import',
    description: 'Check Node, npm, Git, repository health, Storyblok, and optional services.',
    command: 'doctor',
    safety: 'read-only',
    requirements: [],
    args: () => ['--for', 'full-import']
  },
  {
    id: 'doctorStoryblok',
    group: 'Start',
    title: 'Doctor - Storyblok Only',
    description: 'Check local prerequisites and Storyblok credentials before a remote test.',
    command: 'doctor',
    safety: 'read-only',
    requirements: [],
    args: () => ['--for', 'storyblok-only']
  },
  {
    id: 'inspectTemplate',
    group: 'Inspect',
    title: 'Inspect Template',
    description: 'Read pages, sections, scripts, forms, assets, and quality warnings.',
    command: 'inspect-template',
    safety: 'read-only',
    requirements: ['templatePath'],
    args: (state) => ['--template', state.templatePath]
  },
  {
    id: 'templateQuality',
    group: 'Inspect',
    title: 'Template Quality',
    description: 'Score template readiness before planning or asking design for fixes.',
    command: 'template-quality',
    safety: 'read-only',
    requirements: ['templatePath'],
    args: (state) => ['--template', state.templatePath]
  },
  {
    id: 'inspectRepository',
    group: 'Inspect',
    title: 'Inspect Repository',
    description: 'Detect framework, package manager, routes, Storyblok package, and Netlify files.',
    command: 'inspect-repository',
    safety: 'read-only',
    requirements: ['repoPath'],
    args: (state) => ['--repo', state.repoPath]
  },
  {
    id: 'inspectStoryblok',
    group: 'Inspect',
    title: 'Inspect Storyblok',
    description: 'Query remote components, stories, assets, folders, tags, and presets.',
    command: 'inspect-storyblok',
    safety: 'read-only',
    requirements: [],
    args: () => ['--remote', '--full']
  },
  {
    id: 'planFull',
    group: 'Plan',
    title: 'Create Full Integration Plan',
    description: 'Create a namespaced manifest for repository files and Storyblok draft resources.',
    command: 'plan',
    safety: 'local-write',
    requirements: ['templatePath', 'repoPath', 'integrationId'],
    args: (state) => [
      '--integration-id', state.integrationId,
      '--template', state.templatePath,
      '--repo', state.repoPath,
      '--framework', state.framework || 'auto'
    ]
  },
  {
    id: 'planStoryblokOnly',
    group: 'Plan',
    title: 'Create Storyblok-Only Plan',
    description: 'Create a manifest for component, asset, preset, and draft-story testing.',
    command: 'plan',
    safety: 'local-write',
    requirements: ['templatePath', 'integrationId'],
    args: (state) => [
      '--integration-id', state.integrationId,
      '--template', state.templatePath,
      '--framework', state.framework || 'static'
    ]
  },
  {
    id: 'validatePlan',
    group: 'Plan',
    title: 'Validate Plan',
    description: 'Confirm no collisions, unsafe mutations, route changes, or unnamespaced resources.',
    command: 'validate-plan',
    safety: 'read-only',
    requirements: ['manifestPath'],
    args: (state) => ['--manifest', state.manifestPath]
  },
  {
    id: 'previewDiff',
    group: 'Plan',
    title: 'Preview Repository Diff',
    description: 'Show what the manifest would create inside the selected repository.',
    command: 'diff',
    safety: 'read-only',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => ['--manifest', state.manifestPath, '--repo', state.repoPath]
  },
  {
    id: 'clientReview',
    group: 'Plan',
    title: 'Client Review Gate',
    description: 'Produce read-only evidence before touching an existing client repository.',
    command: 'client-review',
    safety: 'read-only',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => ['--manifest', state.manifestPath, '--repo', state.repoPath]
  },
  {
    id: 'platformReadiness',
    group: 'Plan',
    title: 'Platform Readiness',
    description: 'Check framework route handoff, adapter evidence, host scripts, and Content API guidance.',
    command: 'platform-readiness',
    safety: 'read-only',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => ['--manifest', state.manifestPath, '--repo', state.repoPath]
  },
  {
    id: 'routeChecklist',
    group: 'Plan',
    title: 'Route Handoff Checklist',
    description: 'Create per-route acceptance checks for the selected target site.',
    command: 'route-checklist',
    safety: 'read-only',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => routeArgs(['--manifest', state.manifestPath, '--repo', state.repoPath], state)
  },
  {
    id: 'storyblokDryRun',
    group: 'Apply',
    title: 'Storyblok Dry Run',
    description: 'Preview remote folders, components, assets, presets, and draft stories.',
    command: 'storyblok-apply',
    safety: 'dry-run',
    requirements: ['manifestPath'],
    args: (state) => ['--manifest', state.manifestPath, '--dry-run']
  },
  {
    id: 'storyblokApply',
    group: 'Apply',
    title: 'Storyblok Real Apply',
    description: 'Create namespaced draft-only Storyblok resources. Does not publish content.',
    command: 'storyblok-apply',
    safety: 'remote-write',
    confirmation: 'Create namespaced Storyblok resources as drafts?',
    requirements: ['manifestPath'],
    args: (state) => ['--manifest', state.manifestPath]
  },
  {
    id: 'fullDryRun',
    group: 'Apply',
    title: 'Full Dry Run',
    description: 'Preview repository and Storyblok operations without writing target resources.',
    command: 'apply',
    safety: 'dry-run',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => applyArgs(state, ['--dry-run'])
  },
  {
    id: 'fullApply',
    group: 'Apply',
    title: 'Full Real Apply',
    description: 'Generate isolated repository files and create draft-only Storyblok resources.',
    command: 'apply',
    safety: 'local-and-remote-write',
    confirmation: 'Run the full additive-only apply against this repository and Storyblok space?',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => applyArgs(state)
  },
  {
    id: 'wireRoutesDryRun',
    group: 'Apply',
    title: 'Wire Routes Dry Run',
    description: 'Preview additive route files for the target framework.',
    command: 'wire-routes',
    safety: 'dry-run',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => routeArgs(['--manifest', state.manifestPath, '--repo', state.repoPath, '--dry-run'], state)
  },
  {
    id: 'wireRoutesApply',
    group: 'Apply',
    title: 'Wire Routes Apply',
    description: 'Create additive route handoff files only when the route safety gate passes.',
    command: 'wire-routes',
    safety: 'local-write',
    confirmation: 'Create additive route files inside the selected repository?',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => routeArgs(['--manifest', state.manifestPath, '--repo', state.repoPath], state)
  },
  {
    id: 'validateLocal',
    group: 'Validate',
    title: 'Validate Local Output',
    description: 'Check generated integration files after a real repository apply.',
    command: 'validate',
    safety: 'read-only',
    requirements: ['manifestPath', 'repoPath'],
    args: (state) => ['--manifest', state.manifestPath, '--repo', state.repoPath]
  },
  {
    id: 'validateStoryblok',
    group: 'Validate',
    title: 'Validate Storyblok Drafts',
    description: 'Use the Content API to verify draft stories and asset fields.',
    command: 'validate-storyblok',
    safety: 'read-only',
    requirements: ['manifestPath'],
    args: (state) => ['--manifest', state.manifestPath, '--version', 'draft']
  },
  {
    id: 'storyblokVerify',
    group: 'Validate',
    title: 'Verify Storyblok Management State',
    description: 'Check that planned folders, components, presets, assets, and stories exist.',
    command: 'storyblok-verify',
    safety: 'read-only',
    requirements: ['manifestPath'],
    args: (state) => ['--manifest', state.manifestPath]
  },
  {
    id: 'report',
    group: 'Evidence',
    title: 'Generate Report',
    description: 'Build the consolidated local Markdown report.',
    command: 'report',
    safety: 'local-write',
    requirements: []
  },
  {
    id: 'reportHtml',
    group: 'Evidence',
    title: 'Generate HTML Report',
    description: 'Build a browser-friendly report for internal handoff.',
    command: 'report',
    safety: 'local-write',
    requirements: [],
    args: () => ['--html']
  },
  {
    id: 'evidenceIndex',
    group: 'Evidence',
    title: 'Evidence Index',
    description: 'Create a compact sign-off checklist of reports, links, files, and next commands.',
    command: 'evidence-index',
    safety: 'local-write',
    requirements: ['manifestPath'],
    args: (state) => withOptionalRepo(['--manifest', state.manifestPath], state)
  },
  {
    id: 'handoffPack',
    group: 'Evidence',
    title: 'Production Handoff Pack',
    description: 'Package the final handoff report for David, QA, editors, or a client team.',
    command: 'handoff-pack',
    safety: 'local-write',
    requirements: ['manifestPath'],
    args: (state) => withOptionalRepo(withOptionalTemplate(['--manifest', state.manifestPath], state), state)
  },
  {
    id: 'rollbackPreview',
    group: 'Evidence',
    title: 'Rollback Preview',
    description: 'Show exactly what an explicit rollback would target before anyone deletes resources.',
    command: 'rollback-preview',
    safety: 'read-only',
    requirements: ['manifestPath'],
    args: (state) => withOptionalRepo(['--manifest', state.manifestPath], state)
  },
  {
    id: 'visualEditorReadiness',
    group: 'Evidence',
    title: 'Visual Editor Readiness',
    description: 'Check whether Storyblok editors can preview the imported draft routes.',
    command: 'visual-editor-readiness',
    safety: 'read-only',
    requirements: ['manifestPath'],
    args: (state) => withOptionalRepo(['--manifest', state.manifestPath], state)
  }
];

export function createDefaultDesktopState({ cwd = process.cwd() } = {}) {
  return {
    cwd,
    workDir: DEFAULT_DESKTOP_WORK_DIR,
    manifestPath: DEFAULT_DESKTOP_MANIFEST,
    templatePath: 'templates/acme-campaign',
    repoPath: '',
    integrationId: '',
    framework: 'auto',
    route: ''
  };
}

export function getDesktopActions() {
  return DESKTOP_ACTIONS.map((action) => ({
    id: action.id,
    group: action.group,
    title: action.title,
    description: action.description,
    command: action.command,
    safety: action.safety,
    confirmation: action.confirmation || null,
    requirements: [...(action.requirements || [])]
  }));
}

export function findDesktopAction(actionId) {
  return DESKTOP_ACTIONS.find((action) => action.id === actionId) || null;
}

export function buildDesktopCommand(actionId, rawState = {}) {
  const action = findDesktopAction(actionId);
  if (!action) throw new Error(`Unknown desktop action: ${actionId}`);
  const state = normalizeDesktopState(rawState);
  const missing = missingRequirements(action, state);
  if (missing.length) {
    throw new Error(`Cannot run ${action.title}; missing ${missing.map((key) => FIELD_LABELS[key] || key).join(', ')}.`);
  }

  const actionArgs = typeof action.args === 'function' ? action.args(state) : [];
  const args = [
    action.command,
    ...actionArgs,
    '--work-dir',
    state.workDir
  ];

  return {
    action: getDesktopActions().find((entry) => entry.id === action.id),
    args,
    cwd: state.cwd,
    workDir: state.workDir,
    manifestPath: state.manifestPath,
    commandLine: formatCliInvocation(args)
  };
}

export function missingRequirements(actionOrId, rawState = {}) {
  const action = typeof actionOrId === 'string' ? findDesktopAction(actionOrId) : actionOrId;
  if (!action) return ['action'];
  const state = normalizeDesktopState(rawState);
  return (action.requirements || []).filter((field) => !state[field]);
}

export function normalizeDesktopState(rawState = {}) {
  const cwd = normalizeString(rawState.cwd) || process.cwd();
  const workDir = normalizeString(rawState.workDir) || DEFAULT_DESKTOP_WORK_DIR;
  const manifestPath = normalizeString(rawState.manifestPath) || path.join(workDir, 'integration-manifest.json');
  return {
    cwd,
    workDir,
    manifestPath,
    templatePath: normalizeString(rawState.templatePath),
    repoPath: normalizeString(rawState.repoPath),
    integrationId: normalizeIntegrationId(rawState.integrationId),
    framework: normalizeFramework(rawState.framework),
    route: normalizeString(rawState.route)
  };
}

export function sanitizeSessionEnv(values = {}) {
  const env = {};
  assignEnv(env, 'STORYBLOK_MANAGEMENT_TOKEN', values.storyblokManagementToken);
  assignEnv(env, 'STORYBLOK_SPACE_ID', values.storyblokSpaceId);
  assignEnv(env, 'STORYBLOK_PREVIEW_TOKEN', values.storyblokPreviewToken);
  assignEnv(env, 'STORYBLOK_REGION', values.storyblokRegion);
  assignEnv(env, 'NETLIFY_AUTH_TOKEN', values.netlifyAuthToken);
  assignEnv(env, 'NETLIFY_SITE_ID', values.netlifySiteId);
  assignEnv(env, 'GITHUB_TOKEN', values.githubToken);
  assignEnv(env, 'GITLAB_TOKEN', values.gitlabToken);
  return env;
}

export function visibleSessionEnvKeys(values = {}) {
  return Object.keys(sanitizeSessionEnv(values)).sort();
}

export function redactDesktopOutput(text, secretValues = []) {
  let value = String(text || '');
  for (const secret of secretValues.map((item) => String(item || '')).filter((item) => item.length >= 4)) {
    value = value.split(secret).join('[REDACTED]');
  }
  return value
    .replace(/(STORYBLOK_(?:MANAGEMENT|PREVIEW|PUBLIC|DELIVERY)_TOKEN=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:GITHUB|GITLAB|NETLIFY|GH)_TOKEN=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]')
    .replace(/(token|secret|password|authorization)(["':=\s]+)([A-Za-z0-9._-]{8,})/gi, '$1$2[REDACTED]');
}

export function desktopArtifactHints(workDir = DEFAULT_DESKTOP_WORK_DIR) {
  const base = normalizeString(workDir) || DEFAULT_DESKTOP_WORK_DIR;
  return [
    artifact('Integration Manifest', base, 'integration-manifest.json'),
    artifact('Plan Validation', base, 'plan-validation.json'),
    artifact('Report', base, 'report.md'),
    artifact('HTML Report', base, 'report.html'),
    artifact('Apply Result', base, 'apply-result.json'),
    artifact('Storyblok Apply Result', base, 'storyblok-apply-result.json'),
    artifact('Storyblok Draft Stories', base, 'storyblok-draft-stories-result.json'),
    artifact('Storyblok Content Validation', base, 'storyblok-content-validation.json'),
    artifact('Storyblok Verification', base, 'storyblok-management-verification.json'),
    artifact('Client Review Gate', base, 'client-review-gate-report.md'),
    artifact('Platform Readiness', base, 'platform-readiness-report.md'),
    artifact('Route Handoff Checklist', base, 'route-handoff-checklist.md'),
    artifact('Route Handoff Report', base, 'route-handoff-report.md'),
    artifact('Evidence Index', base, 'handoff-evidence-index.md'),
    artifact('Production Handoff Pack', base, 'production-handoff-pack.md'),
    artifact('Rollback Preview', base, 'rollback-preview.json')
  ];
}

function applyArgs(state, extra = []) {
  const args = ['--manifest', state.manifestPath, '--repo', state.repoPath];
  if (state.templatePath) args.push('--template', state.templatePath);
  if (state.framework) args.push('--framework', state.framework);
  return [...args, ...extra];
}

function routeArgs(args, state) {
  if (state.route) args.push('--route', state.route);
  return args;
}

function withOptionalRepo(args, state) {
  if (state.repoPath) args.push('--repo', state.repoPath);
  return args;
}

function withOptionalTemplate(args, state) {
  if (state.templatePath) args.push('--template', state.templatePath);
  return args;
}

function formatCliInvocation(args) {
  return `html-to-storyblok ${args.map(formatShellToken).join(' ')}`;
}

function formatShellToken(value) {
  const token = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeIntegrationId(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeFramework(value) {
  const framework = normalizeString(value || 'auto').toLowerCase();
  return ['auto', 'astro', 'next', 'nuxt', 'vue', 'react', 'static'].includes(framework) ? framework : 'auto';
}

function assignEnv(env, name, value) {
  const normalized = normalizeString(value);
  if (normalized) env[name] = normalized;
}

function artifact(label, base, name) {
  return {
    label,
    name,
    path: path.join(base, name)
  };
}
