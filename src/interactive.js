import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkLiveAccess } from './access.js';
import { CLI_BRANDING_LINES } from './branding.js';
import { DEFAULT_CONFIG, loadConfig, parseSettingAssignment, profileNames, saveConfig, updateConfigValue, updateProfileValue } from './config.js';
import { discoverRepositories, discoverTemplates, isRepository } from './discovery.js';
import { createDoctorReport } from './doctor.js';
import { loadEnvironment } from './env.js';
import { DEFAULT_WORK_DIR, ensureWorkDir, readEvidence, writeArtifact } from './evidence.js';
import { inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { createIntegrationPlan } from './planner.js';
import { storyblokPrefixForIntegrationId, validatePlan } from './policy.js';
import { createReport, writeHtmlReport, writeMarkdownReport } from './reporter.js';
import { createRollbackPreview } from './rollback.js';
import { wireRepositoryRoutes } from './route-handoff.js';
import { createDraftStories, createStoryblokAssetFolders, createStoryblokComponentGroups, createStoryblokComponents, createStoryblokInternalTags, createStoryblokPresets, inspectStoryblokContentStory, inspectStoryblokSpace, preflightStoryblokIntegration, reconcileStoryblokManifest, uploadStoryblokAssets, validateStoryblokDraftContent, verifyStoryblokManagementState } from './storyblok.js';
import { confirm, createTerminal, promptInput, promptSecret, selectOption } from './terminal-ui.js';
import { ensureArray, pathExists, readJson } from './utils.js';
import { validateIntegration } from './validator.js';
import { applyManifest, applyStoryblokOnly } from './workflow.js';

const MANIFEST_NAME = 'integration-manifest.json';
const VALIDATION_NAME = 'plan-validation.json';
const STORYBLOK_ONLY_REPOSITORY = '__storyblok_only__';
const ASCII_ART_PATH = new URL('../ascii-art.txt', import.meta.url);

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

  try {
    await renderOpeningBanner(terminal);
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
      if (resumeChoice === 'resume') {
        const result = await runContinueExistingIntegration({ terminal, args, config, workDir, answers: answerQueue, cwd });
        return continueInteractiveSession({ terminal, args, config, workDir, answers: answerQueue, cwd, result });
      }
      if (resumeChoice === 'new') {
        const result = await runCreateIntegration({ terminal, args, config, workDir, answers: answerQueue, cwd });
        return continueInteractiveSession({ terminal, args, config, workDir, answers: answerQueue, cwd, result });
      }
      if (resumeChoice === 'exit' || resumeChoice === null) return { action: 'exit' };
    }

    return await runHomeScreen({ terminal, args, config, workDir, answers: answerQueue, cwd });
  } finally {
    terminal.close();
  }
}

async function renderOpeningBanner(terminal) {
  if (!terminal.interactive) return;
  const banner = await readOpeningBanner();
  if (banner) terminal.line(terminal.style('id30Blue', banner.trimEnd()));
  for (const line of CLI_BRANDING_LINES) {
    terminal.line(terminal.style('dim', line));
  }
  terminal.line('');
}

async function readOpeningBanner() {
  try {
    return await readFile(ASCII_ART_PATH, 'utf8');
  } catch {
    return '';
  }
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
  answers = null,
  closeTerminal = true
} = {}) {
  const answerQueue = Array.isArray(answers) ? [...answers] : null;
  let config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
  const terminal = createTerminal({
    input,
    output,
    colorMode: args.color ? String(args.color) : config.color_mode,
    interactive: args.no_interactive ? false : undefined
  });

  try {
    if (args.profile && args.set) {
      const { key, value } = parseSettingAssignment(String(args.set));
      config = updateProfileValue(config, String(args.profile), key, value);
      config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
      renderProfiles(terminal, config);
      return config;
    }

    if (args.profile && !args.set) {
      config = updateConfigValue(config, 'active_profile', String(args.profile));
      config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
      renderProfiles(terminal, config);
      return config;
    }

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
          ...settingsKeys().map((key) => ({ label: labelForSetting(key), value: key })),
          { label: 'Profiles', value: '__profiles__' },
          { label: 'Exit', value: 'exit' }
        ],
        answers: answerQueue
      });
      if (!choice || choice === 'exit') return config;
      if (choice === '__profiles__') {
        await runProfileSettings({ terminal, config, args, answers: answerQueue });
        config = await loadConfig({ configPath: args.config ? String(args.config) : undefined });
        continue;
      }
      const value = await promptInput(terminal, {
        message: labelForSetting(choice),
        defaultValue: String(config[choice] ?? ''),
        answers: answerQueue
      });
      config = updateConfigValue(config, choice, value);
      config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
    }
  } finally {
    if (closeTerminal) terminal.close();
  }
}

async function runProfileSettings({ terminal, config, args, answers }) {
  while (true) {
    renderProfiles(terminal, config);
    const choice = await selectOption(terminal, {
      message: 'Profile action',
      choices: [
        { label: 'Activate Profile', value: 'activate' },
        { label: 'Create or Edit Profile', value: 'edit' },
        { label: 'Back', value: 'back' }
      ],
      answers
    });
    if (!choice || choice === 'back') return config;
    if (choice === 'activate') {
      const names = profileNames(config);
      const selected = names.length
        ? await selectOption(terminal, {
          message: 'Choose active profile',
          choices: [
            { label: 'None', value: '' },
            ...names.map((name) => ({ label: name, value: name }))
          ],
          answers
        })
        : await promptInput(terminal, {
          message: 'Profile name',
          answers
        });
      config = updateConfigValue(config, 'active_profile', selected || '');
      config = await saveConfig(config, { configPath: args.config ? String(args.config) : undefined });
      continue;
    }
    const profileName = await promptInput(terminal, {
      message: 'Profile name',
      defaultValue: profileNames(config)[0] || 'client-site',
      answers
    });
    const setting = await selectOption(terminal, {
      message: 'Profile setting',
      choices: settingsKeys().filter((key) => key !== 'active_profile').map((key) => ({ label: labelForSetting(key), value: key })),
      answers
    });
    if (!setting) continue;
    const value = await promptInput(terminal, {
      message: labelForSetting(setting),
      defaultValue: String(config.project_profiles?.[profileName]?.[setting] ?? config[setting] ?? ''),
      answers
    });
    config = updateProfileValue(config, profileName, setting, value);
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
  const report = await createDoctorReport({
    cwd,
    config,
    env: session.env,
    target: args.for ? String(args.for) : args.workflow ? String(args.workflow) : args.mode ? String(args.mode) : 'all'
  });
  renderDoctor(terminal, report);
  return report;
}

export async function runReportViewer({
  args = {},
  input,
  output,
  answers = null,
  closeTerminal = true
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
  try {
    const report = await createReport(workDir);
    const reportPath = await writeMarkdownReport(workDir, report);
    await renderReportViewer(terminal, report, reportPath, answerQueue);
    return { ...report, markdown_report: reportPath };
  } finally {
    if (closeTerminal) terminal.close();
  }
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
    generated_component_groups: count(manifest?.storyblok?.component_groups_to_create),
    generated_presets: count(manifest?.storyblok?.presets_to_create),
    generated_components: componentResult ? count(componentResult) : count(manifest?.storyblok?.components_to_create),
    assets_uploaded: assetsResult ? count(assetsResult) : 0
  };
}

async function runHomeScreen({ terminal, args, config, workDir, answers, cwd }) {
  let showGoalPicker = terminal.interactive;
  while (true) {
    const context = { terminal, args, config, workDir, answers, cwd };
    if (showGoalPicker) {
      showGoalPicker = false;
      const goalAction = await runGoalPicker({ terminal, answers });
      if (!goalAction || goalAction === 'exit') return { action: 'exit' };
      if (goalAction !== 'menu') {
        let result;
        try {
          result = await runHomeAction(goalAction, context);
        } catch (error) {
          result = await runFailureRecovery({
            terminal,
            args,
            config,
            workDir,
            answers,
            cwd,
            action: goalAction,
            error,
            retry: () => runHomeAction(goalAction, context)
          });
        }
        if (!terminal.interactive || result?.action === 'exit') return result;
        const next = await handleNextAction({ terminal, args, result, answers, workDir });
        if (next === 'exit') return { ...result, next_action: 'exit' };
        continue;
      }
    }

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
        { label: 'Test Credentials', value: 'credentials' },
        { label: 'Generate Report', value: 'report' },
        { label: 'Import History', value: 'history' },
        { label: 'Live Sandbox Test', value: 'sandbox' },
        { label: 'Settings', value: 'settings' },
        { label: 'Exit', value: 'exit' }
      ],
      answers
    });

    if (!action || action === 'exit') return { action: 'exit' };
    let result;
    try {
      result = await runHomeAction(action, context);
    } catch (error) {
      result = await runFailureRecovery({
        terminal,
        args,
        config,
        workDir,
        answers,
        cwd,
        action,
        error,
        retry: () => runHomeAction(action, context)
      });
    }
    if (!terminal.interactive || result?.action === 'exit') return result;

    const next = await handleNextAction({ terminal, args, result, answers, workDir });
    if (next === 'exit') return { ...result, next_action: 'exit' };
  }
}

async function runGoalPicker({ terminal, answers }) {
  terminal.header('Start Here', 'Choose the outcome you want. The CLI will pick the right workflow.');
  terminal.panel('Common Goals', [
    ['Full Import', 'Template, repository, Storyblok, validation, and report', 'success'],
    ['Storyblok Only', 'Components, assets, and draft stories without a repository', 'success'],
    ['Resume', 'Continue or recover an existing integration', 'info'],
    ['Evidence', 'Review reports, history, validation, and generated files', 'info']
  ]);
  return selectOption(terminal, {
    message: 'What are you trying to do?',
    choices: [
      { label: 'Import Template Into Existing Site', value: 'create' },
      { label: 'Test Storyblok Only', value: 'storyblok-only' },
      { label: 'Resume Failed Or Previous Import', value: 'continue' },
      { label: 'Validate Existing Import', value: 'validate' },
      { label: 'Set Up Or Test Credentials', value: 'credentials' },
      { label: 'View Reports And Evidence', value: 'report' },
      { label: 'Show Full Main Menu', value: 'menu' },
      { label: 'Exit', value: 'exit' }
    ],
    answers
  });
}

async function runHomeAction(action, context) {
  const { terminal, args, config, workDir, answers, cwd } = context;
  if (action === 'create') return runCreateIntegration({ terminal, args, config, workDir, answers, cwd });
  if (action === 'storyblok-only') return runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd });
  if (action === 'continue') return runContinueExistingIntegration({ terminal, args, config, workDir, answers, cwd });
  if (action === 'validate') return runValidateExistingPlan({ terminal, workDir });
  if (action === 'storyblok') return runReviewStoryblok({ terminal, args, config, workDir, answers, cwd });
  if (action === 'repository') return runReviewRepository({ terminal, config, workDir, answers, cwd });
  if (action === 'template') return runReviewTemplate({ terminal, config, workDir, answers, cwd });
  if (action === 'credentials') return runCredentialTestScreen({ terminal, config, workDir, answers, cwd });
  if (action === 'report') return runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers, closeTerminal: false });
  if (action === 'history') return runImportHistory({ terminal, workDir });
  if (action === 'sandbox') return runLiveSandboxWizard({ terminal, answers });
  if (action === 'settings') return runSettings({ args, input: terminal.input, output: terminal.output, answers, closeTerminal: false });
  return { action: 'unknown', status: 'ignored' };
}

