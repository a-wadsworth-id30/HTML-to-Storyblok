import { duplicateAll } from './duplicator.js';
import { writeArtifact } from './evidence.js';
import { generateIntegration } from './generator.js';
import { buildOperations, createIntegrationPlan } from './planner.js';
import { validatePlan } from './policy.js';
import { createDraftStories, createStoryblokAssetFolders, createStoryblokComponents, getStoryblokConfig, preflightStoryblokIntegration, uploadStoryblokAssets, validateStoryblokDraftContent } from './storyblok.js';
import { ensureArray, readJson, requireOption } from './utils.js';
import { validateIntegration } from './validator.js';
import { applyInferredDuplicationCandidates } from './duplication-inference.js';

export async function createPlanFromArgs(args, workDir) {
  const storyblokInspection = args.storyblok_inspection ? await readJson(String(args.storyblok_inspection)) : null;
  const schemaOverrides = args.schema_overrides ? await readJson(String(args.schema_overrides)) : null;
  const manifest = await createIntegrationPlan({
    integrationId: requireOption(args, 'integration_id'),
    storyblokPrefix: args.storyblok_prefix ? String(args.storyblok_prefix) : undefined,
    repositoryNamespace: args.repository_namespace ? String(args.repository_namespace) : undefined,
    templatePath: args.template ? String(args.template) : undefined,
    framework: args.framework ? String(args.framework) : 'static',
    repoPath: args.repo ? String(args.repo) : undefined,
    inferDuplicates: Boolean(args.infer_duplicates),
    storyblokInspection,
    schemaOverrides,
    schemaOverridesPath: args.schema_overrides ? String(args.schema_overrides) : null
  });
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, 'plan-validation.json', validation);
  manifest.validation = validation;
  return manifest;
}

export async function inferDuplicatesForManifest(manifest, {
  repoPath = process.cwd(),
  storyblokInspection = null
} = {}) {
  const inference = await applyInferredDuplicationCandidates(manifest, {
    repoPath,
    storyblokInspection
  });
  manifest.operations = buildOperations(manifest);
  manifest.validation = validatePlan(manifest);
  return { manifest, inference };
}

export async function readAndValidateManifest(args, workDir) {
  const manifest = await readJson(requireOption(args, 'manifest'));
  const validation = validatePlan(manifest);
  await writeArtifact(workDir, 'plan-validation.json', validation);
  if (!validation.valid) {
    const reasons = validation.violations.map((violation) => `${violation.resource}: ${violation.reason}`).join('; ');
    throw new Error(`manifest failed additive-only validation: ${reasons}`);
  }
  return manifest;
}

