import path from 'node:path';
import { checkLiveAccess } from './access.js';
import { DEFAULT_CONFIG, loadConfig, parseSettingAssignment, saveConfig, updateConfigValue } from './config.js';
import { discoverRepositories, discoverTemplates, isRepository } from './discovery.js';
import { createDoctorReport } from './doctor.js';
import { loadEnvironment } from './env.js';
import { DEFAULT_WORK_DIR, ensureWorkDir, writeArtifact } from './evidence.js';
import { inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { createIntegrationPlan } from './planner.js';
import { storyblokPrefixForIntegrationId, validatePlan } from './policy.js';
import { createReport, writeMarkdownReport } from './reporter.js';
import { inspectStoryblokSpace } from './storyblok.js';
import { confirm, createTerminal, promptInput, promptSecret, selectOption } from './terminal-ui.js';
import { pathExists, readJson } from './utils.js';
import { validateIntegration } from './validator.js';
import { applyManifest, applyStoryblokOnly } from './workflow.js';

const MANIFEST_NAME = 'integration-manifest.json';
const VALIDATION_NAME = 'plan-validation.json';
const STORYBLOK_ONLY_REPOSITORY = '__storyblok_only__';

export async function runInteractiveApp({
  args = {},
  input,
  output,
  answers = null,
  cwd = process.cwd()
} = {}) {
  const answerQueue = Array.isArray(answers) ? [...answers] : null;
  const config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: args.no_interactive ? false : undefined
  });
  const workDir = String(args.work_dir || config.default_output_folder || DEFAULT_WORK_DIR);
  await ensureWorkDir(workDir);

  const manifestPath = path.join(workDir, MANIFEST_NAME);
  if (await pathExists(manifestPath)) {
    terminal.header('HTML -> Storyblok', 'Safety-first template integration');
    terminal.status('Previous integration detected', 'success', manifestPath);
    const resumeChoice = await selectOption(terminal, {
      message: 'What would you like to do?',
      choices: [
        { label: 'Resume Previous Integration', value: 'resume' },
        { label: 'Start New Integration', value: 'new' },
        { label: 'Main Menu', value: 'home' },
        { label: 'Exit', value: 'exit' }
      ],
      answers: answerQueue
    });
    if (resumeChoice === 'resume') return runContinueExistingIntegration({ terminal, args, config, workDir, answers: answerQueue, cwd });
    if (resumeChoice === 'new') return runCreateIntegration({ terminal, args, config, workDir, answers: answerQueue, cwd });
    if (resumeChoice === 'exit' || resumeChoice === null) return { action: 'exit' };
  }

  return runHomeScreen({ terminal, args, config, workDir, answers: answerQueue, cwd });
}

export async function runDashboard({
  args = {},
  input,
  output,
  cwd = process.cwd()
} = {}) {
  const config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: false
  });
  const model = await createDashboardModel({
    workDir: String(args.work_dir || config.default_output_folder || DEFAULT_WORK_DIR),
    cwd,
    config,
    env: (await loadEnvironment({ cwd, repoPath: config.default_repository || null, config })).env
  });
  renderDashboard(terminal, model);
  return model;
}

export async function runSettings({
  args = {},
  input,
  output,
  answers = null
} = {}) {
  const answerQueue = Array.isArray(answers) ? [...answers] : null;
  let config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: args.no_interactive ? false : undefined
  });

  if (args.set) {
    const { key, value } = parseSettingAssignment(String(args.set));
    config = updateConfigValue(config, key, value);
    config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
    renderSettings(terminal, config);
    return config;
  }

  if (args.show || !terminal.interactive) {
    renderSettings(terminal, config);
    return config;
  }

  terminal.header('HTML -> Storyblok Settings', 'Local defaults only. Secrets are never stored.');
  while (true) {
    renderSettings(terminal, config);
    const choice = await selectOption(terminal, {
      message: 'Choose a setting to edit',
      choices: [
        ...Object.keys(DEFAULT_CONFIG).map((key) => ({ label: labelForSetting(key), value: key })),
        { label: 'Exit', value: 'exit' }
      ],
      answers: answerQueue
    });
    if (!choice || choice === 'exit') return config;
    const value = await promptInput(terminal, {
      message: labelForSetting(choice),
      defaultValue: String(config[choice] ?? ''),
      answers: answerQueue
    });
    config = updateConfigValue(config, choice, value);
    config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
  }
}

export async function runDoctorCommand({
  args = {},
  input,
  output,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: false
  });
  const session = await loadEnvironment({ cwd, repoPath: config.default_repository || null, env, config });
  const report = await createDoctorReport({ cwd, config, env: session.env });
  renderDoctor(terminal, report);
  return report;
}

export async function runReportViewer({
  args = {},
  input,
  output,
  answers = null
} = {}) {
  const answerQueue = Array.isArray(answers) ? [...answers] : null;
  const config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: args.no_interactive ? false : undefined
  });
  const workDir = String(args.work_dir || config.default_output_folder || DEFAULT_WORK_DIR);
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  await renderReportViewer(terminal, report, reportPath, answerQueue);
  return { ...report, markdown_report: reportPath };
}