async function runFailureRecovery({ terminal, args, config, workDir, answers, cwd, action, error, retry }) {
  if (!terminal.interactive) throw error;
  const manifest = await readOptionalJson(path.join(workDir, MANIFEST_NAME));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  const failureResult = {
    action,
    status: 'failed',
    error: error?.message || String(error),
    manifest,
    validation: manifest ? validatePlan(manifest) : null,
    report: reportPath
  };

  while (true) {
    const advice = createRecoveryAdvice({ error, action, manifest, workDir, reportPath });
    renderRecoveryAssistant(terminal, advice);
    terminal.panel('Action Failed', [
      ['Action', labelForAction(action), 'error'],
      ['Error', redactCredentialError(error?.message || String(error)), 'error'],
      ['Report', reportPath, 'success']
    ]);

    terminal.section('Recovery');
    const choice = await selectOption(terminal, {
      message: 'Choose recovery action',
      choices: [
        ...(advice.affected_resource ? [{ label: 'Show Affected Resource', value: 'details' }] : []),
        ...(advice.actions.includes('credentials') ? [{ label: 'Test Credentials', value: 'credentials' }] : []),
        ...(manifest && advice.actions.includes('start-new') ? [{ label: 'Start New Integration ID', value: 'start-new' }] : []),
        { label: 'Retry Failed Action', value: 'retry' },
        ...(manifest ? [{ label: 'Validate Current State', value: 'validate' }] : []),
        { label: 'View Latest Report', value: 'report' },
        ...(manifest ? [{ label: 'Show Rollback Preview', value: 'rollback-preview' }] : []),
        { label: 'Return to Main Menu', value: 'home' },
        { label: 'Exit', value: 'exit' }
      ],
      answers
    });

    if (choice === 'details') {
      renderRecoveryDetails(terminal, advice);
      continue;
    }
    if (choice === 'credentials') {
      await runCredentialTestScreen({ terminal, config, workDir, answers, cwd });
      continue;
    }
    if (choice === 'start-new') {
      return runCreateIntegration({ terminal, args, config, workDir, answers, cwd });
    }
    if (choice === 'retry') {
      try {
        return await retry();
      } catch (nextError) {
        error = nextError;
        continue;
      }
    }
    if (choice === 'validate') {
      await runPostActionValidation({ terminal, result: failureResult, workDir });
      continue;
    }
    if (choice === 'report') {
      await runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers, closeTerminal: false });
      continue;
    }
    if (choice === 'rollback-preview') {
      await renderInteractiveRollbackPreview({ terminal, config, manifest, answers, cwd });
      continue;
    }
    if (choice === 'exit') return { ...failureResult, action: 'exit' };
    return failureResult;
  }
}

export function createRecoveryAdvice({ error, action = 'unknown', manifest = null, workDir = DEFAULT_WORK_DIR, reportPath = null } = {}) {
  const message = redactCredentialError(error?.message || String(error || 'Unknown error'));
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  const commonCommands = [
    `html-to-storyblok view-report --work-dir ${workDir}`,
    manifest ? `html-to-storyblok validate-plan --manifest ${manifestPath}` : null
  ].filter(Boolean);
  const base = {
    code: 'HTS_RECOVERY_GENERIC',
    problem: 'The selected CLI action did not complete.',
    likely_cause: 'The command failed before the workflow reached a confirmed safe completion point.',
    recommended_fix: 'Review the report, validate the current plan, then retry or return to the main menu.',
    affected_resource: null,
    actions: ['retry', 'report'],
    commands: commonCommands
  };

  const driftMatch = message.match(/Storyblok draft story drift detected for\s+([^;()\s]+)/i);
  if (driftMatch) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_DRAFT_DRIFT',
      problem: 'A generated draft story already exists but does not match the current manifest.',
      likely_cause: 'The same integration ID was reused after the Storyblok draft was edited or generated from an older plan.',
      recommended_fix: 'Use a new integration ID for a fresh import, or inspect rollback targets before removing integration-owned drafts.',
      affected_resource: driftMatch[1],
      actions: ['details', 'start-new', 'rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-reconcile --manifest ${manifestPath}`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/429|rate limit/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_RATE_LIMIT',
      problem: 'Storyblok rate-limited the Management API requests.',
      likely_cause: 'The space rejected requests faster than its current API allowance.',
      recommended_fix: 'Wait briefly and retry. If this repeats, increase STORYBLOK_REQUEST_INTERVAL_MS or lower the request rate for this session.',
      actions: ['retry', 'report'],
      commands: [
        `STORYBLOK_REQUEST_INTERVAL_MS=250 html-to-storyblok storyblok-apply --manifest ${manifestPath} --dry-run`,
        ...commonCommands
      ]
    };
  }

  if (/credential|token|space id|Management API credentials|Storyblok credentials unavailable/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_CREDENTIALS',
      problem: 'Storyblok credentials are missing or not valid for the requested action.',
      likely_cause: 'The Management token, Space ID, region, or Preview token is missing, expired, or does not have enough access.',
      recommended_fix: 'Run the credential test, enter values for this session, or set them in .env.local without committing secrets.',
      actions: ['credentials', 'retry', 'report'],
      commands: [
        'html-to-storyblok env --init',
        'html-to-storyblok doctor',
        ...commonCommands
      ]
    };
  }

  const storyblokPreflightMatch = message.match(/Storyblok preflight failed(?::\s*(.+))?/i);
  if (storyblokPreflightMatch) {
    const check = storyblokPreflightMatch[1] || 'remote access';
    return {
      ...base,
      code: 'HTS_STORYBLOK_PREFLIGHT',
      problem: 'Storyblok preflight checks failed before remote resources were changed.',
      likely_cause: `The failed check was ${check}. The token may not have the required permission, or an optional API area may be unavailable for the space.`,
      recommended_fix: 'Review the preflight artifact and credentials. Retry only after the failed check is understood.',
      affected_resource: check,
      actions: ['details', 'credentials', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-preflight --manifest ${manifestPath}`,
        'html-to-storyblok doctor',
        ...commonCommands
      ]
    };
  }

  const repositoryPreflightMatch = message.match(/repository preflight failed(?::\s*(.+))?/i);
  if (repositoryPreflightMatch) {
    const check = repositoryPreflightMatch[1] || 'repository safety';
    return {
      ...base,
      code: 'HTS_REPOSITORY_PREFLIGHT',
      problem: 'Repository safety checks failed before generated files were written.',
      likely_cause: check.includes('planned_targets_available')
        ? 'One or more planned generated target files already exists in the selected repository.'
        : `The failed repository check was ${check}.`,
      recommended_fix: 'Choose the intended repository, use a new integration ID, or inspect the planned targets before retrying.',
      affected_resource: check,
      actions: ['details', 'start-new', 'retry', 'report'],
      commands: [
        `html-to-storyblok repository-preflight --manifest ${manifestPath} --repo <repo-path>`,
        `html-to-storyblok diff --manifest ${manifestPath} --repo <repo-path>`,
        ...commonCommands
      ]
    };
  }

  if (/host repository checks failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_HOST_CHECKS',
      problem: 'The host repository checks failed.',
      likely_cause: 'A lint, typecheck, build, or post-generation validation script failed.',
      recommended_fix: 'Open the generated report, fix the host check failure in the selected repository, then retry the apply.',
      actions: ['retry', 'report'],
      commands: [
        `html-to-storyblok build --repo <repo-path> --script build`,
        `html-to-storyblok validate --manifest ${manifestPath} --repo <repo-path>`,
        ...commonCommands
      ]
    };
  }

  if (/Content API validation failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_CONTENT_VALIDATION',
      problem: 'Storyblok draft content was created, but Content API validation failed.',
      likely_cause: 'Drafts remain unpublished for review; the Preview token, links, assets, or draft availability may need inspection.',
      recommended_fix: 'View the report, inspect Storyblok links/assets, then run validation again before deciding whether to roll back.',
      actions: ['rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok validate-storyblok --manifest ${manifestPath} --version draft`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/Management API verification failed/i.test(message)) {
    return {
      ...base,
      code: 'HTS_STORYBLOK_MANAGEMENT_VERIFICATION',
      problem: 'Storyblok remote resources were created as drafts, but final Management API verification failed.',
      likely_cause: 'The remote state could not be verified after apply, often because of temporary API consistency, permissions, or drift.',
      recommended_fix: 'Run reconcile/verify, inspect the report, and use rollback preview before deleting integration-owned resources.',
      actions: ['rollback-preview', 'retry', 'report'],
      commands: [
        `html-to-storyblok storyblok-reconcile --manifest ${manifestPath}`,
        `html-to-storyblok storyblok-verify --manifest ${manifestPath}`,
        `html-to-storyblok rollback-preview --manifest ${manifestPath}`,
        ...commonCommands
      ]
    };
  }

  if (/manifest failed|additive-only|Policy|violations/i.test(message)) {
    return {
      ...base,
      code: 'HTS_POLICY_VALIDATION',
      problem: 'The plan failed the additive-only safety policy.',
      likely_cause: 'The manifest contains a planned mutation, collision, unnamespaced resource, or unsafe dependency.',
      recommended_fix: 'Review the first validation violation, adjust the plan or integration ID, then validate again.',
      actions: ['start-new', 'retry', 'report'],
      commands: commonCommands
    };
  }

  return {
    ...base,
    problem: `${labelForAction(action)} failed.`,
    likely_cause: message
  };
}

function renderRecoveryAssistant(terminal, advice) {
  terminal.panel('Recovery Assistant', [
    ['Problem', advice.problem, 'error'],
    ['Error Code', advice.code, advice.code === 'HTS_RECOVERY_GENERIC' ? 'warning' : 'error'],
    ['Likely Cause', advice.likely_cause, 'warning'],
    ['Recommended Fix', advice.recommended_fix, 'info'],
    ['Affected Resource', advice.affected_resource || 'Not detected', advice.affected_resource ? 'warning' : 'info']
  ]);
  if (advice.commands.length > 0) {
    terminal.panel('Useful Commands', advice.commands.slice(0, 4).map((command, index) => [
      index === 0 ? 'First' : `Option ${index + 1}`,
      command,
      index === 0 ? 'success' : 'info'
    ]));
  }
}

function renderRecoveryDetails(terminal, advice) {
  terminal.panel('Recovery Details', [
    ['Error Code', advice.code, advice.code === 'HTS_RECOVERY_GENERIC' ? 'warning' : 'error'],
    ['Affected Resource', advice.affected_resource || 'Not detected', advice.affected_resource ? 'warning' : 'info'],
    ['Recommended Fix', advice.recommended_fix, 'info'],
    ['Safety', 'No rollback or deletion runs automatically from this screen', 'success']
  ]);
}

async function continueInteractiveSession({ terminal, args, config, workDir, answers, cwd, result }) {
  if (!terminal.interactive || result?.action === 'exit') return result;
  const next = await handleNextAction({ terminal, args, result, answers, workDir });
  if (next === 'exit') return { ...result, next_action: 'exit' };
  return runHomeScreen({ terminal, args, config, workDir, answers, cwd });
}

async function handleNextAction({ terminal, args, result, answers, workDir }) {
  while (true) {
    const next = await chooseNextAction({ terminal, result, answers });
    if (next === 'validate') {
      const validation = await runPostActionValidation({ terminal, result, workDir });
      result.validation = validation.plan_validation || result.validation;
      result.local_validation = validation.local_validation || result.local_validation;
      continue;
    }
    if (next === 'report') {
      await runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers, closeTerminal: false });
      continue;
    }
    return next;
  }
}

