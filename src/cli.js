import path from 'node:path';
import { ensureWorkDir, readEvidence, recordEvidence, writeArtifact, DEFAULT_WORK_DIR } from './evidence.js';
import { inspectNetlify, inspectRepository, inspectStoryblokEnvironment, inspectTemplate } from './inspectors.js';
import { createDefaultManifest, validatePlan } from './policy.js';
import { commandName, parseArgs, readJson, requireOption } from './utils.js';

const MUTATING_COMMANDS = new Set([
  'apply',
  'create-draft-story',
  'duplicate',
  'generate',
  'rollback-preview'
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

  if (MUTATING_COMMANDS.has(command) && !args.dry_run) {
    throw new Error(`${command} is currently guarded; rerun with --dry-run until external mutators are implemented`);
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
    result = inspectStoryblokEnvironment();
    await writeArtifact(workDir, 'storyblok-access.json', result);
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
  } else if (MUTATING_COMMANDS.has(command)) {
    result = {
      status: 'dry_run_only',
      command,
      note: 'External mutation support is intentionally stubbed until connectors and credentials are wired.'
    };
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
  const integrationId = requireOption(args, 'integration_id');
  const storyblokPrefix = requireOption(args, 'storyblok_prefix');
  const repositoryNamespace = String(args.repository_namespace || path.posix.join('src/integrations', integrationId));
  const manifest = createDefaultManifest({
    integrationId,
    storyblokPrefix,
    repositoryNamespace
  });

  manifest.repository.files_to_create = [
    `${repositoryNamespace}/integration-manifest.json`,
    `${repositoryNamespace}/index.js`,
    `${repositoryNamespace}/styles/${integrationId}.css`
  ];
  manifest.storyblok.components_to_create = [
    { technical_name: `${storyblokPrefix}template_page`, component_type: 'content_type' },
    { technical_name: `${storyblokPrefix}section`, component_type: 'nestable' }
  ];
  manifest.storyblok.stories_to_create = [
    { slug: `integration-preview/${integrationId}`, component: `${storyblokPrefix}template_page`, status: 'draft' }
  ];
  manifest.operations = [
    { type: 'create_new_resource', resource_type: 'repository_file', resource: `${repositoryNamespace}/integration-manifest.json` },
    { type: 'create_new_resource', resource_type: 'storyblok_component', resource: `${storyblokPrefix}template_page` },
    { type: 'create_new_resource', resource_type: 'storyblok_story', resource: `integration-preview/${integrationId}` }
  ];

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
  html-to-storyblok plan --integration-id <id> --storyblok-prefix <prefix_> [--repository-namespace <path>]
  html-to-storyblok validate-plan --manifest <path>
  html-to-storyblok report

Safe-mode mutating commands are present but currently dry-run guarded:
  duplicate, generate, apply, create-draft-story, rollback-preview

All evidence and generated artifacts are written to .tmp/html-to-storyblok by default.
`);
}

