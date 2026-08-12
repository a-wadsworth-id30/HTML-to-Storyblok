import { createClientApplyReviewGate } from './client-review-gate.js';
import { duplicateAll } from './duplicator.js';
import { writeArtifact } from './evidence.js';
import { generateIntegration } from './generator.js';
import { buildOperations, createIntegrationPlan } from './planner.js';
import { validatePlan } from './policy.js';
import { collectStoryblokActivityEvidence, createDraftStories, createStoryblokAssetFolders, createStoryblokComponentGroups, createStoryblokComponents, createStoryblokInternalTags, createStoryblokPresets, createStoryblokStateCache, duplicateStoryblokComponents, getStoryblokConfig, preflightStoryblokIntegration, uploadStoryblokAssets, validateStoryblokDraftContent, verifyStoryblokManagementState } from './storyblok.js';
import { ensureArray, readJson, requireOption } from './utils.js';
import { preflightRepositoryIntegration, runRepositoryScript, validateIntegration } from './validator.js';
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
  const startedAt = new Date().toISOString();
  const storyblokDetail = storyblokProgressDetail(env);
  const storyblokStateCache = createStoryblokStateCache();
  const totalSteps = 16;
  assertApplyPreflight(manifest, { dryRun, env });

  await progress({ label: 'Checking Repository Safety', current: 0, total: totalSteps });
  const repositoryPreflight = await preflightRepositoryIntegration(manifest, { repoPath, mode: dryRun ? 'dry-run' : 'apply' });
  await writeArtifact(workDir, 'apply-step-00-repository-preflight.json', repositoryPreflight);
  const clientReviewGate = await createClientApplyReviewGate(manifest, {
    repoPath,
    mode: dryRun ? 'dry-run' : 'apply',
    repositoryPreflight,
    hostChecks: hostCheckScripts(args),
    skipHostChecks: Boolean(args.skip_host_checks)
  });
  await writeArtifact(workDir, 'apply-step-00-client-review-gate.json', clientReviewGate);
  assertRepositoryPreflightPassed(repositoryPreflight);
  assertClientReviewGatePassed(clientReviewGate);
  await progress({ label: 'Checking Storyblok Access', current: 0, total: totalSteps, detail: storyblokDetail });
  const storyblokPreflight = await preflightStoryblokIntegration(manifest, { dryRun, env });
  await writeArtifact(workDir, 'apply-step-00-storyblok-preflight.json', storyblokPreflight);
  assertStoryblokPreflightPassed(storyblokPreflight);
  await progress({ label: 'Checking Host Baseline', current: 1, total: totalSteps });
  const baselineHostChecks = await runHostChecks(manifest, { repoPath, dryRun, args, phase: 'baseline' });
  await recordApplyStep(workDir, steps, 'apply-step-01-baseline-host-checks.json', baselineHostChecks);
  assertHostChecksPassed(baselineHostChecks);
  await progress({ label: 'Creating Frontend', current: 2, total: totalSteps });
  await recordApplyStep(workDir, steps, 'apply-step-02-duplicate.json', await duplicateAll(manifest, { repoPath, dryRun, env }));
  await progress({ label: 'Creating Frontend', current: 3, total: totalSteps });
  await recordApplyStep(workDir, steps, 'apply-step-03-generate.json', await generateIntegration(manifest, {
    repoPath,
    templatePath: args.template ? String(args.template) : undefined,
    framework: args.framework ? String(args.framework) : 'auto',
    dryRun
  }));
  await progress({ label: 'Validating Local Output', current: 4, total: totalSteps });
  const localValidation = dryRun
    ? { action: 'validate_integration', status: 'skipped', reason: 'dry-run does not write generated files' }
    : await validateIntegration(manifest, { repoPath });
  await recordApplyStep(workDir, steps, 'apply-step-04-local-validation.json', {
    action: 'local_validation',
    results: localValidation
  });
  if (localValidation.status === 'failed') {
    throw new Error('local validation failed after generation; refusing remote Storyblok mutations');
  }
  await progress({ label: 'Running Host Checks', current: 5, total: totalSteps });
  const hostChecks = await runHostChecks(manifest, { repoPath, dryRun, args, phase: 'post-generation' });
  await recordApplyStep(workDir, steps, 'apply-step-05-host-checks.json', hostChecks);
  assertHostChecksPassed(hostChecks);
  await progress({ label: 'Creating Storyblok Component Folders', current: 6, total: totalSteps, detail: storyblokDetail });
  const componentGroupsStep = {
    action: 'storyblok_component_groups',
    results: await createStoryblokComponentGroups(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'apply-step-06-storyblok-component-groups.json', componentGroupsStep);
  await progress({ label: 'Creating Storyblok Internal Tags', current: 7, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'apply-step-07-storyblok-internal-tags.json', {
    action: 'storyblok_internal_tags',
    results: await createStoryblokInternalTags(manifest, { dryRun, env })
  });
  await progress({ label: 'Creating Storyblok Components', current: 8, total: totalSteps, detail: storyblokDetail });
  const storyblokComponentsStep = {
    action: 'storyblok_components',
    results: await createStoryblokComponents(manifest, { dryRun, env, componentGroupResults: componentGroupsStep.results })
  };
  await recordApplyStep(workDir, steps, 'apply-step-08-storyblok-components.json', storyblokComponentsStep);
  await progress({ label: 'Creating Storyblok Asset Folders', current: 9, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'apply-step-09-storyblok-asset-folders.json', {
    action: 'storyblok_asset_folders',
    results: await createStoryblokAssetFolders(manifest, { dryRun, env })
  });
  await progress({ label: 'Uploading Assets', current: 10, total: totalSteps, detail: storyblokDetail });
  const storyblokAssetsStep = {
    action: 'storyblok_assets',
    results: await uploadStoryblokAssets(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'apply-step-10-storyblok-assets.json', storyblokAssetsStep);
  await progress({ label: 'Creating Storyblok Presets', current: 11, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'apply-step-11-storyblok-presets.json', {
    action: 'storyblok_presets',
    results: await createStoryblokPresets(manifest, {
      dryRun,
      env,
      componentResults: storyblokComponentsStep.results,
      assetResults: storyblokAssetsStep.results
    })
  });
  await progress({ label: 'Creating Draft Stories', current: 12, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'apply-step-12-storyblok-draft-stories.json', {
    action: 'storyblok_draft_stories',
    results: await createDraftStories(manifest, { dryRun, env, assetResults: storyblokAssetsStep.results })
  });
  await progress({ label: 'Validating Storyblok Content', current: 13, total: totalSteps, detail: storyblokDetail });
  const storyblokContentValidation = await validateStoryblokDraftContent(manifest, { dryRun, env });
  await recordApplyStep(workDir, steps, 'apply-step-13-storyblok-content-validation.json', storyblokContentValidation);
  assertStoryblokContentValidationPassed(storyblokContentValidation);
  await progress({ label: 'Verifying Storyblok Management State', current: 14, total: totalSteps, detail: storyblokDetail });
  const storyblokManagementVerification = await verifyStoryblokManagementState(manifest, {
    dryRun,
    env,
    stateCache: storyblokStateCache,
    refreshRemoteState: true
  });
  await recordApplyStep(workDir, steps, 'apply-step-14-storyblok-management-verification.json', storyblokManagementVerification);
  assertStoryblokManagementVerificationPassed(storyblokManagementVerification);
  await progress({ label: 'Recording Storyblok Activity Evidence', current: 15, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'apply-step-15-storyblok-activity-evidence.json', await collectStoryblokActivityEvidence(manifest, {
    dryRun,
    env,
    since: startedAt
  }));
  await progress({ label: 'Done', current: 16, total: totalSteps });
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
  const startedAt = new Date().toISOString();
  const storyblokDetail = storyblokProgressDetail(env);
  const storyblokStateCache = createStoryblokStateCache();
  const totalSteps = 12;
  assertApplyPreflight(manifest, { dryRun, env });

  await progress({ label: 'Checking Storyblok Access', current: 0, total: totalSteps, detail: storyblokDetail });
  const storyblokPreflight = await preflightStoryblokIntegration(manifest, { dryRun, env });
  await writeArtifact(workDir, 'storyblok-apply-step-00-preflight.json', storyblokPreflight);
  assertStoryblokPreflightPassed(storyblokPreflight);
  await progress({ label: 'Creating Storyblok Component Folders', current: 1, total: totalSteps, detail: storyblokDetail });
  const componentGroupsStep = {
    action: 'storyblok_component_groups',
    results: await createStoryblokComponentGroups(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-01-component-groups.json', componentGroupsStep);
  await progress({ label: 'Creating Storyblok Internal Tags', current: 2, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-02-internal-tags.json', {
    action: 'storyblok_internal_tags',
    results: await createStoryblokInternalTags(manifest, { dryRun, env })
  });
  await progress({ label: 'Creating Storyblok Components', current: 3, total: totalSteps, detail: storyblokDetail });
  const storyblokComponentsStep = {
    action: 'storyblok_components',
    results: await createStoryblokComponents(manifest, { dryRun, env, componentGroupResults: componentGroupsStep.results })
  };
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-03-components.json', storyblokComponentsStep);
  await progress({ label: 'Duplicating Storyblok Components', current: 4, total: totalSteps, detail: storyblokDetail });
  const storyblokDuplicateComponentsStep = {
    action: 'storyblok_duplicate_components',
    results: await duplicateStoryblokComponents(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-04-duplicate-components.json', storyblokDuplicateComponentsStep);
  const allComponentResults = [
    ...ensureArray(storyblokComponentsStep.results),
    ...ensureArray(storyblokDuplicateComponentsStep.results)
  ];
  await progress({ label: 'Creating Storyblok Asset Folders', current: 5, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-05-asset-folders.json', {
    action: 'storyblok_asset_folders',
    results: await createStoryblokAssetFolders(manifest, { dryRun, env })
  });
  await progress({ label: 'Uploading Assets', current: 6, total: totalSteps, detail: storyblokDetail });
  const storyblokAssetsStep = {
    action: 'storyblok_assets',
    results: await uploadStoryblokAssets(manifest, { dryRun, env })
  };
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-06-assets.json', storyblokAssetsStep);
  await progress({ label: 'Creating Storyblok Presets', current: 7, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-07-presets.json', {
    action: 'storyblok_presets',
    results: await createStoryblokPresets(manifest, {
      dryRun,
      env,
      componentResults: allComponentResults,
      assetResults: storyblokAssetsStep.results
    })
  });
  await progress({ label: 'Creating Draft Stories', current: 8, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-08-draft-stories.json', {
    action: 'storyblok_draft_stories',
    results: await createDraftStories(manifest, { dryRun, env, assetResults: storyblokAssetsStep.results })
  });
  await progress({ label: 'Validating Storyblok Content', current: 9, total: totalSteps, detail: storyblokDetail });
  const storyblokContentValidation = await validateStoryblokDraftContent(manifest, { dryRun, env });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-09-content-validation.json', storyblokContentValidation);
  assertStoryblokContentValidationPassed(storyblokContentValidation);
  await progress({ label: 'Verifying Storyblok Management State', current: 10, total: totalSteps, detail: storyblokDetail });
  const storyblokManagementVerification = await verifyStoryblokManagementState(manifest, {
    dryRun,
    env,
    stateCache: storyblokStateCache,
    refreshRemoteState: true
  });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-10-management-verification.json', storyblokManagementVerification);
  assertStoryblokManagementVerificationPassed(storyblokManagementVerification);
  await progress({ label: 'Recording Storyblok Activity Evidence', current: 11, total: totalSteps, detail: storyblokDetail });
  await recordApplyStep(workDir, steps, 'storyblok-apply-step-11-activity-evidence.json', await collectStoryblokActivityEvidence(manifest, {
    dryRun,
    env,
    since: startedAt
  }));
  await progress({ label: 'Done', current: 12, total: totalSteps });
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

function assertStoryblokManagementVerificationPassed(verification) {
  if (verification.status === 'failed') {
    throw new Error('Storyblok Management API verification failed after apply; remote resources remain unpublished drafts for review or rollback.');
  }
}

async function runHostChecks(manifest, { repoPath, dryRun, args = {}, phase = 'post-generation' }) {
  const scripts = hostCheckScripts(args);
  if (dryRun) {
    return {
      action: 'host_repository_checks',
      phase,
      dry_run: true,
      status: 'skipped',
      scripts,
      reason: 'dry-run does not write generated files or run host scripts.'
    };
  }
  if (args.skip_host_checks) {
    return {
      action: 'host_repository_checks',
      phase,
      dry_run: false,
      status: 'skipped',
      scripts,
      reason: 'host checks were skipped by --skip-host-checks.'
    };
  }

  const results = [];
  for (const script of scripts) {
    results.push(await runRepositoryScript({ repoPath, script }));
  }
  const failed = results.filter((result) => result.status === 'failed');
  const passed = results.filter((result) => result.status === 'passed');
  const shouldValidateIntegration = phase !== 'baseline' && passed.length > 0;
  const postCheckValidation = shouldValidateIntegration
    ? await validateIntegration(manifest, { repoPath })
    : null;
  const validationFailed = postCheckValidation?.status === 'failed';
  return {
    action: 'host_repository_checks',
    phase,
    dry_run: false,
    status: failed.length > 0 || validationFailed ? 'failed' : (passed.length > 0 ? 'passed' : 'skipped'),
    scripts,
    results,
    post_check_validation: postCheckValidation,
    note: hostCheckNote(phase, passed.length)
  };
}

function hostCheckNote(phase, passedCount) {
  if (passedCount === 0) return 'No configured host repository check scripts were available.';
  if (phase === 'baseline') return 'Available host repository checks passed before generated files were written.';
  return 'Available host repository checks passed before remote Storyblok mutations.';
}

function hostCheckScripts(args = {}) {
  if (args.host_checks) {
    return String(args.host_checks).split(',').map((script) => script.trim()).filter(Boolean);
  }
  return ['lint', 'typecheck', 'build'];
}

function assertHostChecksPassed(result) {
  if (result.status === 'failed') {
    const failedScripts = ensureArray(result.results)
      .filter((entry) => entry.status === 'failed')
      .map((entry) => entry.script)
      .join(', ');
    const validationFailed = result.post_check_validation?.status === 'failed';
    const timing = result.phase === 'baseline'
      ? 'before generated files were written'
      : 'before remote Storyblok mutations';
    throw new Error(`host repository checks failed ${timing}${failedScripts ? `: ${failedScripts}` : ''}${validationFailed ? '; post-check validation failed' : ''}`);
  }
}

function storyblokProgressDetail(env = process.env) {
  const interval = Number(env.STORYBLOK_REQUEST_INTERVAL_MS || 0);
  const retryLimit = Number(env.STORYBLOK_RETRY_LIMIT || 6);
  const parts = [];
  if (interval > 0) parts.push(`paced ${interval}ms`);
  parts.push(`${Number.isFinite(retryLimit) ? retryLimit : 6} retries`);
  return `rate safe: ${parts.join(', ')}`;
}

function plannedStoryblokOperationCount(manifest) {
  return ensureArray(manifest.storyblok?.component_groups_to_create).length +
    ensureArray(manifest.storyblok?.internal_tags_to_create).length +
    ensureArray(manifest.storyblok?.components_to_create).length +
    ensureArray(manifest.storyblok?.components_to_duplicate).length +
    ensureArray(manifest.storyblok?.asset_folders_to_create).length +
    ensureArray(manifest.storyblok?.assets_to_create).length +
    ensureArray(manifest.storyblok?.presets_to_create).length +
    ensureArray(manifest.storyblok?.stories_to_create).length;
}

function assertRepositoryPreflightPassed(preflight) {
  if (preflight.status === 'failed') {
    const failed = ensureArray(preflight.checks)
      .filter((check) => check.status !== 'passed')
      .map((check) => check.name)
      .join(', ');
    throw new Error(`repository preflight failed${failed ? `: ${failed}` : ''}`);
  }
}

function assertClientReviewGatePassed(gate) {
  if (gate.status === 'failed') {
    const failed = ensureArray(gate.checks)
      .filter((check) => check.status === 'failed')
      .map((check) => check.name)
      .join(', ');
    throw new Error(`client apply review gate failed${failed ? `: ${failed}` : ''}`);
  }
}