export async function createDashboardModel({
  workDir = DEFAULT_WORK_DIR,
  cwd = process.cwd(),
  config = {},
  env = process.env
} = {}) {
  const repoPath = config.default_repository ? path.resolve(cwd, config.default_repository) : cwd;
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  const validationPath = path.join(workDir, VALIDATION_NAME);
  const assetsPath = path.join(workDir, 'storyblok-assets-result.json');
  const componentPath = path.join(workDir, 'storyblok-components-result.json');
  const access = checkLiveAccess(env);
  const manifest = await readOptionalJson(manifestPath);
  const validation = await readOptionalJson(validationPath);
  const assetsResult = await readOptionalJson(assetsPath);
  const componentResult = await readOptionalJson(componentPath);
  let repository = null;
  try {
    repository = await inspectRepository(repoPath);
  } catch {
    repository = null;
  }

  return {
    repository_path: repoPath,
    framework: repository?.framework?.name || config.preferred_framework || 'Unknown',
    storyblok_connected: access.storyblok.ready,
    netlify_connected: access.netlify.ready || Boolean(repository?.netlify?.present),
    last_integration: manifest?.integration_id || null,
    validation: validation ? validation.valid ? 'Passed' : 'Failed' : 'Not run',
    pending_draft_stories: count(manifest?.storyblok?.stories_to_create),
    generated_components: componentResult ? count(componentResult) : count(manifest?.storyblok?.components_to_create),
    assets_uploaded: assetsResult ? count(assetsResult) : 0
  };
}

async function runHomeScreen({ terminal, args, config, workDir, answers, cwd }) {
  while (true) {
    const repositoryDetected = await isRepository(cwd);
    terminal.header('HTML -> Storyblok', 'Safety-first template integration');
    terminal.section('Project');
    terminal.status(repositoryDetected ? 'Repository detected' : 'Repository not detected', repositoryDetected ? 'success' : 'warning');
    terminal.line('');

    const action = await selectOption(terminal, {
      message: 'What would you like to do?',
      choices: [
        { label: 'Create New Integration', value: 'create' },
        { label: 'Test Storyblok Only', value: 'storyblok-only' },
        { label: 'Continue Existing Integration', value: 'continue' },
        { label: 'Validate Integration', value: 'validate' },
        { label: 'Review Storyblok', value: 'storyblok' },
        { label: 'Review Repository', value: 'repository' },
        { label: 'Review Template', value: 'template' },
        { label: 'Generate Report', value: 'report' },
        { label: 'Settings', value: 'settings' },
        { label: 'Exit', value: 'exit' }
      ],
      answers
    });

    if (!action || action === 'exit') return { action: 'exit' };
    if (action === 'create') return runCreateIntegration({ terminal, args, config, workDir, answers, cwd });
    if (action === 'storyblok-only') return runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd });
    if (action === 'continue') return runContinueExistingIntegration({ terminal, args, config, workDir, answers, cwd });
    if (action === 'validate') return runValidateExistingPlan({ terminal, workDir });
    if (action === 'storyblok') return runReviewStoryblok({ terminal, args, config, workDir, answers, cwd });
    if (action === 'repository') return runReviewRepository({ terminal, config, workDir, answers, cwd });
    if (action === 'template') return runReviewTemplate({ terminal, config, workDir, answers, cwd });
    if (action === 'report') return runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers });
    if (action === 'settings') return runSettings({ args, input: terminal.input, output: terminal.output, answers });
  }
}

