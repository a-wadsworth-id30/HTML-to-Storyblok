import { checkLiveAccess } from './access.js';
import { duplicateAll } from './duplicator.js';
import { ensureWorkDir, readEvidence, recordEvidence, writeArtifact, DEFAULT_WORK_DIR } from './evidence.js';
import { generateIntegration } from './generator.js';
import { openDraftPullRequest } from './github.js';
import { openDraftMergeRequest } from './gitlab.js';
import { inspectNetlify, inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { queryNetlifyDeployPreviews, verifyNetlifyDeployPreview } from './netlify.js';
import { createIntegrationPlan } from './planner.js';
import { validatePlan } from './policy.js';
import { createRollbackPreview, rollbackIntegration } from './rollback.js';
import { createDraftStories, createStoryblokComponents, inspectStoryblokContentStory, inspectStoryblokSpace, uploadStoryblokAssets } from './storyblok.js';
import { commandName, parseArgs, readJson, requireOption } from './utils.js';
import { diffIntegration, runRepositoryScript, validateIntegration } from './validator.js';

const MUTATING_COMMANDS = new Set([
  'apply',
  'create-draft-story',
  'duplicate',
  'generate',
  'open-mr',
  'open-pr',
  'rollback',
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

  await recordEvidence(workDir, {
    type: 'command_started',
    command,
    args: redactArgs(args)
  });

  let result;
  try {
  if (command === 'inspect-template') {
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
        expectedContext: args.expected_context ? String(args.expected_context) : 'deploy-preview'
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
    result = await createPlan(args, workDir);
    await writeArtifact(workDir, 'integration-manifest.json', result);
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
    result = await createReport(workDir);
  } else if (command === 'storyblok-components') {
    const manifest = await readAndValidateManifest(args, workDir);
    result = await createStoryblokComponents(manifest, { dryRun: Boolean(args.dry_run) });
    await writeArtifact(workDir, 'storyblok-components-result.json', result);
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
    result = await openDraftPullRequest({
      repoPath: args.repo ? String(args.repo) : process.cwd(),
      owner: args.owner ? String(args.owner) : undefined,
      repo: args.github_repo ? String(args.github_repo) : undefined,
      title: args.title ? String(args.title) : undefined,
      body: args.body ? String(args.body) : undefined,
      head: args.head ? String(args.head) : undefined,
      base: args.base ? String(args.base) : 'main',
      dryRun: Boolean(args.dry_run)
    });
    await writeArtifact(workDir, 'github-pr-result.json', result);
  } else if (command === 'open-mr') {
    result = await openDraftMergeRequest({
      repoPath: args.repo ? String(args.repo) : process.cwd(),
      project: args.project ? String(args.project) : undefined,
      title: args.title ? String(args.title) : undefined,
      body: args.body ? String(args.body) : undefined,
      sourceBranch: args.source_branch ? String(args.source_branch) : args.head ? String(args.head) : undefined,
      targetBranch: args.target_branch ? String(args.target_branch) : args.base ? String(args.base) : 'main',
      removeSourceBranch: Boolean(args.remove_source_branch),
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
      confirmIntegrationId: args.confirm_integration_id ? String(args.confirm_integration_id) : undefined
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
  console.log(JSON.stringify(result, null, 2));
}

async function createPlan(args, workDir) {
  const manifest = await createIntegrationPlan({
    integrationId: requireOption(args, 'integration_id'),
    storyblokPrefix: requireOption(args, 'storyblok_prefix'),
    repositoryNamespace: args.repository_namespace ? String(args.repository_namespace) : undefined,
    templatePath: args.template ? String(args.template) : undefined,
    framework: args.framework ? String(args.framework) : 'static'
  });
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, 'plan-validation.json', validation);
  manifest.validation = validation;
  return manifest;
}

async function createReport(workDir) {
  const evidence = await readEvidence(workDir);
  const artifacts = evidence.filter((entry) => entry.type === 'artifact_written').map((entry) => entry.artifact);
  const artifactSummaries = [];
  for (const artifact of artifacts) {
    artifactSummaries.push(await summarizeArtifact(artifact));
  }
  const completed = evidence.filter((entry) => entry.type === 'command_completed');
  const failed = evidence.filter((entry) => entry.type === 'command_failed');
  const latestValidation = latestSummary(artifactSummaries, ['plan_validation', 'integration_validation']);
  const latestNetlify = latestSummary(artifactSummaries, ['netlify_preview']);
  return {
    work_dir: workDir,
    evidence_entries: evidence.length,
    commands_started: evidence.filter((entry) => entry.type === 'command_started').length,
    commands_completed: completed.length,
    commands_failed: failed.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      message: entry.message,
      timestamp: entry.timestamp
    })),
    commands: completed.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      timestamp: entry.timestamp
    })),
    artifacts: artifactSummaries,
    latest_validation: latestValidation,
    latest_netlify: latestNetlify,
    safety_confirmation: {
      plan_valid: latestValidation?.status === 'passed' || latestValidation?.valid === true,
      deploy_preview_verified: latestNetlify?.status === 'passed',
      command_argument_redaction: 'token-like argument keys are redacted in evidence',
      unresolved_failures: failed.length
    }
  };
}

