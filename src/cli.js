import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveAccess } from './access.js';
import { CLI_BRANDING_LINES } from './branding.js';
import { duplicateAll } from './duplicator.js';
import { ENV_TEMPLATE, initEnvFile, loadEnvironment } from './env.js';
import { ensureWorkDir, recordEvidence, writeArtifact, DEFAULT_WORK_DIR } from './evidence.js';
import { generateIntegration } from './generator.js';
import { openDraftPullRequest } from './github.js';
import { openDraftMergeRequest } from './gitlab.js';
import { readIntegrationHistory, recordIntegrationHistory } from './history.js';
import { runDashboard, runDoctorCommand, runInteractiveApp, runReportViewer, runSettings } from './interactive.js';
import { inspectNetlify, inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { queryNetlifyDeployPreviews, verifyNetlifyDeployPreview } from './netlify.js';
import { validatePlan } from './policy.js';
import { createReadinessHandoff } from './readiness.js';
import { createReport, writeHtmlReport } from './reporter.js';
import { createRollbackPreview, rollbackIntegration } from './rollback.js';
import { wireRepositoryRoutes } from './route-handoff.js';
import { collectStoryblokActivityEvidence, createDraftStories, createStoryblokAssetFolders, createStoryblokComponentGroups, createStoryblokComponents, createStoryblokInternalTags, createStoryblokPresets, inspectStoryblokContentStory, inspectStoryblokSpace, preflightStoryblokIntegration, reconcileStoryblokManifest, uploadStoryblokAssets, validateStoryblokDraftContent, verifyStoryblokManagementState } from './storyblok.js';
import { commandName, parseArgs, readJson, requireOption, writeJson } from './utils.js';
import { diffIntegration, preflightRepositoryIntegration, runRepositoryScript, validateIntegration } from './validator.js';
import { applyManifest, applyStoryblokOnly, createPlanFromArgs, inferDuplicatesForManifest, readAndValidateManifest } from './workflow.js';

const MUTATING_COMMANDS = new Set([
  'apply',
  'create-draft-story',
  'duplicate',
  'generate',
  'infer-duplicates',
  'open-mr',
  'open-pr',
  'rollback',
  'storyblok-apply',
  'storyblok-asset-folders',
  'storyblok-component-groups',
  'storyblok-components',
  'storyblok-internal-tags',
  'storyblok-presets',
  'upload-assets',
  'wire-routes'
]);

export async function main(argv) {
  const command = normalizeCommand(commandName(argv));
  const args = parseArgs(argv);
  const workDir = String(args.work_dir || DEFAULT_WORK_DIR);
  await ensureWorkDir(workDir);

  if (command === 'help' || args.help) {
    printHelp();
    return;
  }

  if (command === 'interactive' && (args.no_interactive || !process.stdin.isTTY || !process.stdout.isTTY)) {
    printHelp();
    return;
  }

  const environment = await loadEnvironment({
    repoPath: args.repo ? String(args.repo) : null,
    env: process.env
  });
  const { env } = environment;

  await recordEvidence(workDir, {
    type: 'command_started',
    command,
    args: redactArgs(args)
  });

  let result;
  let printJson = true;
  try {
    if (command === 'interactive') {
      result = await runInteractiveApp({ args });
      printJson = false;
    } else if (command === 'dashboard') {
      result = await runDashboard({ args });
      printJson = false;
    } else if (command === 'settings') {
      result = await runSettings({ args });
      printJson = false;
    } else if (command === 'doctor') {
      result = await runDoctorCommand({ args });
      printJson = false;
    } else if (command === 'view-report') {
      result = await runReportViewer({ args });
      printJson = false;
    } else if (command === 'history') {
      result = await readIntegrationHistory(workDir, {
        limit: args.limit ? Number(args.limit) : undefined
      });
    } else if (command === 'demo-sites') {
      result = await runDemoSitesValidation(args, {
        silent: Boolean(args.json_summary)
      });
      await writeArtifact(workDir, 'demo-sites-validation-result.json', result);
      if (demoSitesResultFailed(result)) process.exitCode = 2;
      printJson = Boolean(args.json_summary);
    } else if (command === 'demo-sites-live-preview') {
      result = await runLiveDemoPreviewValidation(args, {
        silent: Boolean(args.json_summary)
      });
      await writeArtifact(workDir, 'demo-sites-live-preview-result.json', result);
      if (demoSitesResultFailed(result)) process.exitCode = 2;
      printJson = Boolean(args.json_summary);
    } else if (command === 'completion') {
      console.log(renderShellCompletion(args.shell ? String(args.shell) : 'zsh'));
      result = { action: 'completion', shell: args.shell ? String(args.shell) : 'zsh' };
      printJson = false;
    } else if (command === 'env') {
      if (args.print) {
        console.log(ENV_TEMPLATE.trimEnd());
        result = { action: 'env_template', status: 'printed', secrets_written: false };
        printJson = false;
      } else if (args.init || args.path || args.force) {
        result = await initEnvFile({
          cwd: process.cwd(),
          filePath: args.path ? String(args.path) : '.env.local',
          force: Boolean(args.force)
        });
        await writeArtifact(workDir, 'env-init-result.json', result);
      } else {
        result = {
          action: 'env_status',
          status: 'recorded',
          files_loaded: environment.files_loaded,
          variables_loaded: environment.variables_loaded,
          access: checkLiveAccess(env)
        };
      }
    } else if (command === 'inspect-template') {
      result = await inspectTemplate(requireOption(args, 'template'));
      await writeArtifact(workDir, 'template-inventory.json', result);
    } else if (command === 'template-readiness') {
      const inventory = await inspectTemplate(requireOption(args, 'template'));
      await writeArtifact(workDir, 'template-inventory.json', inventory);
      result = inventory.template_readiness;
      await writeArtifact(workDir, 'template-readiness.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'inspect-repository') {
      result = await inspectRepository(requireOption(args, 'repo'));
      await writeArtifact(workDir, 'repository-inspection.json', result);
    } else if (command === 'inspect-netlify') {
      result = await inspectNetlify(requireOption(args, 'repo'));
      await writeArtifact(workDir, 'netlify-inspection.json', result);
    } else if (command === 'inspect-storyblok') {
      result = args.remote ? await inspectStoryblokSpace({ env, full: Boolean(args.full), audit: Boolean(args.audit) }) : inspectStoryblokEnvironment(env);
      await writeArtifact(workDir, 'storyblok-access.json', result);
    } else if (command === 'storyblok-audit') {
      result = await inspectStoryblokSpace({ env, full: Boolean(args.full), audit: true });
      await writeArtifact(workDir, 'storyblok-audit.json', result);
    } else if (command === 'inspect-storyblok-content') {
      result = await inspectStoryblokContentStory({
        slug: requireOption(args, 'slug'),
        version: args.version ? String(args.version) : 'draft',
        env
      });
      await writeArtifact(workDir, 'storyblok-content-result.json', result);
    } else if (command === 'netlify-preview') {
      result = args.verify
        ? await verifyNetlifyDeployPreview({
          siteId: args.site_id ? String(args.site_id) : undefined,
          branch: args.branch ? String(args.branch) : undefined,
          deployId: args.deploy_id ? String(args.deploy_id) : undefined,
          expectedBuildCommand: args.expected_build_command ? String(args.expected_build_command) : undefined,
          expectedPublishDirectory: args.expected_publish_directory ? String(args.expected_publish_directory) : undefined,
          expectedContext: args.expected_context ? String(args.expected_context) : 'deploy-preview',
          wait: Boolean(args.wait),
          timeoutMs: args.timeout_ms ? Number(args.timeout_ms) : undefined,
          intervalMs: args.interval_ms ? Number(args.interval_ms) : undefined,
          includeLogs: Boolean(args.include_logs),
          logsSince: args.logs_since ? String(args.logs_since) : undefined,
          logsSource: args.logs_source ? String(args.logs_source) : undefined,
          repoPath: args.repo ? String(args.repo) : process.cwd(),
          env
        })
        : await queryNetlifyDeployPreviews({
          siteId: args.site_id ? String(args.site_id) : undefined,
          branch: args.branch ? String(args.branch) : undefined,
          deployId: args.deploy_id ? String(args.deploy_id) : undefined,
          env
        });
      await writeArtifact(workDir, 'netlify-preview.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'readiness') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createReadinessHandoff({
        manifest,
        repoPath: args.repo ? String(args.repo) : null,
        templatePath: args.template ? String(args.template) : manifest.template?.source_path || null,
        workDir,
        env,
        remote: Boolean(args.remote),
        requireStoryblok: Boolean(args.require_storyblok),
        requireRepository: Boolean(args.require_repository)
      });
      await writeArtifact(workDir, 'readiness-result.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'check-access') {
      result = checkLiveAccess(env);
      await writeArtifact(workDir, 'access-readiness.json', result);
    } else if (command === 'plan') {
      result = await createPlanFromArgs(args, workDir);
      await writeArtifact(workDir, 'integration-manifest.json', result);
      await recordIntegrationHistory(workDir, {
        manifest: result,
        action: 'plan',
        status: 'planned',
        repoPath: args.repo ? String(args.repo) : null,
        validation: result.validation
      });
    } else if (command === 'infer-duplicates') {
      const manifestPath = requireOption(args, 'manifest');
      const manifest = await readAndValidateManifest(args, workDir);
      const storyblokInspection = args.storyblok_inspection ? await readJson(String(args.storyblok_inspection)) : null;
      const inferred = await inferDuplicatesForManifest(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        storyblokInspection
      });
      if (args.write_manifest) {
        await writeJson(manifestPath, inferred.manifest);
      }
      result = {
        action: 'infer_duplicates',
        manifest_written: Boolean(args.write_manifest),
        inference: inferred.inference,
        validation: inferred.manifest.validation
      };
      await writeArtifact(workDir, 'duplication-inference.json', result);
      if (!inferred.manifest.validation.valid) process.exitCode = 2;
    } else if (command === 'validate-plan') {
      const manifest = await readJson(requireOption(args, 'manifest'));
      result = validatePlan(manifest);
      if (args.severity) result = filterValidationBySeverity(result, String(args.severity));
      await writeArtifact(workDir, 'plan-validation.json', result);
      if (!result.valid) process.exitCode = 2;
    } else if (command === 'storyblok-preflight') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await preflightStoryblokIntegration(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-preflight.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'validate-storyblok') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await validateStoryblokDraftContent(manifest, {
        dryRun: Boolean(args.dry_run),
        version: args.version ? String(args.version) : 'draft',
        env
      });
      await writeArtifact(workDir, 'storyblok-content-validation.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'storyblok-reconcile') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await reconcileStoryblokManifest(manifest, { env });
      await writeArtifact(workDir, 'storyblok-reconcile.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'storyblok-verify') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await verifyStoryblokManagementState(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-management-verification.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'storyblok-activities') {
      const manifest = args.manifest ? await readAndValidateManifest(args, workDir) : {};
      result = await collectStoryblokActivityEvidence(manifest, {
        dryRun: Boolean(args.dry_run),
        env,
        since: args.since ? String(args.since) : null,
        limit: args.limit ? Number(args.limit) : 50
      });
      await writeArtifact(workDir, 'storyblok-activity-evidence.json', result);
    } else if (command === 'diff') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await diffIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd()
      });
      await writeArtifact(workDir, 'diff-result.json', result);
    } else if (command === 'repository-preflight') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await preflightRepositoryIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd()
      });
      await writeArtifact(workDir, 'repository-preflight.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'build') {
      result = await runRepositoryScript({
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        script: args.script ? String(args.script) : 'build',
        dryRun: Boolean(args.dry_run)
      });
      await writeArtifact(workDir, 'build-result.json', result);
      if (result.status === 'failed') process.exitCode = result.exit_code || 1;
    } else if (command === 'validate') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await validateIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd()
      });
      await writeArtifact(workDir, 'validation-result.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'report') {
      if (args.view) {
        result = await runReportViewer({ args });
        printJson = false;
      } else {
        result = await createReport(workDir);
        if (args.html) {
          result.html_report = await writeHtmlReport(workDir, result);
        }
      }
    } else if (command === 'examples') {
      const manifest = args.manifest ? await readJson(requireOption(args, 'manifest')) : await readJson(`${workDir}/integration-manifest.json`);
      result = createCommandExamples(manifest, { workDir, repoPath: args.repo ? String(args.repo) : '<repo-path>', templatePath: args.template ? String(args.template) : manifest.template?.source_path || '<template-path>' });
    } else if (command === 'storyblok-components') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokComponents(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-components-result.json', result);
    } else if (command === 'storyblok-component-groups') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokComponentGroups(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-component-groups-result.json', result);
    } else if (command === 'storyblok-internal-tags') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokInternalTags(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-internal-tags-result.json', result);
    } else if (command === 'storyblok-presets') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokPresets(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-presets-result.json', result);
    } else if (command === 'storyblok-asset-folders') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokAssetFolders(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-asset-folders-result.json', result);
    } else if (command === 'upload-assets') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await uploadStoryblokAssets(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-assets-result.json', result);
    } else if (command === 'create-draft-story') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createDraftStories(manifest, { dryRun: Boolean(args.dry_run), env });
      await writeArtifact(workDir, 'storyblok-draft-stories-result.json', result);
    } else if (command === 'storyblok-apply') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await applyStoryblokOnly(manifest, { ...args, env }, workDir);
      await recordIntegrationHistory(workDir, {
        manifest,
        action: 'storyblok_apply',
        status: result.dry_run ? 'dry_run_complete' : 'complete',
        repositorySkipped: true,
        result
      });
    } else if (command === 'generate') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await generateIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        templatePath: args.template ? String(args.template) : undefined,
        framework: args.framework ? String(args.framework) : 'auto',
        dryRun: Boolean(args.dry_run)
      });
      await writeArtifact(workDir, 'generate-result.json', result);
    } else if (command === 'wire-routes') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await wireRepositoryRoutes(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        dryRun: Boolean(args.dry_run),
        route: args.route ? String(args.route) : null
      });
      await writeArtifact(workDir, 'route-handoff-result.json', result);
      if (result.status === 'blocked' || result.status === 'failed') process.exitCode = 2;
    } else if (command === 'duplicate') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await duplicateAll(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        dryRun: Boolean(args.dry_run),
        env
      });
      await writeArtifact(workDir, 'duplication-result.json', result);
    } else if (command === 'apply') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await applyManifest(manifest, { ...args, env }, workDir);
      await recordIntegrationHistory(workDir, {
        manifest,
        action: 'apply',
        status: result.dry_run ? 'dry_run_complete' : 'complete',
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        result
      });
    } else if (command === 'open-pr') {
      const reviewManifest = args.manifest ? await readAndValidateManifest(args, workDir) : null;
      result = await openDraftPullRequest({
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        owner: args.owner ? String(args.owner) : undefined,
        repo: args.github_repo ? String(args.github_repo) : undefined,
        title: args.title ? String(args.title) : undefined,
        body: args.body ? String(args.body) : undefined,
        head: args.head ? String(args.head) : undefined,
        base: args.base ? String(args.base) : 'main',
        manifest: reviewManifest,
        prepareBranch: Boolean(args.prepare_branch),
        commit: Boolean(args.commit),
        push: Boolean(args.push),
        commitMessage: args.commit_message ? String(args.commit_message) : undefined,
        remoteName: args.remote ? String(args.remote) : 'origin',
        dryRun: Boolean(args.dry_run),
        env
      });
      await writeArtifact(workDir, 'github-pr-result.json', result);
    } else if (command === 'open-mr') {
      const reviewManifest = args.manifest ? await readAndValidateManifest(args, workDir) : null;
      result = await openDraftMergeRequest({
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        project: args.project ? String(args.project) : undefined,
        title: args.title ? String(args.title) : undefined,
        body: args.body ? String(args.body) : undefined,
        sourceBranch: args.source_branch ? String(args.source_branch) : args.head ? String(args.head) : undefined,
        targetBranch: args.target_branch ? String(args.target_branch) : args.base ? String(args.base) : 'main',
        removeSourceBranch: Boolean(args.remove_source_branch),
        manifest: reviewManifest,
        prepareBranch: Boolean(args.prepare_branch),
        commit: Boolean(args.commit),
        push: Boolean(args.push),
        commitMessage: args.commit_message ? String(args.commit_message) : undefined,
        remoteName: args.remote ? String(args.remote) : 'origin',
        dryRun: Boolean(args.dry_run),
        env
      });
      await writeArtifact(workDir, 'gitlab-mr-result.json', result);
    } else if (command === 'rollback-preview') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = createRollbackPreview(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd()
      });
      await writeArtifact(workDir, 'rollback-preview.json', result);
    } else if (command === 'rollback') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await rollbackIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        dryRun: Boolean(args.dry_run),
        confirmIntegrationId: args.confirm_integration_id ? String(args.confirm_integration_id) : undefined,
        remote: Boolean(args.remote),
        confirmRemoteDelete: Boolean(args.confirm_remote_delete),
        allowModifiedGeneratedFiles: Boolean(args.allow_modified_generated_files),
        env
      });
      await writeArtifact(workDir, 'rollback-result.json', result);
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    await recordEvidence(workDir, {
      type: 'command_failed',
      command,
      exit_code: process.exitCode || 1,
      error_code: errorCodeFor(error, command),
      message: redactMessage(error.message || String(error))
    });
    error.code ||= errorCodeFor(error, command);
    throw error;
  }

  await recordEvidence(workDir, {
    type: 'command_completed',
    command,
    exit_code: process.exitCode || 0
  });
  if (printJson) console.log(JSON.stringify(args.json_summary ? summarizeCommandResult(command, result) : result, null, 2));
}

