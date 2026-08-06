import { checkLiveAccess } from './access.js';
import { duplicateAll } from './duplicator.js';
import { ensureWorkDir, readEvidence, recordEvidence, writeArtifact, DEFAULT_WORK_DIR } from './evidence.js';
import { generateIntegration } from './generator.js';
import { openDraftPullRequest } from './github.js';
import { openDraftMergeRequest } from './gitlab.js';
import { inspectNetlify, inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { queryNetlifyDeployPreviews } from './netlify.js';
import { createIntegrationPlan } from './planner.js';
import { validatePlan } from './policy.js';
import { createDraftStories, createStoryblokComponents, inspectStoryblokSpace, uploadStoryblokAssets } from './storyblok.js';
import { commandName, parseArgs, readJson, requireOption } from './utils.js';

const MUTATING_COMMANDS = new Set([
  'apply',
  'create-draft-story',
  'duplicate',
  'generate',
  'open-mr',
  'open-pr',
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
  } else if (command === 'netlify-preview') {
    result = await queryNetlifyDeployPreviews({
      siteId: args.site_id ? String(args.site_id) : undefined,
      branch: args.branch ? String(args.branch) : undefined,
      deployId: args.deploy_id ? String(args.deploy_id) : undefined
    });
    await writeArtifact(workDir, 'netlify-preview.json', result);
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
    result = {
      status: 'not_implemented',
      note: 'Diff generation will compare the manifest against repository and Storyblok snapshots in a later implementation.'
    };
  } else if (command === 'build') {
    result = {
      status: 'manual',
      note: 'Run the selected repository build command directly; this CLI does not shell out yet.'
    };
  } else if (command === 'validate') {
    result = {
      status: 'manual',
      note: 'Full validation requires a generated integration and target repository commands.'
    };
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
    result = createRollbackPreview(manifest);
    await writeArtifact(workDir, 'rollback-preview.json', result);
  } else {
    throw new Error(`unknown command: ${command}`);
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
  return {
    work_dir: workDir,
    evidence_entries: evidence.length,
    commands: evidence.filter((entry) => entry.type === 'command_completed').map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      timestamp: entry.timestamp
    })),
    artifacts: evidence.filter((entry) => entry.type === 'artifact_written').map((entry) => entry.artifact)
  };
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

function createRollbackPreview(manifest) {
  return {
    action: 'rollback_preview',
    dry_run: true,
    policy: 'manual_approval_required',
    repository_files_to_remove: manifest.repository?.files_to_create || [],
    storyblok_components_to_remove: [
      ...(manifest.storyblok?.components_to_create || []),
      ...(manifest.storyblok?.components_to_duplicate || [])
    ].map((component) => component.technical_name || component.name || component),
    storyblok_stories_to_remove: (manifest.storyblok?.stories_to_create || []).map((story) => story.slug || story.full_slug),
    storyblok_assets_to_remove: (manifest.storyblok?.assets_to_create || []).map((asset) => asset.id || asset.filename || asset.local_path),
    note: 'Preview only. Rollback must verify ownership and external references before deletion.'
  };
}

function redactArgs(args) {
  const redacted = {};
  for (const [key, value] of Object.entries(args)) {
    redacted[key] = /token|secret|password|key/i.test(key) ? '[REDACTED]' : value;
  }
  return redacted;
}

function printHelp() {
  console.log(`html-to-storyblok

Usage:
  html-to-storyblok inspect-template --template <path>
  html-to-storyblok inspect-repository --repo <path>
  html-to-storyblok inspect-storyblok
  html-to-storyblok inspect-netlify --repo <path>
  html-to-storyblok check-access
  html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>]
  html-to-storyblok plan --integration-id <id> --storyblok-prefix <prefix_> [--repository-namespace <path>]
  html-to-storyblok validate-plan --manifest <path>
  html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
  html-to-storyblok storyblok-components --manifest <path> [--dry-run]
  html-to-storyblok upload-assets --manifest <path> [--dry-run]
  html-to-storyblok create-draft-story --manifest <path> [--dry-run]
  html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
  html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--dry-run]
  html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--dry-run]
  html-to-storyblok rollback-preview --manifest <path>
  html-to-storyblok report

Mutating commands support --dry-run and always validate the manifest immediately before execution.

All evidence and generated artifacts are written to .tmp/html-to-storyblok by default.
`);
}