async function summarizeArtifact(artifact) {
  const name = artifact.split('/').at(-1);
  try {
    const data = await readJson(artifact);
    if (name === 'integration-manifest.json') {
      return {
        type: 'integration_manifest',
        artifact,
        integration_id: data.integration_id,
        repository_files: data.repository?.files_to_create?.length || 0,
        storyblok_components: data.storyblok?.components_to_create?.length || 0,
        storyblok_stories: data.storyblok?.stories_to_create?.length || 0,
        storyblok_assets: data.storyblok?.assets_to_create?.length || 0
      };
    }
    if (name === 'plan-validation.json') {
      return {
        type: 'plan_validation',
        artifact,
        valid: data.valid,
        status: data.valid ? 'passed' : 'failed',
        violations: data.violations?.length || 0
      };
    }
    if (name === 'validation-result.json') {
      return {
        type: 'integration_validation',
        artifact,
        status: data.status,
        failed_checks: data.failed_checks || 0
      };
    }
    if (name === 'netlify-preview.json') {
      return {
        type: 'netlify_preview',
        artifact,
        status: data.status,
        deploy_url: data.deploy?.deploy_url || data.deploys?.[0]?.deploy_url || null,
        failed_checks: data.failed_checks || 0
      };
    }
    if (name === 'github-pr-result.json') {
      return {
        type: 'github_pull_request',
        artifact,
        dry_run: Boolean(data.dry_run),
        url: data.url || null,
        number: data.number || null,
        status: data.status || null
      };
    }
    if (name === 'gitlab-mr-result.json') {
      return {
        type: 'gitlab_merge_request',
        artifact,
        dry_run: Boolean(data.dry_run),
        url: data.url || data.web_url || null,
        iid: data.iid || null,
        status: data.status || null
      };
    }
    return {
      type: name.replace(/\.json$/, '').replaceAll('-', '_'),
      artifact,
      status: data.status || data.action || 'recorded'
    };
  } catch {
    return {
      type: 'unreadable_artifact',
      artifact,
      status: 'unreadable'
    };
  }
}

async function readAndValidateManifest(args, workDir) {
  const manifest = await readJson(requireOption(args, 'manifest'));
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, 'plan-validation.json', validation);
  if (!validation.valid) {
    const reasons = validation.violations.map((violation) => `${violation.resource}: ${violation.reason}`).join('; ');
    throw new Error(`manifest failed additive-only validation: ${reasons}`);
  }
  return manifest;
}

async function applyManifest(manifest, args, workDir) {
  const dryRun = Boolean(args.dry_run);
  const repoPath = args.repo ? String(args.repo) : process.cwd();
  const steps = [];
  steps.push(await duplicateAll(manifest, { repoPath, dryRun }));
  steps.push(await generateIntegration(manifest, {
    repoPath,
    templatePath: args.template ? String(args.template) : undefined,
    framework: args.framework ? String(args.framework) : 'auto',
    dryRun
  }));
  steps.push({
    action: 'storyblok_components',
    results: await createStoryblokComponents(manifest, { dryRun })
  });
  steps.push({
    action: 'storyblok_assets',
    results: await uploadStoryblokAssets(manifest, { dryRun })
  });
  steps.push({
    action: 'storyblok_draft_stories',
    results: await createDraftStories(manifest, { dryRun })
  });
  const result = {
    action: 'apply_manifest',
    dry_run: dryRun,
    steps
  };
  await writeArtifact(workDir, 'apply-result.json', result);
  return result;
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

function latestSummary(summaries, types) {
  return [...summaries].reverse().find((summary) => types.includes(summary.type)) || null;
}

function printHelp() {
  console.log(`html-to-storyblok

Usage:
  html-to-storyblok inspect-template --template <path>
  html-to-storyblok inspect-repository --repo <path>
  html-to-storyblok inspect-storyblok
  html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
  html-to-storyblok inspect-netlify --repo <path>
  html-to-storyblok check-access
  html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify]
  html-to-storyblok plan --integration-id <id> --storyblok-prefix <prefix_> [--repository-namespace <path>]
  html-to-storyblok validate-plan --manifest <path>
  html-to-storyblok diff --manifest <path> --repo <path>
  html-to-storyblok validate --manifest <path> --repo <path>
  html-to-storyblok build --repo <path> [--script build] [--dry-run]
  html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
  html-to-storyblok storyblok-components --manifest <path> [--dry-run]
  html-to-storyblok upload-assets --manifest <path> [--dry-run]
  html-to-storyblok create-draft-story --manifest <path> [--dry-run]
  html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--dry-run]
  html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--dry-run]
  html-to-storyblok rollback-preview --manifest <path> [--repo <path>]
  html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--dry-run]
  html-to-storyblok report

Mutating commands support --dry-run and always validate the manifest immediately before execution.

All evidence and generated artifacts are written to .tmp/html-to-storyblok by default.
`);
}