async function chooseNextAction({ terminal, result, answers }) {
  renderPostActionCheckpoint(terminal, result);
  const choices = [
    { label: 'Return to Main Menu', value: 'home' },
    ...(canRunPostActionValidation(result) ? [{ label: 'Run Validation Check', value: 'validate' }] : []),
    ...(result?.report ? [{ label: 'View Latest Report', value: 'report' }] : []),
    { label: 'Exit', value: 'exit' }
  ];
  terminal.section('Next');
  const choice = await selectOption(terminal, {
    message: 'What would you like to do next?',
    choices,
    answers
  });
  return choice || 'home';
}

async function runPostActionValidation({ terminal, result, workDir }) {
  const manifest = result?.manifest || await readOptionalJson(path.join(workDir, MANIFEST_NAME));
  if (!manifest) {
    terminal.status('Validation unavailable', 'warning', 'No integration manifest found.');
    return {};
  }

  const planValidation = validatePlan(manifest);
  await writeArtifact(workDir, VALIDATION_NAME, planValidation);
  renderValidationSummary(terminal, planValidation);

  let localValidation = null;
  if (result?.repo_path && result?.status === 'complete') {
    try {
      localValidation = await terminal.task('Validate Local Output', async () => validateIntegration(manifest, {
        repoPath: result.repo_path
      }));
    } catch (error) {
      localValidation = {
        status: 'failed',
        failed_checks: 1,
        error: error?.message || String(error)
      };
    }
    await writeArtifact(workDir, 'validation-result.json', localValidation);
    renderLocalValidationSummary(terminal, localValidation);
  } else if (result?.status === 'dry_run_complete') {
    terminal.panel('Local Validation', [
      ['Status', 'Skipped', 'warning'],
      ['Reason', 'Dry run did not write local output', 'warning']
    ]);
  } else if (result?.repository_skipped || result?.action === 'storyblok_only_integration') {
    terminal.panel('Local Validation', [
      ['Status', 'Skipped', 'warning'],
      ['Reason', 'Repository output was skipped for this Storyblok-only run', 'warning']
    ]);
  }

  return { plan_validation: planValidation, local_validation: localValidation };
}

function canRunPostActionValidation(result) {
  return Boolean(result?.manifest || result?.validation || result?.status === 'complete' || result?.status === 'dry_run_complete');
}

function renderPostActionCheckpoint(terminal, result) {
  if (!result || result.action === 'exit') return;
  const validation = result.local_validation || result.validation;
  const status = result.status || 'complete';
  const success = ['complete', 'dry_run_complete', 'passed'].includes(status);
  terminal.panel(success ? 'Success' : 'Checkpoint', [
    ['Status', labelForStatus(status), success ? 'success' : status === 'blocked' || status === 'failed' ? 'error' : 'warning'],
    ['Plan Validation', result.validation?.valid === true ? 'Passed' : result.validation?.valid === false ? 'Failed' : 'Available on request', result.validation?.valid === false ? 'error' : result.validation?.valid === true ? 'success' : 'warning'],
    ['Local Validation', validation?.status || 'Available on request', validation?.status === 'passed' ? 'success' : validation?.status === 'failed' ? 'error' : 'warning'],
    ...(result.report ? [['Report', result.report, 'success']] : [])
  ]);
}

async function runCreateIntegration({ terminal, args, config, workDir, answers, cwd }) {
  terminal.header('Create New Integration', 'Guided import wizard');
  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 1,
    total: 10,
    current: 'Choose Template'
  });

  const templatePath = await chooseTemplate({ terminal, config, answers, cwd });
  if (!templatePath) return { action: 'cancelled' };
  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 2,
    total: 10,
    current: 'Choose Repository',
    templatePath
  });

  const repoPath = await chooseRepository({ terminal, config, answers, cwd, allowStoryblokOnly: true });
  if (!repoPath) return { action: 'cancelled' };
  if (repoPath === STORYBLOK_ONLY_REPOSITORY) {
    return runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd, templatePath });
  }
  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 3,
    total: 10,
    current: 'Inspect Repository',
    templatePath,
    repoPath
  });

  const repository = await terminal.task('Inspect Repository', async () => {
    const inspection = await inspectRepository(repoPath);
    await writeArtifact(workDir, 'repository-inspection.json', inspection);
    return inspection;
  });
  renderRepositorySummary(terminal, repository);

  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd, repoPath });
  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 4,
    total: 10,
    current: 'Inspect Storyblok',
    templatePath,
    repoPath
  });
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

  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 5,
    total: 10,
    current: 'Inspect Template',
    templatePath,
    repoPath
  });
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
  const draftStoryCount = count(template.pages) || 1;
  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 6,
    total: 10,
    current: 'Confirm Integration Namespace',
    templatePath,
    repoPath,
    integrationId
  });

  terminal.panel('Integration Preview', [
    ['Storyblok Prefix', storyblokPrefix, 'success'],
    ['Repository Namespace', repositoryNamespace, 'success'],
    ['CSS Root', `.hts-${integrationId}-root`, 'success'],
    ['Storyblok Folder', integrationId, 'success'],
    ['Storyblok Components', `${storyblokPrefix}hero`, 'success'],
    ['Draft Stories', `${draftStoryCount} under ${integrationId}/`, 'success']
  ]);

  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 7,
    total: 10,
    current: 'Create Plan',
    templatePath,
    repoPath,
    integrationId
  });
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

  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 8,
    total: 10,
    current: 'Validate Plan',
    templatePath,
    repoPath,
    integrationId
  });
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, VALIDATION_NAME, validation);
  renderValidationSummary(terminal, validation);
  if (!validation.valid) {
    return { action: 'create_integration', status: 'blocked', manifest, validation };
  }

  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 9,
    total: 10,
    current: 'Dry Run Apply',
    templatePath,
    repoPath,
    integrationId
  });
  const dryRun = await terminal.task('Dry Run Apply', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: true, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
  ));

  terminal.status('Dry run complete', 'success');
  renderApplyPreviewDiff(terminal, dryRun);
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
    return { action: 'create_integration', status: 'dry_run_complete', manifest, validation, repo_path: repoPath, dry_run: dryRun, report: reportPath };
  }

  renderWizardContext(terminal, {
    workflow: 'Create Integration',
    step: 10,
    total: 10,
    current: 'Real Apply',
    templatePath,
    repoPath,
    integrationId
  });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  const result = await terminal.task('Apply Integration', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: false, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  renderCompletion(terminal, result, reportPath, { manifest, workDir, repoPath });
  return { action: 'create_integration', status: 'complete', manifest, validation, repo_path: repoPath, result, report: reportPath };
}

async function runCreateStoryblokOnlyIntegration({ terminal, args, config, workDir, answers, cwd, templatePath = null }) {
  terminal.header('Test Storyblok Only', 'Create Storyblok components, assets, and a draft story without selecting a repository');
  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 1,
    total: 7,
    current: 'Choose Template',
    repositorySkipped: true
  });

  const selectedTemplatePath = templatePath || await chooseTemplate({ terminal, config, answers, cwd });
  if (!selectedTemplatePath) return { action: 'storyblok_only_integration', status: 'cancelled' };

  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 2,
    total: 7,
    current: 'Inspect Storyblok',
    templatePath: selectedTemplatePath,
    repositorySkipped: true
  });
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

  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 3,
    total: 7,
    current: 'Inspect Template',
    templatePath: selectedTemplatePath,
    repositorySkipped: true
  });
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
  const draftStoryCount = count(template.pages) || 1;
  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 4,
    total: 7,
    current: 'Confirm Integration Namespace',
    templatePath: selectedTemplatePath,
    integrationId,
    repositorySkipped: true
  });

  terminal.panel('Integration Preview', [
    ['Storyblok Prefix', storyblokPrefix, 'success'],
    ['Repository Output', 'Skipped for this test', 'warning'],
    ['Repository Namespace', repositoryNamespace, 'warning'],
    ['Storyblok Folder', integrationId, 'success'],
    ['Storyblok Components', `${storyblokPrefix}hero`, 'success'],
    ['Draft Stories', `${draftStoryCount} under ${integrationId}/`, 'success']
  ]);

  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 5,
    total: 7,
    current: 'Create And Validate Plan',
    templatePath: selectedTemplatePath,
    integrationId,
    repositorySkipped: true
  });
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

  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 6,
    total: 7,
    current: 'Dry Run Storyblok Apply',
    templatePath: selectedTemplatePath,
    integrationId,
    repositorySkipped: true
  });
  const dryRun = await terminal.task('Dry Run Storyblok Apply', async () => applyStoryblokOnly(
    manifest,
    { dry_run: true, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
  ));

  terminal.status('Storyblok dry run complete', 'success');
  renderApplyPreviewDiff(terminal, dryRun);
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
    return { action: 'storyblok_only_integration', status: 'dry_run_complete', manifest, validation, repository_skipped: true, dry_run: dryRun, report: reportPath };
  }

  renderWizardContext(terminal, {
    workflow: 'Storyblok Only',
    step: 7,
    total: 7,
    current: 'Real Storyblok Apply',
    templatePath: selectedTemplatePath,
    integrationId,
    repositorySkipped: true
  });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  const result = await terminal.task('Apply Storyblok Integration', async () => applyStoryblokOnly(
    manifest,
    { dry_run: false, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  renderStoryblokOnlyCompletion(terminal, result, reportPath, { manifest, workDir });
  return { action: 'storyblok_only_integration', status: 'complete', manifest, validation, repository_skipped: true, result, report: reportPath };
}

async function runContinueExistingIntegration({ terminal, args, config, workDir, answers, cwd }) {
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) {
    terminal.status('No previous integration found', 'warning', manifestPath);
    return { action: 'continue_integration', status: 'missing' };
  }
  const manifest = await readJson(manifestPath);
  terminal.header('Continue Existing Integration', manifest.integration_id);
  const resume = await createResumeModel(workDir, manifest);
  renderResumeDashboard(terminal, resume);
  renderPlanSummary(terminal, manifest);
  const validation = validatePlan(manifest);
  renderValidationSummary(terminal, validation);

  const action = await selectOption(terminal, {
    message: 'Choose next step',
    choices: [
      { label: 'Run Storyblok Dry Run', value: 'storyblok-dry-run' },
      { label: 'Run Real Storyblok Apply', value: 'storyblok-apply' },
      { label: 'Run One Storyblok Step', value: 'storyblok-step' },
      { label: 'Run Full Dry Run', value: 'dry-run' },
      { label: 'Run Full Real Apply', value: 'apply' },
      { label: 'Review/Edit Story Links', value: 'link-mapping' },
      { label: 'Review/Edit Field Mapping', value: 'field-mapping' },
      { label: 'Preview Apply Diff', value: 'preview-diff' },
      { label: 'Show Rollback Preview', value: 'rollback-preview' },
      { label: 'Validate Local Output', value: 'validate' },
      { label: 'Wire Repository Routes', value: 'wire-routes' },
      { label: 'View Latest Report', value: 'report' },
      { label: 'Back', value: 'back' }
    ],
    answers
  });
  if (!action || action === 'back') return { action: 'continue_integration', status: 'cancelled' };
  if (action === 'report') return runReportViewer({ args: { ...args, work_dir: workDir }, input: terminal.input, output: terminal.output, answers, closeTerminal: false });
  if (action === 'link-mapping') {
    const updated = await runStoryLinkMappingEditor({ terminal, manifest, answers });
    await persistInteractiveManifest(workDir, updated);
    return { action: 'link_mapping', status: 'complete', manifest: updated, validation: updated.validation };
  }
  if (action === 'field-mapping') {
    const updated = await runFieldMappingEditor({ terminal, manifest, answers });
    await persistInteractiveManifest(workDir, updated);
    return { action: 'field_mapping', status: 'complete', manifest: updated, validation: updated.validation };
  }
  if (action === 'preview-diff') {
    renderManifestApplyPreview(terminal, manifest);
    return { action: 'preview_diff', status: 'complete', manifest, validation };
  }
  if (action === 'rollback-preview') {
    await renderInteractiveRollbackPreview({ terminal, config, manifest, answers, cwd });
    return { action: 'rollback_preview', status: 'complete', manifest, validation };
  }

  if (action === 'storyblok-step') {
    const result = await runStoryblokStepPicker({ terminal, manifest, config, workDir, answers, cwd });
    return { action: 'storyblok_step', status: result.status || 'complete', manifest, validation, result, repository_skipped: true };
  }

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
      { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
    ));
    const report = await createReport(workDir);
    const reportPath = await writeMarkdownReport(workDir, report);
    if (realStoryblokApply) renderStoryblokOnlyCompletion(terminal, result, reportPath, { manifest, workDir });
    else {
      terminal.panel('Storyblok Dry Run Complete', [['Repository', 'Skipped', 'warning'], ['Report', reportPath, 'success']]);
      renderApplyPreviewDiff(terminal, result);
    }
    return {
      action: 'continue_integration',
      status: realStoryblokApply ? 'complete' : 'dry_run_complete',
      manifest,
      validation,
      repository_skipped: true,
      result,
      report: reportPath
    };
  }

  const repoPath = await chooseRepository({ terminal, config, answers, cwd });
  if (!repoPath) return { action: 'continue_integration', status: 'cancelled' };
  const templatePath = manifest.template?.source_path;
  const framework = frameworkValue(manifest.template?.framework, config.preferred_framework);
  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd, repoPath });

  if (action === 'wire-routes') {
    const preview = await terminal.task('Preview Route Handoff', async () => wireRepositoryRoutes(manifest, {
      repoPath,
      dryRun: true
    }));
    await writeArtifact(workDir, 'route-handoff-preview.json', preview);
    renderRouteHandoffSummary(terminal, preview);
    if (preview.status === 'blocked') {
      return { action: 'wire_routes', status: 'blocked', manifest, validation, repo_path: repoPath, preview };
    }
    const proceed = await confirm(terminal, {
      message: 'Create these host route files?',
      defaultValue: false,
      answers
    });
    if (!proceed) {
      return { action: 'wire_routes', status: 'dry_run_complete', manifest, validation, repo_path: repoPath, preview };
    }
    const result = await terminal.task('Wire Repository Routes', async () => wireRepositoryRoutes(manifest, {
      repoPath,
      dryRun: false
    }));
    await writeArtifact(workDir, 'route-handoff-result.json', result);
    renderRouteHandoffSummary(terminal, result);
    return { action: 'wire_routes', status: result.status, manifest, validation, repo_path: repoPath, preview, result };
  }

  if (action === 'validate') {
    const localValidation = await terminal.task('Validate Local Output', async () => validateIntegration(manifest, { repoPath }));
    await writeArtifact(workDir, 'validation-result.json', localValidation);
    renderLocalValidationSummary(terminal, localValidation);
    return { action: 'continue_integration', status: localValidation.status, manifest, validation, local_validation: localValidation, repo_path: repoPath };
  }

  const realApply = action === 'apply';
  if (realApply) {
    sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: true });
  }
  const result = await terminal.task(realApply ? 'Apply Integration' : 'Dry Run Apply', async () => applyManifest(
    manifest,
    { repo: repoPath, template: templatePath, framework, dry_run: !realApply, env: sessionEnv },
    workDir,
    { onProgress: (event) => terminal.progress(event.label, event.current, event.total, event.detail || "") }
  ));
  const report = await createReport(workDir);
  const reportPath = await writeMarkdownReport(workDir, report);
  if (realApply) renderCompletion(terminal, result, reportPath, { manifest, workDir, repoPath });
  else {
    terminal.panel('Dry Run Complete', [['Report', reportPath, 'success']]);
    renderApplyPreviewDiff(terminal, result);
  }
  return {
    action: 'continue_integration',
    status: realApply ? 'complete' : 'dry_run_complete',
    manifest,
    validation,
    repo_path: repoPath,
    result,
    report: reportPath
  };
}