export async function applyManifest(manifest, args = {}, workDir, { onProgress = null } = {}) {
  const dryRun = Boolean(args.dry_run);
  const repoPath = args.repo ? String(args.repo) : process.cwd();
  const env = args.env || process.env;
  const steps = [];
  const progress = typeof onProgress === 'function' ? onProgress : async () => {};
  assertApplyPreflight(manifest, { dryRun, env });

  await progress({ label: 'Checking Storyblok Access', current: 0, total: 9 });
  const storyblokPreflight = await preflightStoryblokIntegration(manifest, { dryRun, env });
  await writeArtifact(workDir, 'apply-step-00-storyblok-preflight.json', storyblokPreflight);
  assertStoryblokPreflightPassed(storyblokPreflight);
  await progress({ label: 'Creating Frontend', current: 1, total: 9 });
  await recordApplyStep(workDir, steps, 'apply-step-01-duplicate.json', await duplicateAll(manifest, { repoPath, dryRun, env }));
  await progress({ label: 'Creating Frontend', current: 2, total: 9 });
  await recordApplyStep(workDir, steps, 'apply-step-02-generate.json', await generateIntegration(manifest, {
    repoPath,
    templatePath: args.template ? String(args.template) : undefined,
    framework: args.framework ? String(args.framework) : 'auto',
    dryRun
  }));
  await progress({ label: 'Validating Local Output', current: 3, total: 9 });
  const localValidation = dryRun
    ? { action: 'validate_integration', status: 'skipped', reason: 'dry-run does not write generated files' }
    : await validateIntegration(manifest, { repoPath });
  await recordApplyStep(workDir, steps, 'apply-step-03-local-validation.json', {
    action: 'local_validation',
    results: localValidation
  });
  if (localValidation.status === 'failed') {
    throw new Error('local validation failed after generation; refusing remote Storyblok mutations');
  }
  await progress({ label: 'Creating Storyblok Components', current: 4, total: 9 });
  await recordApplyStep(workDir, steps, 'apply-step-04-storyblok-components.json', {
    action: 'storyblok_components',
    results: await createStoryblokComponents(manifest, { dryRun, env })
  });
  await progress({ label: 'Creating Storyblok Asset Folders', current: 5, total: 9 });
  await recordApplyStep(workDir, steps, 'apply-step-05-storyblok-asset-folders.json', {
    action: 'storyblok_asset_folders',
    results: await createStoryblokAssetFolders(manifest, { dryRun, env })
  });
  await progress({ label: 'Uploading Assets', current: 6, total: 9 });
  const storyblokAssetsStep = {
    action: 'storyblok_assets',
    results: await uploadStoryblokAssets(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'apply-step-06-storyblok-assets.json', storyblokAssetsStep);
  await progress({ label: 'Creating Draft Stories', current: 7, total: 9 });
  await recordApplyStep(workDir, steps, 'apply-step-07-storyblok-draft-stories.json', {
    action: 'storyblok_draft_stories',
    results: await createDraftStories(manifest, { dryRun, env, assetResults: storyblokAssetsStep.results })
  });
  await progress({ label: 'Validating Storyblok Content', current: 8, total: 9 });
  const storyblokContentValidation = await validateStoryblokDraftContent(manifest, { dryRun, env });
  await recordApplyStep(workDir, steps, 'apply-step-08-storyblok-content-validation.json', storyblokContentValidation);
  assertStoryblokContentValidationPassed(storyblokContentValidation);
  await progress({ label: 'Done', current: 9, total: 9 });
  const result = {
    action: 'apply_manifest',
    dry_run: dryRun,
    steps
  };
  await writeArtifact(workDir, 'apply-result.json', result);
  return result;
}

export async function applyStoryblokOnly(manifest, args = {}, workDir, { onProgress = null } = {}) {
  const dryRun = Boolean(args.dry_run);
  const env = args.env || process.env;
  const steps = [];
  const progress = typeof onProgress === 'function' ? onProgress : async () => {};
  assertApplyPreflight(manifest, { dryRun, env });

  await progress({ label: 'Checking Storyblok Access', current: 0, total: 6 });
  const storyblokPreflight = await preflightStoryblokIntegration(manifest, { dryRun, env });
  await writeArtifact(workDir, 'storyblok-apply-step-00-preflight.json', storyblokPreflight);
  assertStoryblokPreflightPassed(storyblokPreflight);
  await progress({ label: 'Creating Storyblok Components', current: 1, total: 6 });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-01-components.json', {
    action: 'storyblok_components',
    results: await createStoryblokComponents(manifest, { dryRun, env })
  });
  await progress({ label: 'Creating Storyblok Asset Folders', current: 2, total: 6 });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-02-asset-folders.json', {
    action: 'storyblok_asset_folders',
    results: await createStoryblokAssetFolders(manifest, { dryRun, env })
  });
  await progress({ label: 'Uploading Assets', current: 3, total: 6 });
  const storyblokAssetsStep = {
    action: 'storyblok_assets',
    results: await uploadStoryblokAssets(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-03-assets.json', storyblokAssetsStep);
  await progress({ label: 'Creating Draft Stories', current: 4, total: 6 });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-04-draft-stories.json', {
    action: 'storyblok_draft_stories',
    results: await createDraftStories(manifest, { dryRun, env, assetResults: storyblokAssetsStep.results })
  });
  await progress({ label: 'Validating Storyblok Content', current: 5, total: 6 });
  const storyblokContentValidation = await validateStoryblokDraftContent(manifest, { dryRun, env });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-05-content-validation.json', storyblokContentValidation);
  assertStoryblokContentValidationPassed(storyblokContentValidation);
  await progress({ label: 'Done', current: 6, total: 6 });
  const result = {
    action: 'apply_storyblok_only',
    dry_run: dryRun,
    repository_skipped: true,
    steps
  };
  await writeArtifact(workDir, 'storyblok-apply-result.json', result);
  return result;
}

async function recordApplyStep(workDir, steps, artifactName, step) {
  steps.push(step);
  await writeArtifact(workDir, artifactName, step);
  return step;
}

function assertApplyPreflight(manifest, { dryRun, env }) {
  if (dryRun || plannedStoryblokOperationCount(manifest) === 0) return;
  const config = getStoryblokConfig(env);
  if (!config.available) {
    throw new Error('Storyblok credentials unavailable; refusing to apply before local files are written. Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID, or rerun with --dry-run.');
  }
}

function assertStoryblokPreflightPassed(preflight) {
  if (preflight.status === 'failed') {
    const failed = ensureArray(preflight.checks)
      .filter((check) => check.required !== false && check.status !== 'passed')
      .map((check) => check.name)
      .join(', ');
    throw new Error(`Storyblok preflight failed${failed ? `: ${failed}` : ''}`);
  }
}

function assertStoryblokContentValidationPassed(validation) {
  if (validation.status === 'failed') {
    throw new Error('Storyblok Content API validation failed after apply; remote resources remain unpublished drafts for review or rollback.');
  }
}

function plannedStoryblokOperationCount(manifest) {
  return ensureArray(manifest.storyblok?.components_to_create).length +
    ensureArray(manifest.storyblok?.components_to_duplicate).length +
    ensureArray(manifest.storyblok?.asset_folders_to_create).length +
    ensureArray(manifest.storyblok?.assets_to_create).length +
    ensureArray(manifest.storyblok?.stories_to_create).length;
}