function normalizeCommand(command) {
  const aliases = {
    'sb-audit': 'storyblok-audit',
    'sb-reconcile': 'storyblok-reconcile',
    'sb-verify': 'storyblok-verify',
    'sb-activities': 'storyblok-activities',
    'sb-preflight': 'storyblok-preflight',
    'sb-validate': 'validate-storyblok',
    'sb-apply': 'storyblok-apply',
    'route-handoff': 'wire-routes',
    'live-demo-sites': 'demo-sites-live-preview',
    handoff: 'readiness',
    examples: 'examples'
  };
  return aliases[command] || command;
}

function redactArgs(args) {
  const redacted = {};
  for (const [key, value] of Object.entries(args)) {
    redacted[key] = /token|secret|password|key/i.test(key) ? '[REDACTED]' : value;
  }
  return redacted;
}

function redactMessage(message) {
  return String(message)
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*[A-Za-z0-9._-]+/gi, 'Authorization: [REDACTED]');
}

function errorCodeFor(error, command) {
  const message = String(error?.message || error || '');
  if (command === 'demo-sites' || command === 'demo-sites-live-preview') return 'HTS_DEMO_SITES_VALIDATION';
  if (/credential|token|space id|Management API/i.test(message)) return 'HTS_STORYBLOK_CREDENTIALS';
  if (/manifest failed|additive-only|Policy|violations/i.test(message)) return 'HTS_POLICY_VALIDATION';
  if (/Storyblok .* failed with 429|rate limit/i.test(message)) return 'HTS_STORYBLOK_RATE_LIMIT';
  if (/timeout|timed out/i.test(message)) return 'HTS_TIMEOUT';
  if (/unknown command/i.test(message)) return 'HTS_UNKNOWN_COMMAND';
  if (/local validation failed|validate/i.test(message) || command === 'validate') return 'HTS_VALIDATION_FAILED';
  return 'HTS_COMMAND_FAILED';
}