async function runStoryblokStepPicker({ terminal, manifest, config, workDir, answers, cwd }) {
  const step = await selectOption(terminal, {
    message: 'Choose Storyblok step',
    choices: [
      { label: 'Preflight', value: 'preflight' },
      { label: 'Component Folders', value: 'component-groups' },
      { label: 'Internal Tags', value: 'internal-tags' },
      { label: 'Components', value: 'components' },
      { label: 'Asset Folders', value: 'asset-folders' },
      { label: 'Upload Assets', value: 'assets' },
      { label: 'Presets', value: 'presets' },
      { label: 'Draft Stories', value: 'stories' },
      { label: 'Reconcile', value: 'reconcile' },
      { label: 'Verify Management State', value: 'verify' },
      { label: 'Back', value: 'back' }
    ],
    answers
  });
  if (!step || step === 'back') return { status: 'cancelled' };

  const real = await confirm(terminal, {
    message: 'Run this step against Storyblok now?',
    defaultValue: false,
    answers
  });
  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
  if (real) {
    sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: !['preflight', 'reconcile', 'verify'].includes(step) });
  }
  const dryRun = !real;
  const result = await terminal.task(`Storyblok ${labelForSetting(step.replaceAll('-', '_'))}`, async () => {
    if (step === 'preflight') return preflightStoryblokIntegration(manifest, { dryRun, env: sessionEnv });
    if (step === 'component-groups') return createStoryblokComponentGroups(manifest, { dryRun, env: sessionEnv });
    if (step === 'internal-tags') return createStoryblokInternalTags(manifest, { dryRun, env: sessionEnv });
    if (step === 'components') return createStoryblokComponents(manifest, { dryRun, env: sessionEnv });
    if (step === 'asset-folders') return createStoryblokAssetFolders(manifest, { dryRun, env: sessionEnv });
    if (step === 'assets') return uploadStoryblokAssets(manifest, { dryRun, env: sessionEnv });
    if (step === 'presets') return createStoryblokPresets(manifest, { dryRun, env: sessionEnv });
    if (step === 'stories') return createDraftStories(manifest, { dryRun, env: sessionEnv });
    if (step === 'reconcile') return reconcileStoryblokManifest(manifest, { env: sessionEnv });
    if (step === 'verify') return verifyStoryblokManagementState(manifest, { dryRun, env: sessionEnv });
    return { status: 'cancelled' };
  });
  const artifactName = `storyblok-step-${step}.json`;
  await writeArtifact(workDir, artifactName, result);
  terminal.panel('Storyblok Step Result', [
    ['Step', step, 'success'],
    ['Mode', dryRun ? 'Dry run' : 'Real', dryRun ? 'warning' : 'success'],
    ['Artifact', artifactName, 'success'],
    ['Status', Array.isArray(result) ? `${result.length} result(s)` : result.status || result.action || 'complete', statusForStepResult(result)]
  ]);
  return { status: Array.isArray(result) || result.status !== 'failed' ? 'complete' : 'failed', step, dry_run: dryRun, result };
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
      ? await safeInspectStoryblokAudit({ terminal, env: sessionEnv })
      : inspectStoryblokEnvironment(sessionEnv);
    await writeArtifact(workDir, 'storyblok-access.json', result);
    return result;
  });
  renderStoryblokSummary(terminal, inspection, config, sessionEnv);
  renderStoryblokAuditDashboard(terminal, inspection);
  return { action: 'review_storyblok', inspection };
}

async function runCredentialTestScreen({ terminal, config, workDir, answers, cwd }) {
  terminal.header('Credential Test', 'Session-only checks. Secrets are never stored.');
  let sessionEnv = await createSessionEnvironment({ terminal, config, cwd });
  sessionEnv = await promptForStoryblokCredentials({ terminal, env: sessionEnv, config, answers, required: false });
  const access = checkLiveAccess(sessionEnv);
  terminal.panel('Credential Readiness', [
    ['Management API', access.storyblok.ready ? 'Configured' : 'Missing token or space id', access.storyblok.ready ? 'success' : 'warning'],
    ['Content API', access.storyblok_content.ready ? 'Configured' : 'Missing preview/delivery token', access.storyblok_content.ready ? 'success' : 'warning'],
    ['Netlify', access.netlify.ready ? 'Configured' : 'Not configured', access.netlify.ready ? 'success' : 'warning'],
    ['GitHub', access.github.ready ? 'Configured' : 'Not configured', access.github.ready ? 'success' : 'warning'],
    ['GitLab', access.gitlab.ready ? 'Configured' : 'Not configured', access.gitlab.ready ? 'success' : 'warning']
  ]);

  if (access.storyblok.ready) {
    const inspection = await terminal.task('Test Management API', async () => safeInspectStoryblokSpace({ terminal, env: sessionEnv }));
    await writeArtifact(workDir, 'credential-storyblok-management-test.json', inspection);
    renderStoryblokSummary(terminal, inspection, config, sessionEnv);
  }

  const manifest = await readOptionalJson(path.join(workDir, MANIFEST_NAME));
  if (manifest && access.storyblok.ready) {
    const preflight = await terminal.task('Test Manifest Preflight', async () => preflightStoryblokIntegration(manifest, { env: sessionEnv }));
    await writeArtifact(workDir, 'credential-storyblok-preflight-test.json', preflight);
    renderStoryblokPreflightSummary(terminal, preflight);
  }

  if (manifest && access.storyblok_content.ready) {
    const validation = await terminal.task('Test Content API Drafts', async () => validateStoryblokDraftContent(manifest, { env: sessionEnv }));
    await writeArtifact(workDir, 'credential-storyblok-content-test.json', validation);
    renderStoryblokContentValidationSummary(terminal, validation);
  } else if (access.storyblok_content.ready) {
    const slug = await promptInput(terminal, {
      message: 'Draft story slug to test',
      defaultValue: '',
      answers
    });
    if (slug) {
      const content = await terminal.task('Test Content API', async () => inspectStoryblokContentStory({ slug, env: sessionEnv }));
      await writeArtifact(workDir, 'credential-storyblok-content-test.json', content);
      terminal.panel('Content API', [
        ['Status', content.status || 'ok', content.status === 'ok' ? 'success' : 'warning'],
        ['Story', content.story?.slug || slug, content.story ? 'success' : 'warning']
      ]);
    }
  }

  return { action: 'credential_test', status: 'complete', access };
}

async function runImportHistory({ terminal, workDir }) {
  const evidence = await readEvidence(workDir);
  const commands = evidence.filter((entry) => ['command_started', 'command_completed', 'command_failed'].includes(entry.type));
  const artifacts = evidence.filter((entry) => entry.type === 'artifact_written');
  const recentCommands = commands.slice(-12).reverse();
  terminal.panel('Import History', recentCommands.length
    ? recentCommands.map((entry) => [
      entry.command || entry.type,
      `${entry.type.replace('command_', '')}${entry.exit_code !== undefined ? ` (${entry.exit_code})` : ''}`,
      entry.type === 'command_failed' ? 'error' : entry.type === 'command_completed' ? 'success' : 'info'
    ])
    : [['History', 'No commands recorded yet', 'warning']]);
  terminal.panel('Artifacts', artifacts.slice(-8).reverse().map((entry) => [
    entry.artifact.split('/').at(-1),
    entry.timestamp || 'recorded',
    'success'
  ]));
  return { action: 'import_history', status: 'complete', commands: commands.length, artifacts: artifacts.length };
}