async function runCreateIntegration({ terminal, args, config, workDir, answers, cwd }) {
  terminal.header('Create New Integration', 'Guided import wizard');

  const templatePath = await chooseTemplate({ terminal, config, answers, cwd });
  if (!templatePath) return { action: 'cancelled' };

  const repoPath = await chooseRepository({ terminal, config, answers, cwd, allowStoryblokOnly: true });
  if (!repoPath) return { action: 'cancelled' };
  if (repoPath === STORYBLOK_ONLY_REPOSITORY) {
    return runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd, templatePath });
  }

  const repository = await terminal.task('Inspect Repository', async () => {
    const inspection = await inspectRepository(repoPath);
    await writeArtifact(workDir, 'repository-inspection.json', inspection);
    return inspection;
  });
  renderRepositorySummary(terminal, repository);

  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd, repoPath });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: false });

  const storyblok = await terminal.task('Inspect Storyblok', async () => {
    const shouldInspectRemote = args.remote || (terminal.interactive && checkLiveAccess(sessionEnv).storyblok.ready);
    const inspection = shouldInspectRemote
      ? await safeInspectStoryblokSpace({ terminal, env: sessionEnv })
      : inspectStoryblokEnvironment(sessionEnv);
    await writeArtifact(workDir, 'storyblok-access.json', inspection);
    return inspection;
  });
  renderStoryblokSummary(terminal, storyblok, config, sessionEnv);

  const template = await terminal.task('Inspect Template', async () => {
    const inventory = await inspectTemplate(templatePath);
    await writeArtifact(workDir, 'template-inventory.json', inventory);
    return inventory;
  });
  renderTemplateSummary(terminal, template);

  const defaultIntegrationId = slugify(`${path.basename(templatePath)}-v1`);
  const integrationId = await promptInput(terminal, {
    message: 'Integration ID',
    defaultValue: defaultIntegrationId,
    answers
  });
  const storyblokPrefix = storyblokPrefixForIntegrationId(integrationId);
  const repositoryNamespace = `src/integrations/${integrationId}`;
  const framework = frameworkValue(repository.framework?.name, config.preferred_framework);

  terminal.panel('Integration Preview', [
    ['Storyblok Prefix', storyblokPrefix, 'success'],
    ['Repository Namespace', repositoryNamespace, 'success'],
    ['CSS Root', `.hts-${integrationId}-root`, 'success'],
    ['Storyblok Components', `${storyblokPrefix}hero`, 'success'],
    ['Draft Story', `integration-preview/${integrationId}`, 'success']
  ]);

  const manifest = await terminal.task('Create Integration Plan', async () => {
    const schemaOverride = await readTemplateSchemaOverrides(templatePath);
    const plan = await createIntegrationPlan({
      integrationId,
      repositoryNamespace,
      templatePath,
      framework,
      schemaOverrides: schemaOverride?.overrides || null,
      schemaOverridesPath: schemaOverride?.path || null
    });
    await writeArtifact(workDir, MANIFEST_NAME, plan);
    await writeArtifact(workDir, VALIDATION_NAME, plan.validation || validatePlan(plan));
    return plan;
  });
  renderPlanSummary(terminal, manifest);

  const validation = validatePlan(manifest);
  await writeArtifact(workDir, VALIDATION_NAME, validation);
  renderValidationSummary(terminal, validation);
  if (!validation.valid) {
    return { action: 'create_integration', status: 'blocked', manifest, validation };
  }

  const dryRun = await terminal.task('Dry Run Apply', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: true, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
  ));

  terminal.status('Dry run complete', 'success');
  const proceed = await confirm(terminal, {
    message: 'Proceed with real apply?',
    defaultValue: false,
    answers
  });

  if (!proceed) {
    const report = await createReport(workDir);
    const reportPath = await writeMarkdownReport(workDir, report);
    terminal.panel('Integration Paused', [
      ['Status', 'Dry run completed. Real apply was not run.', 'warning'],
      ['Report', reportPath, 'success']
    ]);
    return { action: 'create_integration', status: 'dry_run_complete', manifest, validation, dry_run: dryRun, report: reportPath };
  }

  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  const result = await terminal.task('Apply Integration', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: false, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  renderCompletion(terminal, result, reportPath);
  return { action: 'create_integration', status: 'complete', manifest, validation, result, report: reportPath };
}