function summarizeCommandResult(command, result) {
  const summary = {
    command,
    action: result?.action || command,
    status: result?.status || statusFromResult(result),
    dry_run: Boolean(result?.dry_run)
  };
  if (result?.integration_id) summary.integration_id = result.integration_id;
  if (result?.validation?.valid !== undefined) summary.plan_valid = Boolean(result.validation.valid);
  if (result?.valid !== undefined) summary.plan_valid = Boolean(result.valid);
  if (result?.summary) summary.summary = result.summary;
  if (Array.isArray(result?.steps)) summary.steps = result.steps.length;
  if (Array.isArray(result?.sites)) {
    summary.sites = result.sites.length;
    summary.failed_sites = result.sites.filter((site) => site.status === 'failed').length;
    summary.preview_report = result.preview_report || undefined;
  }
  if (Array.isArray(result?.routes) && result.routes.every((route) => route && typeof route === 'object')) {
    summary.routes = result.routes.length;
    summary.blocked_routes = result.routes.filter((entry) => entry.status === 'blocked').length;
    summary.created_routes = result.routes.filter((entry) => entry.status === 'created').length;
    summary.would_create_routes = result.routes.filter((entry) => entry.status === 'would_create').length;
    summary.manual_handoff_routes = result.routes.filter((entry) => entry.manual_handoff).length;
  } else if (Array.isArray(result?.routes)) {
    summary.routes = result.routes.length;
  }
  if (result?.manual_handoff?.required) summary.manual_handoff_required = true;
  if (Array.isArray(result?.resources)) {
    summary.resources = result.resources.length;
    summary.failed_resources = result.resources.filter((entry) => ['drifted', 'blocked'].includes(entry.status)).length;
  }
  if (Array.isArray(result?.stories)) {
    summary.stories = result.stories.length;
    summary.failed_stories = result.stories.filter((entry) => entry.status === 'failed').length;
  }
  if (result?.html_report) summary.html_report = result.html_report;
  if (result?.markdown_report) summary.markdown_report = result.markdown_report;
  return summary;
}