async function runLiveSandboxWizard({ terminal, answers }) {
  terminal.header('Live Sandbox Test', 'Runs only when you intentionally execute the test command');
  terminal.panel('Requirements', [
    ['Storyblok Space', 'Disposable sandbox space strongly recommended', 'warning'],
    ['Management Token', 'Required in environment', 'warning'],
    ['Preview Token', 'Required for Content API validation', 'warning'],
    ['Safety', 'Uses a disposable integration namespace and rollback test', 'success']
  ]);
  terminal.panel('Command', [
    ['Run', 'STORYBLOK_LIVE_TESTS=1 npm run test:storyblok-live', 'success']
  ]);
  const showDetails = await confirm(terminal, {
    message: 'Show required environment variable names?',
    defaultValue: true,
    answers
  });
  if (showDetails) {
    terminal.panel('Environment', [
      ['STORYBLOK_MANAGEMENT_TOKEN', 'Required', 'warning'],
      ['STORYBLOK_SPACE_ID', 'Required', 'warning'],
      ['STORYBLOK_PREVIEW_TOKEN', 'Required', 'warning'],
      ['STORYBLOK_REGION', 'Optional', 'info']
    ]);
  }
  return { action: 'live_sandbox_test', status: 'shown' };
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
      defaultValue: config.storyblok_space_id || '',
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

async function safeInspectStoryblokAudit({ terminal, env }) {
  try {
    return await inspectStoryblokSpace({ env, audit: true });
  } catch (error) {
    const fallback = inspectStoryblokEnvironment(env);
    terminal.status('Storyblok audit failed', 'warning', 'Continuing with local credential readiness.');
    return {
      ...fallback,
      status: 'audit_failed',
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

async function runStoryLinkMappingEditor({ terminal, manifest, answers }) {
  const links = collectEditableStoryLinks(manifest);
  terminal.panel('Story Link Mapping', links.length
    ? links.slice(0, 20).map((link) => [link.label, link.target || 'Empty', link.resolved ? 'success' : 'warning'])
    : [['Story Links', 'None detected', 'success']]);
  if (!terminal.interactive || links.length === 0) return withPlanValidation(manifest);

  while (true) {
    const choice = await selectOption(terminal, {
      message: 'Choose a link to edit',
      choices: [
        ...links.map((link, index) => ({ label: `${link.label} -> ${link.target || 'empty'}`, value: String(index) })),
        { label: 'Done', value: 'done' }
      ],
      answers
    });
    if (!choice || choice === 'done') return withPlanValidation(manifest);
    const link = links[Number(choice)];
    if (!link) continue;
    const mode = await selectOption(terminal, {
      message: 'Choose link target type',
      choices: [
        ...plannedStoryChoices(manifest),
        { label: 'Existing Storyblok story slug...', value: '__story__' },
        { label: 'External or anchor URL...', value: '__url__' },
        { label: 'Leave unchanged', value: '__skip__' }
      ],
      answers
    });
    if (!mode || mode === '__skip__') continue;
    const nextValue = { ...link.value };
    if (mode === '__url__') {
      const url = await promptInput(terminal, {
        message: 'URL',
        defaultValue: nextValue.url || nextValue.cached_url || '#',
        answers
      });
      nextValue.linktype = 'url';
      nextValue.url = url;
      delete nextValue.cached_url;
      delete nextValue.id;
    } else {
      const slug = mode === '__story__'
        ? await promptInput(terminal, {
          message: 'Storyblok story slug',
          defaultValue: nextValue.cached_url || '',
          answers
        })
        : mode;
      nextValue.linktype = 'story';
      nextValue.cached_url = normalizeStorySlug(slug);
      nextValue.url = '';
      delete nextValue.id;
    }
    setNestedValue(link.root, link.path, nextValue);
    link.value = nextValue;
    link.target = nextValue.cached_url || nextValue.url || '';
    link.linktype = nextValue.linktype;
    link.resolved = nextValue.linktype === 'url' || plannedStorySlugSet(manifest).has(normalizeStorySlug(link.target));
    terminal.status('Link updated', 'success', `${link.label} -> ${link.target}`);
  }
}

async function runFieldMappingEditor({ terminal, manifest, answers }) {
  const fields = collectEditableSchemaFields(manifest);
  terminal.panel('Field Mapping', fields.length
    ? fields.slice(0, 24).map((field) => [`${field.component}.${field.name}`, `${field.type}${field.displayName ? ` (${field.displayName})` : ''}`, 'success'])
    : [['Fields', 'None detected', 'warning']]);
  if (!terminal.interactive || fields.length === 0) return withPlanValidation(manifest);

  while (true) {
    const choice = await selectOption(terminal, {
      message: 'Choose a field to edit',
      choices: [
        ...fields.map((field, index) => ({ label: `${field.component}.${field.name} (${field.type})`, value: String(index) })),
        { label: 'Done', value: 'done' }
      ],
      answers
    });
    if (!choice || choice === 'done') return withPlanValidation(manifest);
    const field = fields[Number(choice)];
    if (!field) continue;
    const nextType = await selectOption(terminal, {
      message: 'Storyblok field type',
      choices: [
        { label: 'Keep Current', value: field.type },
        { label: 'Text', value: 'text' },
        { label: 'Textarea', value: 'textarea' },
        { label: 'Richtext', value: 'richtext' },
        { label: 'Markdown', value: 'markdown' },
        { label: 'Number', value: 'number' },
        { label: 'Boolean', value: 'boolean' },
        { label: 'Asset', value: 'asset' },
        { label: 'Link', value: 'multilink' },
        { label: 'Blocks', value: 'bloks' }
      ],
      answers
    });
    const displayName = await promptInput(terminal, {
      message: 'Field display label',
      defaultValue: field.schema.display_name || titleFromFieldName(field.name),
      answers
    });
    field.schema.type = nextType || field.type;
    if (displayName) field.schema.display_name = displayName;
    field.type = field.schema.type;
    field.displayName = field.schema.display_name;
    terminal.status('Field updated', 'success', `${field.component}.${field.name}`);
  }
}

async function persistInteractiveManifest(workDir, manifest) {
  const next = withPlanValidation(manifest);
  await writeArtifact(workDir, MANIFEST_NAME, next);
  await writeArtifact(workDir, VALIDATION_NAME, next.validation);
  return next;
}

function renderManifestApplyPreview(terminal, manifest) {
  terminal.panel('Apply Preview Diff', [
    ['Repository Files', count(manifest.repository?.files_to_create), count(manifest.repository?.files_to_create) ? 'success' : 'warning'],
    ['Repository Assets', count(manifest.repository?.assets_to_create), count(manifest.repository?.assets_to_create) ? 'success' : 'warning'],
    ['Component Folders', count(manifest.storyblok?.component_groups_to_create), count(manifest.storyblok?.component_groups_to_create) ? 'success' : 'warning'],
    ['Internal Tags', count(manifest.storyblok?.internal_tags_to_create), count(manifest.storyblok?.internal_tags_to_create) ? 'success' : 'warning'],
    ['Storyblok Components', count(manifest.storyblok?.components_to_create) + count(manifest.storyblok?.components_to_duplicate), 'success'],
    ['Presets', count(manifest.storyblok?.presets_to_create), count(manifest.storyblok?.presets_to_create) ? 'success' : 'warning'],
    ['Asset Folders', count(manifest.storyblok?.asset_folders_to_create), count(manifest.storyblok?.asset_folders_to_create) ? 'success' : 'warning'],
    ['Assets', count(manifest.storyblok?.assets_to_create), count(manifest.storyblok?.assets_to_create) ? 'success' : 'warning'],
    ['Draft Stories', count(manifest.storyblok?.stories_to_create), count(manifest.storyblok?.stories_to_create) ? 'success' : 'warning'],
    ['Safety', manifest.policy === 'additive-only-isolated' ? 'Additive Only' : manifest.policy, manifest.policy === 'additive-only-isolated' ? 'success' : 'warning']
  ]);
}

async function renderInteractiveRollbackPreview({ terminal, config, manifest, answers, cwd }) {
  const repoPath = await chooseRepository({ terminal, config, answers, cwd, allowStoryblokOnly: true });
  const preview = createRollbackPreview(manifest, {
    repoPath: repoPath && repoPath !== STORYBLOK_ONLY_REPOSITORY ? repoPath : cwd
  });
  terminal.panel('Rollback Preview', [
    ['Repository Files', count(preview.repository_files_to_remove), count(preview.repository_files_to_remove) ? 'warning' : 'success'],
    ['Component Folders', count(preview.storyblok_component_groups_to_remove), count(preview.storyblok_component_groups_to_remove) ? 'warning' : 'success'],
    ['Internal Tags', count(preview.storyblok_internal_tags_to_remove), count(preview.storyblok_internal_tags_to_remove) ? 'warning' : 'success'],
    ['Storyblok Components', count(preview.storyblok_components_to_remove), count(preview.storyblok_components_to_remove) ? 'warning' : 'success'],
    ['Storyblok Presets', count(preview.storyblok_presets_to_remove), count(preview.storyblok_presets_to_remove) ? 'warning' : 'success'],
    ['Storyblok Stories', count(preview.storyblok_stories_to_remove), count(preview.storyblok_stories_to_remove) ? 'warning' : 'success'],
    ['Storyblok Assets', count(preview.storyblok_assets_to_remove), count(preview.storyblok_assets_to_remove) ? 'warning' : 'success'],
    ['Mode', 'Preview only', 'success']
  ]);
  const examples = rollbackImpactExamples(preview);
  if (examples.length > 0) {
    terminal.panel('Rollback Impact Examples', examples);
  }
  return preview;
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

async function createResumeModel(workDir, manifest) {
  const [
    evidence,
    planValidation,
    localValidation,
    applyResult,
    storyblokApplyResult,
    storyblokContentValidation
  ] = await Promise.all([
    readEvidence(workDir),
    readOptionalJson(path.join(workDir, VALIDATION_NAME)),
    readOptionalJson(path.join(workDir, 'validation-result.json')),
    readOptionalJson(path.join(workDir, 'apply-result.json')),
    readOptionalJson(path.join(workDir, 'storyblok-apply-result.json')),
    readOptionalJson(path.join(workDir, 'storyblok-content-validation.json'))
  ]);
  const failed = [...evidence].reverse().find((entry) => entry.type === 'command_failed');
  const latestApply = applyResult || storyblokApplyResult || null;
  const completedSteps = count(latestApply?.steps);
  const plannedSteps = latestApply?.action === 'apply_manifest' ? 13 : latestApply?.action === 'apply_storyblok_only' ? 10 : 0;
  const validationStatus = planValidation ? planValidation.valid ? 'Passed' : 'Failed' : manifest.validation?.valid ? 'Passed' : 'Not run';
  const contentStatus = storyblokContentValidation?.status || latestStoryblokContentStep(latestApply)?.status || 'Not run';
  const failedStep = failed?.message || failedStepFromApply(latestApply);
  return {
    integration_id: manifest.integration_id,
    work_dir: workDir,
    validation: validationStatus,
    local_validation: localValidation?.status || 'Not run',
    storyblok_content_validation: contentStatus,
    completed_steps: completedSteps,
    planned_steps: plannedSteps,
    failed_step: failedStep || null,
    latest_status: failedStep ? 'Needs attention' : latestApply ? latestApply.dry_run ? 'Dry run complete' : 'Apply complete' : 'Planned',
    recommended_action: failedStep
      ? 'Open recovery options or rerun the failed step'
      : latestApply?.dry_run
        ? 'Review the dry run, then run real apply'
        : latestApply
          ? 'Validate or view report'
          : 'Run a dry run'
  };
}

function renderResumeDashboard(terminal, model) {
  terminal.panel('Resume Dashboard', [
    ['Integration', model.integration_id, 'success'],
    ['Status', model.latest_status, model.failed_step ? 'warning' : 'success'],
    ['Completed Steps', model.planned_steps ? `${model.completed_steps} / ${model.planned_steps}` : model.completed_steps],
    ['Plan Validation', model.validation, model.validation === 'Passed' ? 'success' : model.validation === 'Failed' ? 'error' : 'warning'],
    ['Local Validation', model.local_validation, model.local_validation === 'passed' ? 'success' : model.local_validation === 'failed' ? 'error' : 'warning'],
    ['Storyblok Validation', model.storyblok_content_validation, model.storyblok_content_validation === 'passed' ? 'success' : model.storyblok_content_validation === 'failed' ? 'error' : 'warning'],
    ['Failed Step', model.failed_step || 'None', model.failed_step ? 'error' : 'success'],
    ['Next', model.recommended_action, model.failed_step ? 'warning' : 'info']
  ]);
}

function renderWizardContext(terminal, {
  workflow,
  step,
  total,
  current,
  templatePath = null,
  repoPath = null,
  integrationId = null,
  repositorySkipped = false
} = {}) {
  terminal.panel('Wizard Context', [
    ['Workflow', workflow || 'Interactive workflow', 'info'],
    ['Step', step && total ? `${step} / ${total}` : 'Not tracked', 'info'],
    ['Current', current || 'Continue', 'info'],
    ...(templatePath ? [['Template', path.basename(templatePath), 'success']] : []),
    ...(repositorySkipped ? [['Repository', 'Skipped for Storyblok-only run', 'warning']] : repoPath ? [['Repository', path.basename(repoPath), 'success']] : []),
    ...(integrationId ? [['Integration', integrationId, 'success']] : [])
  ]);
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
    ['Component Folders', model.generated_component_groups],
    ['Generated Components', model.generated_components],
    ['Generated Presets', model.generated_presets],
    ['Assets Uploaded', model.assets_uploaded]
  ]);
}

function renderSettings(terminal, config) {
  terminal.header('HTML -> Storyblok Settings', 'Stored in ~/.html-to-storyblok/config.json unless --config is supplied');
  terminal.panel('Configuration', settingsKeys().map((key) => [labelForSetting(key), config[key]]));
  renderProfiles(terminal, config);
}

function renderProfiles(terminal, config) {
  const names = profileNames(config);
  terminal.panel('Project Profiles', names.length
    ? names.map((name) => [
      name === config.active_profile ? `${name} (active)` : name,
      profileSummary(config.project_profiles?.[name]),
      name === config.active_profile ? 'success' : 'info'
    ])
    : [['Profiles', 'None configured', 'warning']]);
}

function renderDoctor(terminal, report) {
  terminal.header('HTML -> Storyblok Doctor', report.description || 'Environment and project readiness');
  terminal.panel('Doctor Mode', [
    ['Target', report.target || 'all', 'info']
  ]);
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
    { label: 'Storyblok', value: 'storyblok' },
    { label: 'Assets', value: 'assets' },
    { label: 'Links', value: 'links' },
    { label: 'Rollback Targets', value: 'rollback' },
    { label: 'Activity Timeline', value: 'activity' },
    { label: 'Evidence', value: 'evidence' },
    { label: 'Generated Files', value: 'files' },
    { label: 'Warnings', value: 'warnings' },
    { label: 'Failures', value: 'failures' },
    { label: 'Search Report', value: 'search' },
    { label: 'Export HTML Report', value: 'html' }
  ];
  const section = terminal.interactive
    ? await selectOption(terminal, { message: 'Choose report section', choices: sections, answers })
    : 'summary';
  if (section === 'validation') {
    terminal.panel('Validation', [
      ['Latest Validation', report.latest_validation?.status || 'Not run', report.latest_validation?.status === 'passed' ? 'success' : 'warning'],
      ['Plan Valid', report.safety_confirmation.plan_valid ? 'Yes' : 'No', report.safety_confirmation.plan_valid ? 'success' : 'warning']
    ]);
  } else if (section === 'storyblok') {
    const storyblokArtifacts = report.artifacts.filter((artifact) => /storyblok|apply_result/.test(artifact.type));
    terminal.panel('Storyblok', storyblokArtifacts.length
      ? storyblokArtifacts.map((artifact) => [
        artifact.type,
        storyblokArtifactSummary(artifact),
        artifact.status === 'failed' ? 'error' : artifact.status === 'skipped' ? 'warning' : 'success'
      ])
      : [['Storyblok', 'No Storyblok artifacts recorded', 'warning']]);
    renderStoryblokReportDrilldown(terminal, storyblokArtifacts);
  } else if (section === 'assets') {
    const manifest = report.artifacts.find((artifact) => artifact.type === 'integration_manifest');
    const apply = [...report.artifacts].reverse().find((artifact) => artifact.type === 'storyblok_apply_result' || artifact.type === 'apply_result');
    terminal.panel('Assets', [
      ['Planned Storyblok Assets', manifest?.storyblok_assets || 0, manifest?.storyblok_assets ? 'success' : 'warning'],
      ['Created or Reused', apply?.assets_created_or_reused || 0, apply?.assets_created_or_reused ? 'success' : 'warning']
    ]);
  } else if (section === 'links') {
    const apply = [...report.artifacts].reverse().find((artifact) => artifact.type === 'storyblok_apply_result' || artifact.type === 'apply_result');
    terminal.panel('Links', [
      ['Total Links', apply?.link_summary?.total_links || 0],
      ['Story Links', apply?.link_summary?.story_links || 0],
      ['Resolved Story Links', apply?.link_summary?.resolved_story_links || 0, apply?.link_summary?.resolved_story_links ? 'success' : 'warning'],
      ['Unresolved Story Links', apply?.link_summary?.unresolved_story_links || 0, apply?.link_summary?.unresolved_story_links ? 'warning' : 'success']
    ]);
  } else if (section === 'rollback') {
    const manifest = report.artifacts.find((artifact) => artifact.type === 'integration_manifest');
    terminal.panel('Rollback Targets', [
      ['Repository Files', manifest?.repository_files || 0, manifest?.repository_files ? 'warning' : 'success'],
      ['Component Folders', manifest?.storyblok_component_groups || 0, manifest?.storyblok_component_groups ? 'warning' : 'success'],
      ['Storyblok Components', manifest?.storyblok_components || 0, manifest?.storyblok_components ? 'warning' : 'success'],
      ['Storyblok Presets', manifest?.storyblok_presets || 0, manifest?.storyblok_presets ? 'warning' : 'success'],
      ['Storyblok Stories', manifest?.storyblok_stories || 0, manifest?.storyblok_stories ? 'warning' : 'success'],
      ['Storyblok Assets', manifest?.storyblok_assets || 0, manifest?.storyblok_assets ? 'warning' : 'success'],
      ['Mode', 'Preview before confirmed rollback', 'success']
    ]);
  } else if (section === 'activity') {
    const activities = report.artifacts.filter((artifact) => artifact.type === 'storyblok_activity_evidence');
    terminal.panel('Activity Timeline', activities.length
      ? activities.map((artifact) => [artifact.artifact.split('/').at(-1), `${artifact.related || 0} related / ${artifact.total || 0} total`, artifact.related ? 'success' : 'warning'])
      : [['Activity', 'No activity evidence recorded', 'warning']]);
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
  } else if (section === 'search') {
    const term = await promptInput(terminal, {
      message: 'Search term',
      defaultValue: '',
      answers
    });
    const matches = searchReport(report, term);
    terminal.panel('Search Results', matches.length
      ? matches.slice(0, 20).map((match) => [match.type, match.text, match.status])
      : [['Matches', term ? 'None found' : 'No search term entered', 'warning']]);
  } else if (section === 'html') {
    const htmlPath = await writeHtmlReport(report.work_dir, report);
    terminal.panel('HTML Report', [
      ['Path', htmlPath, 'success']
    ]);
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
    ['Component Folders', storyblok.component_groups ? count(storyblok.component_groups) : 'Not queried'],
    ['Components', storyblok.components ? count(storyblok.components) : 'Not queried'],
    ['Stories', storyblok.stories ? count(storyblok.stories) : 'Not queried'],
    ['Asset Folders', storyblok.asset_folders ? count(storyblok.asset_folders) : 'Not queried'],
    ['Internal Tags', storyblok.internal_tags ? count(storyblok.internal_tags) : 'Not queried'],
    ['Presets', storyblok.presets ? count(storyblok.presets) : 'Not queried'],
    ['Assets', storyblok.assets ? count(storyblok.assets) : 'Not queried']
  ]);
}

function renderStoryblokAuditDashboard(terminal, storyblok) {
  if (!storyblok?.audit && !storyblok?.readiness) return;
  const readiness = storyblok.readiness || {};
  const governance = readiness.governance || {};
  const automation = readiness.automation || {};
  const unavailable = storyblok.audit?.unavailable || [];
  terminal.panel('Storyblok Audit Dashboard', [
    ['Workflows', governance.workflows ?? 'Not queried', governance.workflows ? 'success' : 'warning'],
    ['Releases', governance.releases ?? 'Not queried'],
    ['Collaborators', governance.collaborators ?? 'Not queried'],
    ['Space Roles', governance.space_roles ?? 'Not queried'],
    ['Tasks', governance.tasks ?? 'Not queried'],
    ['Approvals', governance.approvals ?? 'Not queried'],
    ['Webhooks', automation.webhook_endpoints ?? 'Not queried', automation.webhook_impact_review_recommended ? 'warning' : 'success'],
    ['Optional Collections', unavailable.length ? `${unavailable.length} unavailable` : 'Available', unavailable.length ? 'warning' : 'success']
  ]);
  if (automation.webhook_impact_review_recommended) {
    terminal.panel('Webhook Impact', [
      ['Review Required', `${automation.webhook_endpoints} webhook endpoint(s) may react to imported draft resources`, 'warning'],
      ['Safety', 'No webhook configuration is changed by this CLI', 'success']
    ]);
  }
}

function renderStoryblokPreflightSummary(terminal, preflight) {
  terminal.panel('Storyblok Preflight', [
    ['Status', preflight.status, preflight.status === 'passed' || preflight.status === 'skipped' ? 'success' : 'error'],
    ['Component Folders', preflight.requirements?.counts?.component_groups || 0],
    ['Internal Tags', preflight.requirements?.counts?.internal_tags || 0],
    ['Components', preflight.requirements?.counts?.components || 0],
    ['Presets', preflight.requirements?.counts?.presets || 0],
    ['Asset Folders', preflight.requirements?.counts?.asset_folders || 0],
    ['Assets', preflight.requirements?.counts?.assets || 0],
    ['Stories', preflight.requirements?.counts?.stories || 0],
    ['Failed Checks', (preflight.checks || []).filter((check) => check.required !== false && check.status !== 'passed').length, 'warning']
  ]);
}

function renderStoryblokContentValidationSummary(terminal, validation) {
  terminal.panel('Storyblok Content Validation', [
    ['Status', validation.status, validation.status === 'passed' || validation.status === 'skipped' ? 'success' : 'error'],
    ['Stories', validation.summary?.stories || 0],
    ['Failed Stories', validation.summary?.failed || 0, validation.summary?.failed ? 'error' : 'success'],
    ['Assets', validation.summary?.assets || 0],
    ['Story Links', validation.summary?.story_links || 0],
    ['Unresolved Links', validation.summary?.unresolved_generated_story_links || 0, validation.summary?.unresolved_generated_story_links ? 'warning' : 'success']
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
    ['Storyblok Folders', count(manifest.storyblok?.component_groups_to_create), 'success'],
    ['Storyblok Components', count(manifest.storyblok?.components_to_create), 'success'],
    ['Storyblok Presets', count(manifest.storyblok?.presets_to_create), count(manifest.storyblok?.presets_to_create) ? 'success' : 'warning'],
    ['Draft Stories', count(manifest.storyblok?.stories_to_create), 'success'],
    ['Storyblok Assets', count(manifest.storyblok?.assets_to_create), 'success'],
    ['Netlify', 'No changes', 'success'],
    ['Dependencies', 'No changes', 'success'],
    ['Safety', manifest.policy === 'additive-only-isolated' ? 'Additive Only' : manifest.policy, manifest.policy === 'additive-only-isolated' ? 'success' : 'warning']
  ]);
}

function renderApplyPreviewDiff(terminal, result) {
  const summary = summarizeApplyResult(result);
  terminal.panel('Apply Preview Diff', [
    ['Repository Files', summary.repository_files, summary.repository_files ? 'success' : 'warning'],
    ['Repository Assets', summary.repository_assets, summary.repository_assets ? 'success' : 'warning'],
    ['Component Folders', summary.component_groups, summary.component_groups ? 'success' : 'warning'],
    ['Internal Tags', summary.internal_tags, summary.internal_tags ? 'success' : 'warning'],
    ['Storyblok Components', summary.storyblok_components, summary.storyblok_components ? 'success' : 'warning'],
    ['Presets', summary.presets, summary.presets ? 'success' : 'warning'],
    ['Asset Folders', summary.asset_folders, summary.asset_folders ? 'success' : 'warning'],
    ['Assets', summary.assets, summary.assets ? 'success' : 'warning'],
    ['Draft Stories', summary.draft_stories, summary.draft_stories ? 'success' : 'warning'],
    ['Story Links', `${summary.resolved_story_links} resolved / ${summary.unresolved_story_links} unresolved`, summary.unresolved_story_links ? 'warning' : 'success']
  ]);
  renderRepositoryRoutePreviews(terminal, result);
}

function renderRouteHandoffSummary(terminal, result) {
  const summary = result.summary || {};
  terminal.panel('Route Handoff', [
    ['Status', result.status, result.status === 'blocked' ? 'error' : result.status === 'skipped' ? 'warning' : 'success'],
    ['Policy', result.policy || 'additive-only-route-handoff', 'success'],
    ['Dry Run', result.dry_run ? 'Yes' : 'No', result.dry_run ? 'warning' : 'success'],
    ['Would Create', summary.would_create || 0, summary.would_create ? 'success' : 'warning'],
    ['Created', summary.created || 0, summary.created ? 'success' : 'warning'],
    ['Blocked', summary.blocked || 0, summary.blocked ? 'error' : 'success'],
    ['Skipped', summary.skipped || 0, summary.skipped ? 'warning' : 'success']
  ]);
  const routes = ensureArray(result.routes).slice(0, 10);
  if (routes.length > 0) {
    terminal.panel('Host Route Files', routes.map((entry) => [
      entry.host_route_file || entry.slug,
      entry.status === 'blocked' ? entry.reason : entry.route_proposal_file || entry.reason || entry.status,
      entry.status === 'blocked' ? 'error' : entry.status === 'skipped' ? 'warning' : 'success'
    ]));
  }
  if (result.reason) {
    terminal.panel('Route Handoff Note', [
      ['Reason', result.reason, result.status === 'blocked' ? 'error' : 'warning']
    ]);
  }
}

function renderStoryblokOnlyPlanSummary(terminal, manifest) {
  terminal.panel('Storyblok Plan Summary', [
    ['Repository', 'Skipped for this test', 'warning'],
    ['Component Folders', count(manifest.storyblok?.component_groups_to_create), 'success'],
    ['Internal Tags', count(manifest.storyblok?.internal_tags_to_create), count(manifest.storyblok?.internal_tags_to_create) ? 'success' : 'warning'],
    ['Storyblok Components', count(manifest.storyblok?.components_to_create), 'success'],
    ['Presets', count(manifest.storyblok?.presets_to_create), count(manifest.storyblok?.presets_to_create) ? 'success' : 'warning'],
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
  const nextViolation = ensureArray(validation.violations)[0];
  if (nextViolation) {
    terminal.panel('Next Fix', [
      ['Resource', nextViolation.resource || nextViolation.path || 'Manifest', 'error'],
      ['Reason', nextViolation.reason || 'Policy validation failed', 'error'],
      ['Suggested Fix', suggestionForViolation(nextViolation), 'info']
    ]);
  }
}

function renderLocalValidationSummary(terminal, validation) {
  terminal.panel('Local Validation', [
    ['Status', validation.status, validation.status === 'passed' ? 'success' : 'error'],
    ['Failed Checks', validation.failed_checks || 0, validation.failed_checks ? 'error' : 'success']
  ]);
}

function renderCompletion(terminal, result, reportPath, { manifest = null, workDir = DEFAULT_WORK_DIR, repoPath = null } = {}) {
  terminal.header('Integration Complete', 'Additive-only workflow finished');
  terminal.panel('Repository', [
    ['Updated', result.dry_run ? 'Dry run only' : 'Yes', result.dry_run ? 'warning' : 'success']
  ]);
  terminal.panel('Storyblok', [
    ['Component Folders', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Components Created', 'Completed', 'success'],
    ['Presets Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Assets Uploaded', 'Completed', 'success'],
    ['Draft Story Created', 'Completed', 'success']
  ]);
  terminal.panel('Validation', [
    ['Passed', 'Yes', 'success']
  ]);
  terminal.panel('Report', [
    ['Path', reportPath, 'success']
  ]);
  renderWhatChanged(terminal, result, { repositorySkipped: false });
  const draftLinks = collectDraftEditorLinks(result);
  if (draftLinks.length > 0) {
    terminal.panel('Draft Story Links', draftLinks.map((entry) => [entry.slug, entry.editor_url, 'success']));
  }
  renderRepositoryRoutePreviews(terminal, result);
  renderCompletionNextSteps(terminal, result, {
    manifest,
    workDir,
    repoPath,
    reportPath,
    repositorySkipped: false
  });
}

function renderStoryblokOnlyCompletion(terminal, result, reportPath, { manifest = null, workDir = DEFAULT_WORK_DIR } = {}) {
  terminal.header('Storyblok Integration Complete', 'Repository output was skipped');
  terminal.panel('Repository', [
    ['Updated', 'No', 'warning']
  ]);
  terminal.panel('Storyblok', [
    ['Component Folders', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Components Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Presets Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Assets Uploaded', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success'],
    ['Draft Story Created', result.dry_run ? 'Dry run only' : 'Completed', result.dry_run ? 'warning' : 'success']
  ]);
  terminal.panel('Validation', [
    ['Passed', 'Yes', 'success']
  ]);
  terminal.panel('Report', [
    ['Path', reportPath, 'success']
  ]);
  renderWhatChanged(terminal, result, { repositorySkipped: true });
  const draftLinks = collectDraftEditorLinks(result);
  if (draftLinks.length > 0) {
    terminal.panel('Draft Story Links', draftLinks.map((entry) => [entry.slug, entry.editor_url, 'success']));
  }
  renderCompletionNextSteps(terminal, result, {
    manifest,
    workDir,
    reportPath,
    repositorySkipped: true
  });
}

function renderWhatChanged(terminal, result, { repositorySkipped = false } = {}) {
  const summary = summarizeApplyResult(result);
  const routePreviews = collectRepositoryRoutePreviews(result);
  terminal.panel('What Changed', [
    ['Repository Files', repositorySkipped ? 'Skipped' : summary.repository_files, repositorySkipped ? 'warning' : summary.repository_files ? 'success' : 'warning'],
    ['Route Previews', repositorySkipped ? 'Skipped' : routePreviews.length, repositorySkipped ? 'warning' : routePreviews.length ? 'success' : 'warning'],
    ['Component Folders', summary.component_groups, summary.component_groups ? 'success' : 'warning'],
    ['Storyblok Components', summary.storyblok_components, summary.storyblok_components ? 'success' : 'warning'],
    ['Presets', summary.presets, summary.presets ? 'success' : 'warning'],
    ['Assets Uploaded', summary.assets, summary.assets ? 'success' : 'warning'],
    ['Draft Stories', summary.draft_stories, summary.draft_stories ? 'success' : 'warning'],
    ['Story Links', `${summary.resolved_story_links} resolved / ${summary.unresolved_story_links} unresolved`, summary.unresolved_story_links ? 'warning' : 'success']
  ]);
}

function renderCompletionNextSteps(terminal, result, { manifest = null, workDir = DEFAULT_WORK_DIR, repoPath = null, reportPath = null, repositorySkipped = false } = {}) {
  const manifestPath = path.join(workDir, MANIFEST_NAME);
  const draftLinks = collectDraftEditorLinks(result);
  const routePreviews = collectRepositoryRoutePreviews(result);
  const firstDraft = draftLinks[0];
  const firstRoute = routePreviews[0];
  const integrationId = manifest?.integration_id || 'current integration';

  terminal.panel('Test Next', [
    ['Storyblok Drafts', firstDraft ? firstDraft.editor_url : `Open the ${integrationId} draft folder in Storyblok`, firstDraft ? 'success' : 'warning'],
    ['Generated Routes', repositorySkipped ? 'Skipped for Storyblok-only run' : firstRoute?.preview_file || 'No route previews recorded', repositorySkipped ? 'warning' : firstRoute ? 'success' : 'warning'],
    ['Host Routes', repositorySkipped ? 'Select a repository later for route handoff' : 'Use Continue Existing Integration -> Wire Repository Routes if live paths 404', repositorySkipped ? 'warning' : 'info'],
    ['Live Preview', 'Run repository validation/build and Netlify preview after pushing the target site', 'info']
  ]);

  const evidenceRows = [
    ['Report', reportPath || path.join(workDir, 'report.md'), 'success'],
    ['Manifest', manifestPath, 'success'],
    ['Validate Plan', `html-to-storyblok validate-plan --manifest ${manifestPath}`, 'success'],
    ['Rollback Preview', rollbackPreviewCommand(manifestPath, repoPath, repositorySkipped), 'warning']
  ];
  if (!repositorySkipped && repoPath) {
    evidenceRows.splice(3, 0, ['Validate Local Output', `html-to-storyblok validate --manifest ${manifestPath} --repo ${repoPath}`, 'success']);
  }
  terminal.panel('Evidence And Safety', evidenceRows);
}

function rollbackPreviewCommand(manifestPath, repoPath, repositorySkipped) {
  if (repositorySkipped || !repoPath) return `html-to-storyblok rollback-preview --manifest ${manifestPath}`;
  return `html-to-storyblok rollback-preview --manifest ${manifestPath} --repo ${repoPath}`;
}

async function readOptionalJson(filePath) {
  if (!(await pathExists(filePath))) return null;
  return readJson(filePath);
}

function count(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}

function rollbackImpactExamples(preview) {
  return [
    ...ensureArray(preview.repository_files_to_remove).slice(0, 3).map((entry) => ['Repository File', entry.path || entry, entry.owned_by_integration === false ? 'error' : 'warning']),
    ...ensureArray(preview.storyblok_components_to_remove).slice(0, 3).map((name) => ['Storyblok Component', name, 'warning']),
    ...ensureArray(preview.storyblok_stories_to_remove).slice(0, 3).map((slug) => ['Draft Story', slug, 'warning']),
    ...ensureArray(preview.storyblok_assets_to_remove).slice(0, 3).map((asset) => ['Storyblok Asset', asset, 'warning'])
  ].slice(0, 8);
}

function suggestionForViolation(violation = {}) {
  const reason = String(violation.reason || '');
  if (/duplicate|collision/i.test(reason)) {
    return 'Use a new integration ID or Storyblok prefix so generated resources remain unique.';
  }
  if (/namespace|outside|route|slug|path/i.test(reason)) {
    return 'Keep generated files, routes, stories, and assets inside the integration namespace.';
  }
  if (/publish|production|modify|delete|overwrite|mutation/i.test(reason)) {
    return 'Remove the unsafe mutation and create only unpublished, integration-owned resources.';
  }
  if (/reuse|coupling|dependency/i.test(reason)) {
    return 'Duplicate or isolate the dependency instead of coupling the import to existing project code.';
  }
  return 'Review the manifest entry and adjust it to satisfy the additive-only policy.';
}

function collectDraftEditorLinks(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return steps
    .flatMap((step) => Array.isArray(step?.results) ? step.results : [])
    .filter((entry) => entry?.action === 'create_draft_story' && entry.editor_url)
    .map((entry) => ({
      slug: entry.slug || entry.story_slug || `story-${entry.id}`,
      editor_url: entry.editor_url
    }))
    .slice(0, 6);
}

function renderRepositoryRoutePreviews(terminal, result) {
  const routePreviews = collectRepositoryRoutePreviews(result);
  if (routePreviews.length === 0) return;
  terminal.panel('Repository Route Previews', routePreviews.map((route) => [
    route.suggested_site_path || route.slug,
    route.preview_file ? `${route.preview_file} -> ${route.route_proposal_file || 'manual route review'}` : 'No generated route preview',
    route.preview_file ? 'success' : 'warning'
  ]));
}

function collectRepositoryRoutePreviews(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return steps
    .flatMap((step) => ensureArray(step?.route_previews))
    .filter((route) => route?.slug)
    .slice(0, 8);
}

function summarizeApplyResult(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const flatResults = steps.flatMap((step) => Array.isArray(step?.results) ? step.results : []);
  const duplicateStep = steps.find((step) => Array.isArray(step?.repository_assets) || Array.isArray(step?.repository_components));
  const generateStep = steps.find((step) => Array.isArray(step?.files_created) || Array.isArray(step?.repository_files));
  const draftStories = flatResults.filter((entry) => entry?.action === 'create_draft_story');
  return {
    repository_files: count(generateStep?.files_created || generateStep?.repository_files),
    repository_assets: count(duplicateStep?.repository_assets),
    component_groups: flatResults.filter((entry) => entry?.action === 'create_component_group').length,
    internal_tags: flatResults.filter((entry) => entry?.action === 'create_internal_tag').length,
    storyblok_components: flatResults.filter((entry) => entry?.action === 'create_component' || entry?.action === 'duplicate_storyblok_component').length,
    presets: flatResults.filter((entry) => entry?.action === 'create_component_preset').length,
    asset_folders: flatResults.filter((entry) => entry?.action === 'create_asset_folder').length,
    assets: flatResults.filter((entry) => entry?.action === 'upload_asset').length,
    draft_stories: draftStories.length,
    resolved_story_links: draftStories.reduce((total, entry) => total + Number(entry.link_summary?.resolved_story_links || 0), 0),
    unresolved_story_links: draftStories.reduce((total, entry) => total + Number(entry.link_summary?.unresolved_story_links || 0), 0)
  };
}

function collectEditableStoryLinks(manifest) {
  const plannedSlugs = plannedStorySlugSet(manifest);
  const links = [];
  for (const story of manifest.storyblok?.stories_to_create || []) {
    collectLinksFromValue(story.content || {}, {
      root: story.content || {},
      storySlug: story.slug || story.full_slug || 'draft-story',
      plannedSlugs,
      links,
      path: []
    });
  }
  return links;
}

function collectLinksFromValue(value, context) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLinksFromValue(entry, { ...context, path: [...context.path, index] }));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isEditableStoryblokLink(value)) {
    const target = value.cached_url || value.url || '';
    linksPush(context.links, {
      root: context.root,
      path: context.path,
      value,
      target,
      linktype: value.linktype,
      resolved: value.linktype !== 'story' || context.plannedSlugs.has(normalizeStorySlug(target)) || Boolean(value.id),
      label: `${context.storySlug}:${context.path.join('.') || 'root'}`
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectLinksFromValue(entry, { ...context, path: [...context.path, key] });
  }
}

function collectEditableSchemaFields(manifest) {
  const fields = [];
  for (const component of manifest.storyblok?.components_to_create || []) {
    const componentName = component.technical_name || component.name;
    for (const [fieldName, schema] of Object.entries(component.schema || {})) {
      fields.push({
        component: componentName,
        name: fieldName,
        schema,
        type: schema.type || 'text',
        displayName: schema.display_name || ''
      });
    }
  }
  return fields;
}

function plannedStorySlugSet(manifest) {
  return new Set((manifest.storyblok?.stories_to_create || [])
    .map((story) => normalizeStorySlug(story.slug || story.full_slug))
    .filter(Boolean));
}

function plannedStoryChoices(manifest) {
  return [...plannedStorySlugSet(manifest)].map((slug) => ({
    label: `Generated story: ${slug}`,
    value: slug
  }));
}

function isEditableStoryblokLink(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.linktype === 'string' &&
    ('cached_url' in value || 'url' in value || 'id' in value);
}

function setNestedValue(root, pathParts, nextValue) {
  if (!pathParts.length) return;
  let cursor = root;
  for (const part of pathParts.slice(0, -1)) {
    cursor = cursor[part];
  }
  cursor[pathParts.at(-1)] = nextValue;
}

function normalizeStorySlug(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^[./]+/, '')
    .replace(/^\/+|\/+$/g, '');
}

function titleFromFieldName(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function linksPush(links, entry) {
  links.push(entry);
}

function withPlanValidation(manifest) {
  manifest.validation = validatePlan(manifest);
  return manifest;
}

function latestStoryblokContentStep(result) {
  return Array.isArray(result?.steps)
    ? result.steps.find((step) => step?.action === 'validate_storyblok_content')
    : null;
}

function failedStepFromApply(result) {
  if (!Array.isArray(result?.steps)) return null;
  const failed = result.steps.find((step) => step?.status === 'failed' || step?.results?.status === 'failed');
  return failed?.action || null;
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

function settingsKeys() {
  return Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'project_profiles');
}

function profileSummary(profile = {}) {
  const parts = [
    profile.default_repository ? `repo ${profile.default_repository}` : null,
    profile.templates_folder ? `templates ${profile.templates_folder}` : null,
    profile.storyblok_region ? `region ${profile.storyblok_region}` : null,
    profile.default_output_folder ? `output ${profile.default_output_folder}` : null
  ].filter(Boolean);
  return parts.join(', ') || 'No overrides';
}

function storyblokArtifactSummary(artifact) {
  if (artifact.type === 'storyblok_preflight') {
    return `${artifact.status}; ${artifact.failed_checks || 0} failed checks`;
  }
  if (artifact.type === 'storyblok_reconcile') {
    return `${artifact.status}; ${artifact.matching || 0} matching; ${artifact.missing || 0} missing; ${artifact.drifted || 0} drifted; ${artifact.blocked || 0} blocked`;
  }
  if (artifact.type === 'storyblok_management_verification') {
    return `${artifact.status}; ${artifact.failed_story_checks || 0} failed story checks; ${artifact.unresolved_generated_story_links || 0} unresolved links; ${artifact.unresolved_asset_fields || 0} unresolved assets`;
  }
  if (artifact.type === 'storyblok_audit') {
    return `${artifact.status}; ${artifact.unavailable_collections || 0} optional collections unavailable`;
  }
  if (artifact.type === 'storyblok_activity_evidence') {
    return `${artifact.related || 0} related activities`;
  }
  if (artifact.type === 'storyblok_content_validation') {
    return `${artifact.status}; ${artifact.stories || 0} stories; ${artifact.unresolved_generated_story_links || 0} unresolved links`;
  }
  if (artifact.type === 'storyblok_apply_result' || artifact.type === 'apply_result') {
    return `${artifact.component_groups_created_or_reused || 0} folders; ${artifact.components_created_or_reused || 0} components; ${artifact.presets_created_or_reused || 0} presets; ${artifact.assets_created_or_reused || 0} assets; ${artifact.draft_stories_created_or_reused || 0} stories`;
  }
  return artifact.status || 'recorded';
}

function renderStoryblokReportDrilldown(terminal, artifacts) {
  const reconcile = artifacts.find((artifact) => artifact.type === 'storyblok_reconcile');
  const verification = artifacts.find((artifact) => artifact.type === 'storyblok_management_verification');
  const audit = artifacts.find((artifact) => artifact.type === 'storyblok_audit');
  if (reconcile) {
    terminal.panel('Reconcile Drilldown', [
      ['Matching', reconcile.matching || 0, 'success'],
      ['Missing', reconcile.missing || 0, reconcile.missing ? 'warning' : 'success'],
      ['Drifted', reconcile.drifted || 0, reconcile.drifted ? 'error' : 'success'],
      ['Blocked', reconcile.blocked || 0, reconcile.blocked ? 'error' : 'success']
    ]);
  }
  if (verification) {
    terminal.panel('Verification Drilldown', [
      ['Failed Story Checks', verification.failed_story_checks || 0, verification.failed_story_checks ? 'error' : 'success'],
      ['Unresolved Story Links', verification.unresolved_generated_story_links || 0, verification.unresolved_generated_story_links ? 'warning' : 'success'],
      ['Unresolved Asset Fields', verification.unresolved_asset_fields || 0, verification.unresolved_asset_fields ? 'warning' : 'success']
    ]);
  }
  if (audit?.automation?.webhook_impact_review_recommended) {
    terminal.panel('Webhook Impact', [
      ['Webhooks', audit.automation.webhook_endpoints || 0, 'warning'],
      ['Action', 'Review automation before real apply', 'warning']
    ]);
  }
}

function searchReport(report, term) {
  const query = String(term || '').toLowerCase().trim();
  if (!query) return [];
  const matches = [];
  for (const artifact of report.artifacts || []) {
    const text = JSON.stringify(artifact);
    if (text.toLowerCase().includes(query)) {
      matches.push({
        type: artifact.type,
        text: artifact.artifact || artifact.status || 'artifact',
        status: artifact.status === 'failed' ? 'error' : 'success'
      });
    }
  }
  for (const failure of report.commands_failed || []) {
    const text = `${failure.command} ${failure.message}`;
    if (text.toLowerCase().includes(query)) {
      matches.push({
        type: 'failure',
        text,
        status: 'error'
      });
    }
  }
  return matches;
}

function statusForStepResult(result) {
  if (Array.isArray(result)) {
    return result.some((entry) => entry.status === 'failed') ? 'error' : 'success';
  }
  if (result?.status === 'failed') return 'error';
  if (result?.status === 'skipped') return 'warning';
  return 'success';
}

function labelForAction(action) {
  return labelForSetting(String(action || 'unknown').replaceAll('-', '_'));
}

function labelForStatus(status) {
  const labels = {
    complete: 'Complete',
    dry_run_complete: 'Dry Run Complete',
    passed: 'Passed',
    failed: 'Failed',
    blocked: 'Blocked',
    cancelled: 'Cancelled',
    missing: 'Missing'
  };
  return labels[status] || labelForSetting(String(status || 'complete'));
}
