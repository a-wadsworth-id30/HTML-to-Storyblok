import { checkLiveAccess } from './access.js';
import { duplicateAll } from './duplicator.js';
import { ensureWorkDir, recordEvidence, writeArtifact, DEFAULT_WORK_DIR } from './evidence.js';
import { generateIntegration } from './generator.js';
import { openDraftPullRequest } from './github.js';
import { openDraftMergeRequest } from './gitlab.js';
import { runDashboard, runDoctorCommand, runInteractiveApp, runReportViewer, runSettings } from './interactive.js';
import { inspectNetlify, inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { queryNetlifyDeployPreviews, verifyNetlifyDeployPreview } from './netlify.js';
import { validatePlan } from './policy.js';
import { createReport } from './reporter.js';
import { createRollbackPreview, rollbackIntegration } from './rollback.js';
import { createDraftStories, createStoryblokAssetFolders, createStoryblokComponents, inspectStoryblokContentStory, inspectStoryblokSpace, uploadStoryblokAssets } from './storyblok.js';
import { commandName, parseArgs, readJson, requireOption, writeJson } from './utils.js';
import { diffIntegration, runRepositoryScript, validateIntegration } from './validator.js';
import { applyManifest, createPlanFromArgs, inferDuplicatesForManifest, readAndValidateManifest } from './workflow.js';

const MUTATING_COMMANDS = new Set([
  'apply',
  'create-draft-story',
  'duplicate',
  'generate',
  'infer-duplicates',
  'open-mr',
  'open-pr',
  'rollback',
  'storyblok-asset-folders',
  'storyblok-components',
  'upload-assets'
]);

export async function main(argv) {
  const command = commandName(argv);
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
    } else if (command === 'inspect-template') {
      result = await inspectTemplate(requireOption(args, 'template'));
      await writeArtifact(workDir, 'template-inventory.json', result);
    } else if (command === 'inspect-repository') {
      result = await inspectRepository(requireOption(args, 'repo'));
      await writeArtifact(workDir, 'repository-inspection.json', result);
    } else if (command === 'inspect-netlify') {
      result = await inspectNetlify(requireOption(args, 'repo'));
      await writeArtifact(workDir, 'netlify-inspection.json', result);
    } else if (command === 'inspect-storyblok') {
      result = args.remote ? await inspectStoryblokSpace() : inspectStoryblokEnvironment();
      await writeArtifact(workDir, 'storyblok-access.json', result);
    } else if (command === 'inspect-storyblok-content') {
      result = await inspectStoryblokContentStory({
        slug: requireOption(args, 'slug'),
        version: args.version ? String(args.version) : 'draft'
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
          intervalMs: args.interval_ms ? Number(args.interval_ms) : undefined
        })
        : await queryNetlifyDeployPreviews({
          siteId: args.site_id ? String(args.site_id) : undefined,
          branch: args.branch ? String(args.branch) : undefined,
          deployId: args.deploy_id ? String(args.deploy_id) : undefined
        });
      await writeArtifact(workDir, 'netlify-preview.json', result);
      if (result.status === 'failed') process.exitCode = 2;
    } else if (command === 'check-access') {
      result = checkLiveAccess();
      await writeArtifact(workDir, 'access-readiness.json', result);
    } else if (command === 'plan') {
      result = await createPlanFromArgs(args, workDir);
      await writeArtifact(workDir, 'integration-manifest.json', result);
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
      await writeArtifact(workDir, 'plan-validation.json', result);
      if (!result.valid) process.exitCode = 2;
    } else if (command === 'diff') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await diffIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd()
      });
      await writeArtifact(workDir, 'diff-result.json', result);
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
      }
    } else if (command === 'storyblok-components') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokComponents(manifest, { dryRun: Boolean(args.dry_run) });
      await writeArtifact(workDir, 'storyblok-components-result.json', result);
    } else if (command === 'storyblok-asset-folders') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createStoryblokAssetFolders(manifest, { dryRun: Boolean(args.dry_run) });
      await writeArtifact(workDir, 'storyblok-asset-folders-result.json', result);
    } else if (command === 'upload-assets') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await uploadStoryblokAssets(manifest, { dryRun: Boolean(args.dry_run) });
      await writeArtifact(workDir, 'storyblok-assets-result.json', result);
    } else if (command === 'create-draft-story') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await createDraftStories(manifest, { dryRun: Boolean(args.dry_run) });
      await writeArtifact(workDir, 'storyblok-draft-stories-result.json', result);
    } else if (command === 'generate') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await generateIntegration(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        templatePath: args.template ? String(args.template) : undefined,
        framework: args.framework ? String(args.framework) : 'auto',
        dryRun: Boolean(args.dry_run)
      });
      await writeArtifact(workDir, 'generate-result.json', result);
    } else if (command === 'duplicate') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await duplicateAll(manifest, {
        repoPath: args.repo ? String(args.repo) : process.cwd(),
        dryRun: Boolean(args.dry_run)
      });
      await writeArtifact(workDir, 'duplication-result.json', result);
    } else if (command === 'apply') {
      const manifest = await readAndValidateManifest(args, workDir);
      result = await applyManifest(manifest, args, workDir);
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
        dryRun: Boolean(args.dry_run)
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
        dryRun: Boolean(args.dry_run)
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
        confirmRemoteDelete: Boolean(args.confirm_remote_delete)
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
      message: redactMessage(error.message || String(error))
    });
    throw error;
  }

  await recordEvidence(workDir, {
    type: 'command_completed',
    command,
    exit_code: process.exitCode || 0
  });
  if (printJson) console.log(JSON.stringify(result, null, 2));
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

function printHelp() {
  console.log(`html-to-storyblok

Usage:
  html-to-storyblok
  html-to-storyblok dashboard
  html-to-storyblok settings [--show] [--set key=value]
  html-to-storyblok doctor
  html-to-storyblok view-report
  html-to-storyblok inspect-template --template <path>
  html-to-storyblok inspect-repository --repo <path>
  html-to-storyblok inspect-storyblok
  html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
  html-to-storyblok inspect-netlify --repo <path>
  html-to-storyblok check-access
  html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify] [--wait]
  html-to-storyblok plan --integration-id <id> [--storyblok-prefix <derived_prefix>] [--repository-namespace <path>] [--infer-duplicates --repo <path>]
  html-to-storyblok infer-duplicates --manifest <path> --repo <path> [--storyblok-inspection <path>] [--write-manifest]
  html-to-storyblok validate-plan --manifest <path>
  html-to-storyblok diff --manifest <path> --repo <path>
  html-to-storyblok validate --manifest <path> --repo <path>
  html-to-storyblok build --repo <path> [--script build] [--dry-run]
  html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
  html-to-storyblok storyblok-components --manifest <path> [--dry-run]
  html-to-storyblok storyblok-asset-folders --manifest <path> [--dry-run]
  html-to-storyblok upload-assets --manifest <path> [--dry-run]
  html-to-storyblok create-draft-story --manifest <path> [--dry-run]
  html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
  html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
  html-to-storyblok rollback-preview --manifest <path> [--repo <path>]
  html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--remote --confirm-remote-delete] [--dry-run]
  html-to-storyblok report [--view]

Mutating commands support --dry-run and always validate the manifest immediately before execution.
Use --no-interactive for scriptable non-interactive execution.

All evidence and generated artifacts are written to .tmp/html-to-storyblok by default.
`);
}