function statusFromResult(result) {
  if (!result) return 'unknown';
  if (result.valid === false) return 'failed';
  if (result.valid === true) return 'passed';
  if (Array.isArray(result.sites)) return demoSitesResultFailed(result) ? 'failed' : 'passed';
  if (Array.isArray(result.resources) && result.resources.some((entry) => ['drifted', 'blocked'].includes(entry.status))) return 'failed';
  if (Array.isArray(result.steps) && result.steps.some((step) => step.status === 'failed')) return 'failed';
  return 'recorded';
}

async function runDemoSitesValidation(args, { silent = false } = {}) {
  const scriptArgs = buildDemoSitesRunnerArgs(args);
  const execution = await runDelegatedScript(scriptArgs, args, { silent });

  const parsed = parseDelegatedRunnerOutput(execution.stdout, execution.stderr, 'test_demo_sites_full');
  if (execution.exitCode !== 0) {
    parsed.status ||= 'failed';
    parsed.exit_code = execution.exitCode;
  }
  return parsed;
}

async function runLiveDemoPreviewValidation(args, { silent = false } = {}) {
  const scriptArgs = buildLiveDemoPreviewRunnerArgs(args);
  const execution = await runDelegatedScript(scriptArgs, args, { silent });
  const parsed = parseDelegatedRunnerOutput(execution.stdout, execution.stderr, 'test_demo_sites_live_preview');
  if (execution.exitCode !== 0) {
    parsed.status ||= 'failed';
    parsed.exit_code = execution.exitCode;
  }
  return parsed;
}