async function runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd, templatePath = null }) {
  terminal.header('Test Storyblok Only', 'Create Storyblok components, assets, and a draft story without selecting a repository');

  const selectedTemplatePath = templatePath || await chooseTemplate({ terminal, config, answers, cwd });
  if (!selectedTemplatePath) return { action: 'storyblok_only_integration', status: 'cancelled' };

  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: false });

  const storyblok = await terminal.task('Inspect Storyblok', async () => {
    const shouldInspectRemote = args.remote || (terminal.interactive && checkLiveAccess(sessionEnv).storyblok.ready);
    const inspection = shouldInspectRemote
      ? await safeInspectStoryblokSpace({ terminal, env: sessionEnv })
      : inspectStoryblokEnvironment(sessionEnv);
    await writeArtifact(workDir, 'storyblok-access.json', inspection);
    return inspection;
  });
  renderStoryblokSummary(terminal, storyblok, config, sessionEnv);

  const template = await terminal.task('Inspect Template', async () => {
    const inventory = await inspectTemplate(selectedTemplatePath);
    await writeArtifact(workDir, 'template-inventory.json', inventory);
    return inventory;
  });
  renderTemplateSummary(terminal, template);

  const defaultIntegrationId = slugify(`${path.basename(selectedTemplatePath)}-storyblok-test-v1`);
  const integrationId = await promptInput(terminal, {
    message: 'Integration ID',
    defaultValue: defaultIntegrationId,
    answers
  });
  const storyblokPrefix = storyblokPrefixForIntegrationId(integrationId);
  const repositoryNamespace = `src/integrations/${integrationId}`;
  const framework = 'static';

  terminal.panel('Integration Preview', [
    ['Storyblok Prefix', storyblokPrefix, 'success'],
    ['Repository Output', 'Skipped for this test', 'warning'],
    ['Repository Namespace', repositoryNamespace, 'warning'],
    ['Storyblok Components', `${storyblokPrefix}hero`, 'success'],
    ['Draft Story', `integration-preview/${integrationId}`, 'success']
  ]);

  const manifest = await terminal.task('Create Storyblok Plan', async () => {
    const schemaOverride = await readTemplateSchemaOverrides(selectedTemplatePath);
    const plan = await createIntegrationPlan({
      integrationId,
      repositoryNamespace,
      templatePath: selectedTemplatePath,
      framework,
      schemaOverrides: schemaOverride?.overrides || null,
      schemaOverridesPath: schemaOverride?.path || null
    });
    await writeArtifact(workDir, MANIFEST_NAME, plan);
    await writeArtifact(workDir, VALIDATION_NAME, plan.validation || validatePlan(plan));
    return plan;
  });
  renderStoryblokOnlyPlanSummary(terminal, manifest);

  const validation = validatePlan(manifest);
  await writeArtifact(workDir, VALIDATION_NAME, validation);
  renderValidationSummary(terminal, validation);
  if (!validation.valid) {
    return { action: 'storyblok_only_integration', status: 'blocked', manifest, validation };
  }

  const dryRun = await terminal.task('Dry Run Storyblok Apply', async () => applyStoryblokOnly(
    manifest,
    { dry_run: true, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
  ));

  terminal.status('Storyblok dry run complete', 'success');
  const proceed = await confirm(terminal, {
    message: 'Proceed with real Storyblok apply?',
    defaultValue: false,
    answers
  });

  if (!proceed) {
    const report = await createReport(workDir);
    const reportPath = await writeMarkdownReport(workDir, report);
    terminal.panel('Storyblok Test Paused', [
      ['Status', 'Dry run completed. Real Storyblok apply was not run.', 'warning'],
      ['Repository', 'Skipped', 'warning'],
      ['Report', reportPath, 'success']
    ]);
    return { action: 'storyblok_only_integration', status: 'dry_run_complete', manifest, validation, dry_run: dryRun, report: reportPath };
  }

  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  const result = await terminal.task('Apply Storyblok Integration', async () => applyStoryblokOnly(
    manifest,
    { dry_run: false, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  renderStoryblokOnlyCompletion(terminal, result, reportPath);
  return { action: 'storyblok_only_integration', status: 'complete', manifest, validation, result, report: reportPath };
}

async function runContinueExistingIntegration({ terminal, args, config, workDir, answers, cwd }) {
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) {
    terminal.status('No previous integration found', 'warning', manifestPath);
    return { action: 'continue_integration', status: 'missing' };
  }
  const manifest = await readJson(manifestPath);
  terminal.header('Continue Existing Integration', manifest.integration_id);
  renderPlanSummary(terminal, manifest);
  const validation = validatePlan(manifest);
  renderValidationSummary(terminal, validation);

  const action = await selectOption(terminal, {
    message: 'Choose next step',
    choices: [
      { label: 'Run Storyblok Dry Run', value: 'storyblok-dry-run' },
      { label: 'Run Real Storyblok Apply', value: 'storyblok-apply' },
      { label: 'Run Full Dry Run', value: 'dry-run' },
      { label: 'Run Full Real Apply', value: 'apply' },
      { label: 'Validate Local Output', value: 'validate' },
      { label: 'View Latest Report', value: 'report' },
      { label: 'Back', value: 'back' }
    ],
    answers
  });
  if (!action || action === 'back') return { action: 'continue_integration', status: 'cancelled' };
  if (action === 'report') return runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers });

  if (action === 'storyblok-dry-run' || action === 'storyblok-apply') {
    const realStoryblokApply = action === 'storyblok-apply';
    let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
    if (realStoryblokApply) {
      sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
    }
    const result = await terminal.task(realStoryblokApply ? 'Apply Storyblok Integration' : 'Dry Run Storyblok Apply', async () => applyStoryblokOnly(
      manifest,
      { dry_run: !realStoryblokApply, env: sessionEnv },
      workDir,
      { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
    ));
    const report = await createReport(workDir);
    const reportPath = await writeMarkdownReport(workDir, report);
    if (realStoryblokApply) renderStoryblokOnlyCompletion(terminal, result, reportPath);
    else terminal.panel('Storyblok Dry Run Complete', [['Repository', 'Skipped', 'warning'], ['Report', reportPath, 'success']]);
    return { action: 'continue_integration', status: realStoryblokApply ? 'complete' : 'dry_run_complete', result, report: reportPath };
  }

  const repoPath = await chooseRepository({ terminal, config, answers, cwd });
  if (!repoPath) return { action: 'continue_integration', status: 'cancelled' };
  const templatePath = manifest.template?.source_path;
  const framework = frameworkValue(manifest.template?.framework, config.preferred_framework);
  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd, repoPath });

  if (action === 'validate') {
    const localValidation = await terminal.task('Validate Local Output', async () => validateIntegration(manifest, { repoPath }));
    await writeArtifact(workDir, 'validation-result.json', localValidation);
    renderLocalValidationSummary(terminal, localValidation);
    return { action: 'continue_integration', status: localValidation.status, validation: localValidation };
  }

  const realApply = action === 'apply';
  if (realApply) {
    sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  }
  const result = await terminal.task(realApply ? 'Apply Integration' : 'Dry Run Apply', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: !realApply, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total) }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  if (realApply) renderCompletion(terminal, result, reportPath);
  else terminal.panel('Dry Run Complete', [['Report', reportPath, 'success']]);
  return { action: 'continue_integration', status: realApply ? 'complete' : 'dry_run_complete', result, report: reportPath };
}