async function runDelegatedScript(scriptArgs, args, { silent }) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const timeoutMs = args.timeout_ms ? Number(args.timeout_ms) : 10 * 60 * 1000;
  return runNodeScript(scriptArgs, {
    cwd: repoRoot,
    timeoutMs,
    silent
  });
}

function buildDemoSitesRunnerArgs(args) {
  const scriptArgs = ['scripts/test-demo-sites-full.mjs'];
  appendBooleanArg(scriptArgs, args, 'list', '--list');
  appendValueArg(scriptArgs, args, 'site', '--site');
  appendBooleanArg(scriptArgs, args, 'install', '--install');
  appendBooleanArg(scriptArgs, args, 'smoke', '--smoke');
  appendBooleanArg(scriptArgs, args, 'require_framework', '--require-framework');
  if (args.generated || args.generated_integration) scriptArgs.push('--generated');
  appendBooleanArg(scriptArgs, args, 'keep_generated', '--keep-generated');
  appendValueArg(scriptArgs, args, 'report', '--report');
  appendValueArg(scriptArgs, args, 'report_path', '--report-path');
  return scriptArgs;
}

function buildLiveDemoPreviewRunnerArgs(args) {
  const scriptArgs = ['scripts/test-demo-sites-live-preview.mjs'];
  appendBooleanArg(scriptArgs, args, 'list', '--list');
  appendValueArg(scriptArgs, args, 'site', '--site');
  appendValueArg(scriptArgs, args, 'routes', '--routes');
  appendValueArg(scriptArgs, args, 'timeout_ms', '--timeout-ms');
  appendBooleanArg(scriptArgs, args, 'require_configured', '--require-configured');
  appendBooleanArg(scriptArgs, args, 'require_storyblok_draft', '--require-storyblok-draft');
  appendValueArg(scriptArgs, args, 'integration_id', '--integration-id');
  appendValueArg(scriptArgs, args, 'fixture', '--fixture');
  appendValueArg(scriptArgs, args, 'base_url', '--base-url');
  appendValueArg(scriptArgs, args, 'url', '--url');
  for (const site of ['static', 'astro', 'next', 'nuxt', 'vue', 'react']) {
    appendValueArg(scriptArgs, args, `${site}_url`, `--${site}-url`);
  }
  return scriptArgs;
}