async function runValidateExistingPlan({ terminal, workDir }) {
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) {
    terminal.status('No integration manifest found', 'warning', manifestPath);
    return { action: 'validate_plan', status: 'missing' };
  }
  const manifest = await readJson(manifestPath);
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, VALIDATION_NAME, validation);
  renderValidationSummary(terminal, validation);
  return { action: 'validate_plan', status: validation.valid ? 'passed' : 'failed', validation };
}

async function runReviewStoryblok({ terminal, args, config, workDir, answers, cwd }) {
  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: false });
  const inspection = await terminal.task('Review Storyblok', async () => {
    const shouldInspectRemote = args.remote || (terminal.interactive && checkLiveAccess(sessionEnv).storyblok.ready);
    const result = shouldInspectRemote
      ? await safeInspectStoryblokSpace({ terminal, env: sessionEnv })
      : inspectStoryblokEnvironment(sessionEnv);
    await writeArtifact(workDir, 'storyblok-access.json', result);
    return result;
  });
  renderStoryblokSummary(terminal, inspection, config, sessionEnv);
  return { action: 'review_storyblok', inspection };
}

async function createSessionEnvironment({ terminal, config, cwd, repoPath = null, env = process.env }) {
  const session = await loadEnvironment({ cwd, repoPath, env, config });
  if (session.files_loaded.length > 0) {
    terminal.status('Loaded environment files', 'info', session.files_loaded.map((file) => path.relative(cwd, file)).join(', '));
  }
  return session.env;
}