function appendBooleanArg(scriptArgs, args, key, flag) {
  if (args[key]) scriptArgs.push(flag);
}

function appendValueArg(scriptArgs, args, key, flag) {
  if (args[key] !== undefined && args[key] !== true) {
    const values = Array.isArray(args[key]) ? args[key] : [args[key]];
    for (const value of values) {
      scriptArgs.push(flag, String(value));
    }
  }
}

function runNodeScript(scriptArgs, { cwd, timeoutMs, silent }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!silent) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!silent) process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${scriptArgs.join(' ')} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode: exitCode ?? (signal ? 1 : 0) });
    });
  });
}

function parseDelegatedRunnerOutput(output, diagnostics = '', action) {
  const marker = `{\n  "action": "${action}"`;
  const index = output.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(`${action} did not return a JSON result: ${tailText(diagnostics || output)}`);
  }
  return JSON.parse(output.slice(index));
}

function tailText(text, limit = 2000) {
  const value = String(text || '').trim();
  return value.length > limit ? value.slice(-limit) : value;
}

function demoSitesResultFailed(result) {
  if (result?.status === 'failed') return true;
  return Array.isArray(result?.sites) && result.sites.some((site) => site.status === 'failed');
}

function createCommandExamples(manifest, { workDir, repoPath, templatePath }) {
  const manifestPath = `${workDir}/integration-manifest.json`;
  const integrationId = manifest.integration_id || '<integration-id>';
  const planRepositoryArg = repoPath && repoPath !== '<repo-path>' ? ` --repo ${repoPath}` : '';
  return {
    action: 'command_examples',
    integration_id: integrationId,
    examples: [
      `html-to-storyblok inspect-template --template ${templatePath}`,
      `html-to-storyblok template-readiness --template ${templatePath}`,
      `html-to-storyblok storyblok-audit --full --work-dir ${workDir}`,
      `html-to-storyblok plan --integration-id ${integrationId} --template ${templatePath}${planRepositoryArg} --framework ${manifest.template?.framework || 'static'} --work-dir ${workDir}`,
      `html-to-storyblok validate-plan --manifest ${manifestPath}`,
      `html-to-storyblok storyblok-preflight --manifest ${manifestPath}`,
      `html-to-storyblok storyblok-reconcile --manifest ${manifestPath}`,
      `html-to-storyblok storyblok-apply --manifest ${manifestPath} --dry-run`,
      `html-to-storyblok storyblok-verify --manifest ${manifestPath}`,
      `html-to-storyblok repository-preflight --manifest ${manifestPath} --repo ${repoPath}`,
      `html-to-storyblok apply --manifest ${manifestPath} --repo ${repoPath} --template ${templatePath} --dry-run`,
      `html-to-storyblok wire-routes --manifest ${manifestPath} --repo ${repoPath} --dry-run`,
      `html-to-storyblok rollback-preview --manifest ${manifestPath} --repo ${repoPath}`,
      `html-to-storyblok report --work-dir ${workDir} --html`
    ]
  };
}

function filterValidationBySeverity(validation, requestedSeverity) {
  const severity = requestedSeverity === 'warning' || requestedSeverity === 'error' ? requestedSeverity : 'all';
  const annotated = (validation.violations || []).map((violation) => ({
    severity: validationSeverity(violation),
    ...violation
  }));
  const violations = severity === 'all' ? annotated : annotated.filter((violation) => violation.severity === severity);
  return {
    ...validation,
    severity_filter: severity,
    violation_counts: {
      error: annotated.filter((violation) => violation.severity === 'error').length,
      warning: annotated.filter((violation) => violation.severity === 'warning').length
    },
    violations
  };
}

function validationSeverity(violation) {
  const text = `${violation.operation || ''} ${violation.resource_type || ''} ${violation.reason || ''}`;
  if (/modify|authorisation|policy|unsafe|outside|unnamespaced|published|dependency|deployment|prefix|slug/i.test(text)) return 'error';
  return 'warning';
}

function renderShellCompletion(shell = 'zsh') {
  const commands = [
    'dashboard',
    'history',
    'demo-sites',
    'demo-sites-live-preview',
    'live-demo-sites',
    'settings',
    'env',
    'doctor',
    'view-report',
    'completion',
    'inspect-template',
    'template-readiness',
    'inspect-repository',
    'inspect-storyblok',
    'storyblok-audit',
    'inspect-storyblok-content',
    'inspect-netlify',
    'check-access',
    'netlify-preview',
    'readiness',
    'handoff',
    'plan',
    'infer-duplicates',
    'validate-plan',
    'storyblok-preflight',
    'validate-storyblok',
    'storyblok-reconcile',
    'storyblok-verify',
    'storyblok-activities',
    'sb-audit',
    'sb-reconcile',
    'sb-verify',
    'sb-activities',
    'sb-preflight',
    'sb-validate',
    'sb-apply',
    'examples',
    'diff',
    'repository-preflight',
    'validate',
    'build',
    'generate',
    'wire-routes',
    'route-handoff',
    'duplicate',
    'storyblok-component-groups',
    'storyblok-internal-tags',
    'storyblok-components',
    'storyblok-asset-folders',
    'upload-assets',
    'storyblok-presets',
    'create-draft-story',
    'storyblok-apply',
    'apply',
    'open-pr',
    'open-mr',
    'rollback-preview',
    'rollback',
    'report'
  ];
  const options = [
    '--manifest',
    '--repo',
    '--template',
    '--framework',
    '--route',
    '--site',
    '--routes',
    '--base-url',
    '--url',
    '--require-configured',
    '--require-storyblok-draft',
    '--require-storyblok',
    '--require-repository',
    '--integration-id',
    '--fixture',
    '--static-url',
    '--astro-url',
    '--next-url',
    '--nuxt-url',
    '--vue-url',
    '--react-url',
    '--work-dir',
    '--dry-run',
    '--remote',
    '--full',
    '--audit',
    '--since',
    '--limit',
    '--install',
    '--smoke',
    '--require-framework',
    '--generated',
    '--keep-generated',
    '--report-path',
    '--json-summary',
    '--html',
    '--search',
    '--severity',
    '--version',
    '--config',
    '--profile',
    '--for',
    '--set',
    '--init',
    '--print',
    '--path',
    '--force',
    '--no-interactive',
    '--help'
  ];
  if (shell === 'bash') {
    return `_html_to_storyblok() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${[...commands, ...options].join(' ')}" -- "$cur") )
}
complete -F _html_to_storyblok html-to-storyblok`;
  }
  if (shell === 'fish') {
    return [
      ...commands.map((command) => `complete -c html-to-storyblok -f -a ${command}`),
      ...options.map((option) => `complete -c html-to-storyblok -l ${option.replace(/^--/, '')}`)
    ].join('\n');
  }
  return `#compdef html-to-storyblok
_html_to_storyblok() {
  local -a commands
  commands=(${commands.map((command) => `${command}:${command}`).join(' ')})
  _describe 'command' commands
  _arguments '*: :(${[...commands, ...options].join(' ')})'
}
_html_to_storyblok "$@"`;
}