async function promptForStoryblokCredentials({ terminal, env, config, answers, required = false }) {
  if (!terminal.interactive) return env;
  const nextEnv = { ...env };
  const before = checkLiveAccess(nextEnv);
  const needsManagement = required || !before.storyblok.ready;
  const needsPreview = !before.storyblok_content.ready;
  if (!needsManagement && !needsPreview) return nextEnv;

  terminal.section('Storyblok Credentials');
  terminal.status('Values entered here are used for this session only', 'info');

  if (needsManagement && !hasAny(nextEnv, ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_OAUTH_TOKEN', 'STORYBLOK_PERSONAL_ACCESS_TOKEN'])) {
    const token = await promptSecret(terminal, {
      message: required ? 'Management API token' : 'Management API token (optional, press Enter to skip)',
      answers
    });
    if (token) nextEnv.STORYBLOK_MANAGEMENT_TOKEN = token;
  }
  if (needsManagement && !hasAny(nextEnv, ['STORYBLOK_SPACE_ID', 'SB_SPACE_ID'])) {
    const spaceId = await promptInput(terminal, {
      message: required ? 'Storyblok Space ID' : 'Storyblok Space ID (optional, press Enter to skip)',
      answers
    });
    if (spaceId) nextEnv.STORYBLOK_SPACE_ID = spaceId;
  }
  if (!nextEnv.STORYBLOK_REGION) {
    const region = await promptInput(terminal, {
      message: 'Storyblok Region',
      defaultValue: config.storyblok_region || 'eu',
      answers
    });
    if (region) nextEnv.STORYBLOK_REGION = region;
  }
  if (needsPreview && !hasAny(nextEnv, ['STORYBLOK_PREVIEW_TOKEN', 'STORYBLOK_PUBLIC_TOKEN', 'STORYBLOK_DELIVERY_TOKEN'])) {
    const previewToken = await promptSecret(terminal, {
      message: 'Preview API token (optional, press Enter to skip)',
      answers
    });
    if (previewToken) nextEnv.STORYBLOK_PREVIEW_TOKEN = previewToken;
  }

  const after = checkLiveAccess(nextEnv);
  if (required && !after.storyblok.ready) {
    terminal.status('Storyblok Management API credentials are required for real apply', 'error');
  }
  return nextEnv;
}

async function safeInspectStoryblokSpace({ terminal, env }) {
  try {
    return await inspectStoryblokSpace({ env });
  } catch (error) {
    const fallback = inspectStoryblokEnvironment(env);
    terminal.status('Storyblok remote inspection failed', 'warning', 'Continuing with local credential readiness.');
    return {
      ...fallback,
      status: 'inspection_failed',
      remote_inspection_failed: true,
      reason: redactCredentialError(error?.message || String(error))
    };
  }
}

function redactCredentialError(message) {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*[A-Za-z0-9._-]+/gi, 'Authorization: [REDACTED]')
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function hasAny(env, names) {
  return names.some((name) => Boolean(env[name]));
}

async function runReviewRepository({ terminal, config, workDir, answers, cwd }) {
  const repoPath = await chooseRepository({ terminal, config, answers, cwd });
  if (!repoPath) return { action: 'review_repository', status: 'cancelled' };
  const inspection = await terminal.task('Review Repository', async () => {
    const result = await inspectRepository(repoPath);
    await writeArtifact(workDir, 'repository-inspection.json', result);
    return result;
  });
  renderRepositorySummary(terminal, inspection);
  return { action: 'review_repository', inspection };
}

async function runReviewTemplate({ terminal, config, workDir, answers, cwd }) {
  const templatePath = await chooseTemplate({ terminal, config, answers, cwd });
  if (!templatePath) return { action: 'review_template', status: 'cancelled' };
  const inspection = await terminal.task('Review Template', async () => {
    const result = await inspectTemplate(templatePath);
    await writeArtifact(workDir, 'template-inventory.json', result);
    return result;
  });
  renderTemplateSummary(terminal, inspection);
  return { action: 'review_template', inspection };
}

async function chooseTemplate({ terminal, config, answers, cwd }) {
  const templates = await discoverTemplates({ templatesFolder: config.templates_folder, cwd });
  terminal.section('Choose Template');
  terminal.line(`${config.templates_folder}/`);
  const choice = await selectOption(terminal, {
    message: 'Select a template',
    choices: [
      ...templates.map((template) => ({ label: template.label, value: template.path })),
      { label: 'Browse...', value: '__browse__' }
    ],
    answers
  });
  if (!choice) return null;
  if (choice !== '__browse__') return choice;
  return promptInput(terminal, {
    message: 'Template path',
    defaultValue: templates[0]?.path || path.resolve(cwd, config.templates_folder || 'templates'),
    answers
  });
}

async function readTemplateSchemaOverrides(templatePath) {
  const overridesPath = path.join(templatePath, 'schema-overrides.json');
  if (!(await pathExists(overridesPath))) return null;
  return {
    path: overridesPath,
    overrides: await readJson(overridesPath)
  };
}

async function chooseRepository({ terminal, config, answers, cwd, allowStoryblokOnly = false }) {
  const repositories = await discoverRepositories({ cwd });
  const configured = config.default_repository
    ? [{ label: config.default_repository, value: path.resolve(cwd, config.default_repository) }]
    : [];
  const seen = new Set(configured.map((entry) => entry.value));
  const choices = [
    ...(allowStoryblokOnly ? [{ label: 'Skip Repository - Storyblok only test', value: STORYBLOK_ONLY_REPOSITORY }] : []),
    ...configured,
    ...repositories.filter((repo) => !seen.has(repo.path)).map((repo) => ({ label: repo.label, value: repo.path })),
    { label: 'Browse...', value: '__browse__' }
  ];
  terminal.section('Choose Repository');
  const choice = await selectOption(terminal, {
    message: 'Select a repository',
    choices,
    answers
  });
  if (!choice) return null;
  if (choice !== '__browse__') return choice;
  return promptInput(terminal, {
    message: 'Repository path',
    defaultValue: configured[0]?.value || repositories[0]?.path || cwd,
    answers
  });
}

function renderDashboard(terminal, model) {
  terminal.header('HTML -> Storyblok Dashboard', 'Project status');
  terminal.panel('Project', [
    ['Framework', model.framework, model.framework === 'Unknown' ? 'warning' : 'success'],
    ['Storyblok', model.storyblok_connected ? 'Connected' : 'Not connected', model.storyblok_connected ? 'success' : 'warning'],
    ['Netlify', model.netlify_connected ? 'Connected' : 'Not connected', model.netlify_connected ? 'success' : 'warning'],
    ['Last Integration', model.last_integration || 'None', model.last_integration ? 'success' : 'warning'],
    ['Validation', model.validation, model.validation === 'Passed' ? 'success' : model.validation === 'Failed' ? 'error' : 'warning'],
    ['Pending Draft Stories', model.pending_draft_stories],
    ['Generated Components', model.generated_components],
    ['Assets Uploaded', model.assets_uploaded]
  ]);
}

function renderSettings(terminal, config) {
  terminal.header('HTML -> Storyblok Settings', 'Stored in ~/.html-to-storyblok/config.json unless --config is supplied');
  terminal.panel('Configuration', Object.keys(DEFAULT_CONFIG).map((key) => [labelForSetting(key), config[key]]));
}

function renderDoctor(terminal, report) {
  terminal.header('HTML -> Storyblok Doctor', 'Environment and project readiness');
  for (const check of report.checks) {
    terminal.status(`${check.name}: ${check.detail}`, check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'warning');
    if (check.fix && check.status !== 'passed') terminal.line(terminal.style('dim', `  fix: ${check.fix}`));
  }
  terminal.line('');
}

async function renderReportViewer(terminal, report, reportPath, answers) {
  terminal.header('View Latest Report', reportPath);
  const sections = [
    { label: 'Summary', value: 'summary' },
    { label: 'Validation', value: 'validation' },
    { label: 'Evidence', value: 'evidence' },
    { label: 'Generated Files', value: 'files' },
    { label: 'Warnings', value: 'warnings' },
    { label: 'Failures', value: 'failures' }
  ];
  const section = terminal.interactive
    ? await selectOption(terminal, { message: 'Choose report section', choices: sections, answers })
    : 'summary';
  if (section === 'validation') {
    terminal.panel('Validation', [
      ['Latest Validation', report.latest_validation?.status || 'Not run', report.latest_validation?.status === 'passed' ? 'success' : 'warning'],
      ['Plan Valid', report.safety_confirmation.plan_valid ? 'Yes' : 'No', report.safety_confirmation.plan_valid ? 'success' : 'warning']
    ]);
  } else if (section === 'evidence') {
    terminal.panel('Evidence', [
      ['Entries', report.evidence_entries],
      ['Commands Started', report.commands_started],
      ['Commands Completed', report.commands_completed]
    ]);
  } else if (section === 'files') {
    const manifests = report.artifacts.filter((artifact) => artifact.type === 'integration_manifest');
    terminal.panel('Generated Files', manifests.length
      ? manifests.map((artifact) => [artifact.integration_id, `${artifact.repository_files} repository files`])
      : [['Generated Files', 'None recorded', 'warning']]);
  } else if (section === 'warnings') {
    terminal.panel('Warnings', [
      ['Deploy Preview', report.safety_confirmation.deploy_preview_verified ? 'Verified' : 'Not verified', report.safety_confirmation.deploy_preview_verified ? 'success' : 'warning'],
      ['Unresolved Failures', report.safety_confirmation.unresolved_failures, report.safety_confirmation.unresolved_failures ? 'warning' : 'success']
    ]);
  } else if (section === 'failures') {
    terminal.panel('Failures', report.commands_failed.length
      ? report.commands_failed.map((failure) => [failure.command, failure.message, 'error'])
      : [['Failures', 'None', 'success']]);
  } else {
    terminal.panel('Summary', [
      ['Work Directory', report.work_dir],
      ['Evidence Entries', report.evidence_entries],
      ['Commands Completed', report.commands_completed],
      ['Latest Validation', report.latest_validation?.status || 'Not run', report.latest_validation?.status === 'passed' ? 'success' : 'warning'],
      ['Report', reportPath, 'success']
    ]);
  }
}

function renderRepositorySummary(terminal, repository) {
  const hasStoryblok = count(repository.storyblok_sdk) > 0 || count(repository.storyblok_rendering_pattern) > 0;
  const hasTailwind = String(repository.styling_system || '').includes('Tailwind');
  terminal.panel('Framework', [
    ['Framework', repository.framework?.name || 'Uncertain', repository.framework?.name !== 'Uncertain' ? 'success' : 'warning'],
    ['Storyblok', hasStoryblok ? 'Installed' : 'Not detected', hasStoryblok ? 'success' : 'warning'],
    ['TypeScript', repository.typescript ? 'Enabled' : 'Not detected', repository.typescript ? 'success' : 'warning'],
    ['Tailwind', hasTailwind ? 'Installed' : 'Not detected', hasTailwind ? 'success' : 'warning'],
    ['Netlify', repository.netlify?.present ? 'Found' : 'Not found', repository.netlify?.present ? 'success' : 'warning'],
    ['Package Manager', repository.package_manager || 'Unknown', repository.package_manager ? 'success' : 'warning']
  ]);
}

function renderStoryblokSummary(terminal, storyblok, config, env = process.env) {
  const access = checkLiveAccess(env);
  const region = storyblok.region || env.STORYBLOK_REGION || config.storyblok_region || 'eu';
  terminal.panel('Storyblok', [
    ['Management API', access.storyblok.ready || storyblok.management_api_available ? 'Available' : 'Not configured', access.storyblok.ready || storyblok.management_api_available ? 'success' : 'warning'],
    ['Preview API', access.storyblok_content.ready || storyblok.preview_api_available ? 'Available' : 'Not configured', access.storyblok_content.ready || storyblok.preview_api_available ? 'success' : 'warning'],
    ['Region', String(region).toUpperCase()],
    ['Space', storyblok.space?.id || env.STORYBLOK_SPACE_ID || env.SB_SPACE_ID || 'Not configured', storyblok.space?.id || env.STORYBLOK_SPACE_ID || env.SB_SPACE_ID ? 'success' : 'warning'],
    ['Components', storyblok.components ? count(storyblok.components) : 'Not queried'],
    ['Stories', storyblok.stories ? count(storyblok.stories) : 'Not queried'],
    ['Assets', storyblok.assets ? count(storyblok.assets) : 'Not queried']
  ]);
}

function renderTemplateSummary(terminal, template) {
  const warnings = count(template.missing_assets) + count(template.accessibility_issues);
  terminal.panel('Template', [
    ['Pages', count(template.pages), count(template.pages) ? 'success' : 'warning'],
    ['Sections', count(template.shared_sections) + count(template.repeated_sections), 'success'],
    ['Assets', count(template.assets)],
    ['Fonts', count(template.fonts)],
    ['Scripts', count(template.behaviour_inventory)],
    ['Warnings', warnings, warnings ? 'warning' : 'success']
  ]);
}

function renderPlanSummary(terminal, manifest) {
  terminal.panel('Plan Summary', [
    ['Repository', `${count(manifest.repository?.files_to_create)} files to create`, 'success'],
    ['Storyblok Components', count(manifest.storyblok?.components_to_create), 'success'],
    ['Draft Stories', count(manifest.storyblok?.stories_to_create), 'success'],
    ['Storyblok Assets', count(manifest.storyblok?.assets_to_create), 'success'],
    ['Netlify', 'No changes', 'success'],
    ['Dependencies', 'No changes', 'success'],
    ['Safety', manifest.policy === 'additive-only-isolated' ? 'Additive Only' : manifest.policy, manifest.policy === 'additive-only-isolated' ? 'success' : 'warning']
  ]);
}

function renderStoryblokOnlyPlanSummary(terminal, manifest) {
  terminal.panel('Storyblok Plan Summary', [
    ['Repository', 'Skipped for this test', 'warning'],
    ['Storyblok Components', count(manifest.storyblok?.components_to_create), 'success'],
    ['Asset Folders', count(manifest.storyblok?.asset_folders_to_create), 'success'],
    ['Storyblok Assets', count(manifest.storyblok?.assets_to_create), 'success'],
    ['Draft Stories', count(manifest.storyblok?.stories_to_create), 'success'],
    ['Publish Content', manifest.authorisation?.publish_content ? 'Yes' : 'No', manifest.authorisation?.publish_content ? 'warning' : 'success'],
    ['Safety', manifest.policy === 'additive-only-isolated' ? 'Additive Only' : manifest.policy, manifest.policy === 'additive-only-isolated' ? 'success' : 'warning']
  ]);
}

function renderValidationSummary(terminal, validation) {
  terminal.panel('Validation', [
    ['Status', validation.valid ? 'Passed' : 'Failed', validation.valid ? 'success' : 'error'],
    ['Collisions', validation.violations?.some((violation) => /duplicate|collision/i.test(violation.reason)) ? 'Found' : 'None', validation.violations?.some((violation) => /duplicate|collision/i.test(violation.reason)) ? 'error' : 'success'],
    ['Unsafe Mutations', validation.violations?.some((violation) => /modify|dependency|deployment/i.test(violation.reason)) ? 'Found' : 'None', validation.violations?.some((violation) => /modify|dependency|deployment/i.test(violation.reason)) ? 'error' : 'success'],
    ['Runtime Coupling', validation.violations?.some((violation) => /reuse|coupling/i.test(violation.reason)) ? 'Found' : 'None', validation.violations?.some((violation) => /reuse|coupling/i.test(violation.reason)) ? 'error' : 'success'],
    ['Ready', validation.valid ? 'Ready to continue' : `${validation.violations.length} violations`, validation.valid ? 'success' : 'error']
  ]);
}

function renderLocalValidationSummary(terminal, validation) {
  terminal.panel('Local Validation', [
    ['Status', validation.status, validation.status === 'passed' ? 'success' : 'error'],
    ['Failed Checks', validation.failed_checks || 0, validation.failed_checks ? 'error' : 'success']
  ]);
}

function renderCompletion(terminal, result, reportPath) {
  terminal.header('Integration Complete', 'Additive-only workflow finished');
  terminal.panel('Repository', [
    ['Updated', result.dry_run ? 'Dry run only' : 'Yes', result.dry_run ? 'warning' : 'success']
  ]);
  terminal.panel('Storyblok', [
    ['Components Created', 'Completed', 'success'],
    ['Assets Uploaded', 'Completed', 'success'],
    ['Draft Story Created', 'Completed', 'success']
  ]);
  terminal.panel('Validation', [
    ['Passed', 'Yes', 'success']
  ]);
  terminal.panel('Report', [
    ['Path', reportPath, 'success']
  ]);
}

function renderStoryblokOnlyCompletion(terminal, result, reportPath) {
  terminal.header('Storyblok Integration Complete', 'Repository output was skipped');
  terminal.panel('Repository', [
    ['Updated', 'No', 'warning']
  ]);
  terminal.panel('Storyblok', [
    ['Components Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Assets Uploaded', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Draft Story Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success']
  ]);
  terminal.panel('Validation', [
    ['Passed', 'Yes', 'success']
  ]);
  terminal.panel('Report', [
    ['Path', reportPath, 'success']
  ]);
}

async function readOptionalJson(filePath) {
  if (!(await pathExists(filePath))) return null;
  return readJson(filePath);
}

function count(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'integration-v1';
}

function frameworkValue(name, fallback = 'static') {
  const normalized = String(name || fallback || 'static').toLowerCase();
  if (normalized.includes('astro')) return 'astro';
  if (normalized.includes('next')) return 'next';
  if (normalized.includes('nuxt')) return 'nuxt';
  if (normalized.includes('vue')) return 'vue';
  if (normalized.includes('react')) return 'react';
  if (normalized.includes('auto')) return 'auto';
  return 'static';
}

function labelForSetting(key) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