function printHelp() {
  console.log(`html-to-storyblok
${CLI_BRANDING_LINES.join('\n')}

Usage:
  html-to-storyblok
  html-to-storyblok dashboard
  html-to-storyblok history [--limit 20]
  html-to-storyblok demo-sites [--list] [--site astro,next] [--generated] [--install] [--smoke] [--require-framework] [--report-path <file>]
  html-to-storyblok demo-sites-live-preview [--list] [--site astro] [--base-url <url>] [--routes /,/about] [--integration-id <id>] [--require-storyblok-draft] [--require-configured]
  html-to-storyblok settings [--show] [--set key=value]
  html-to-storyblok env [--init] [--path .env.local] [--force] [--print]
  html-to-storyblok doctor [--for all|storyblok-only|full-import|netlify-preview|repo-only]
  html-to-storyblok view-report
  html-to-storyblok completion [--shell zsh|bash|fish]
  html-to-storyblok inspect-template --template <path>
  html-to-storyblok template-readiness --template <path>
  html-to-storyblok inspect-repository --repo <path>
  html-to-storyblok inspect-storyblok [--remote] [--full] [--audit]
  html-to-storyblok storyblok-audit [--full]
  html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
  html-to-storyblok inspect-netlify --repo <path>
  html-to-storyblok check-access
  html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify] [--wait] [--include-logs]
  html-to-storyblok readiness --manifest <path> [--repo <path>] [--template <path>] [--remote] [--require-storyblok] [--require-repository]
  html-to-storyblok plan --integration-id <id> [--storyblok-prefix <derived_prefix>] [--repository-namespace <path>] [--template <path>] [--schema-overrides <json>] [--repo <path>] [--infer-duplicates] [--framework auto|astro|react|next|vue|nuxt|static]
  html-to-storyblok infer-duplicates --manifest <path> --repo <path> [--storyblok-inspection <path>] [--write-manifest]
  html-to-storyblok validate-plan --manifest <path>
  html-to-storyblok validate-plan --manifest <path> [--severity all|error|warning]
  html-to-storyblok storyblok-preflight --manifest <path> [--dry-run]
  html-to-storyblok validate-storyblok --manifest <path> [--version draft|published] [--dry-run]
  html-to-storyblok storyblok-reconcile --manifest <path>
  html-to-storyblok storyblok-verify --manifest <path> [--dry-run]
  html-to-storyblok storyblok-activities [--manifest <path>] [--since <iso-date>] [--limit 50]
  html-to-storyblok examples --manifest <path> [--repo <path>] [--template <path>]
  html-to-storyblok diff --manifest <path> --repo <path>
  html-to-storyblok repository-preflight --manifest <path> --repo <path>
  html-to-storyblok validate --manifest <path> --repo <path>
  html-to-storyblok build --repo <path> [--script build] [--dry-run]
  html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok wire-routes --manifest <path> --repo <path> [--route home|about|/path] [--dry-run]
  html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
  html-to-storyblok storyblok-component-groups --manifest <path> [--dry-run]
  html-to-storyblok storyblok-internal-tags --manifest <path> [--dry-run]
  html-to-storyblok storyblok-components --manifest <path> [--dry-run]
  html-to-storyblok storyblok-asset-folders --manifest <path> [--dry-run]
  html-to-storyblok upload-assets --manifest <path> [--dry-run]
  html-to-storyblok storyblok-presets --manifest <path> [--dry-run]
  html-to-storyblok create-draft-story --manifest <path> [--dry-run]
  html-to-storyblok storyblok-apply --manifest <path> [--dry-run]
  html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--host-checks lint,typecheck,build] [--skip-host-checks] [--dry-run]
  html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
  html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
  html-to-storyblok rollback-preview --manifest <path> [--repo <path>]
  html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--remote --confirm-remote-delete] [--allow-modified-generated-files] [--dry-run]
  html-to-storyblok report [--view] [--html]

Mutating commands support --dry-run and always validate the manifest immediately before execution.
Use --no-interactive for scriptable non-interactive execution.
Use --json-summary for compact CI output.
Aliases: route-handoff, handoff, live-demo-sites. Storyblok aliases: sb-audit, sb-reconcile, sb-verify, sb-activities, sb-preflight, sb-validate, sb-apply.

All evidence and generated artifacts are written to .tmp/html-to-storyblok by default.
`);
}
