import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { analyzeCss } from './analyzer.js';
import { inspectRepository } from './inspectors.js';
import { validatePlan } from './policy.js';
import { ensureArray, pathExists, readJson, sha256, unique } from './utils.js';

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.astro', '.css', '.scss', '.sass', '.less', '.html', '.json', '.md']);
const FORBIDDEN_PATTERNS = [
  ['dangerouslySetInnerHTML', /\bdangerouslySetInnerHTML\b/],
  ['v-html', /\bv-html\b/],
  ['document.write', /\bdocument\.write\s*\(/],
  ['eval', /\beval\s*\(/],
  ['debugger', /\bdebugger\b/],
  ['console.log', /\bconsole\.log\s*\(/],
  ['TODO', /\bTODO\b/],
  ['TypeScript suppression', /@(ts-ignore|ts-expect-error)/],
  ['broad lint disable', /eslint-disable(?!-next-line\s+[a-z0-9@/_-])/i]
];

export async function validateIntegration(manifest, { repoPath = process.cwd() } = {}) {
  const root = path.resolve(repoPath);
  const checks = [];
  const plan = validatePlan(manifest);
  addCheck(checks, 'manifest_policy', plan.valid, plan.valid ? 'Manifest satisfies additive-only policy.' : 'Manifest failed additive-only policy.', plan.violations);

  await checkPlannedFiles(manifest, root, checks);
  await checkPlannedAssets(manifest, root, checks);
  await checkRepositoryAdapterPlan(manifest, root, checks);
  await checkForbiddenCoupling(manifest, root, checks);
  await checkCssScoping(manifest, root, checks);
  await checkGitStatus(manifest, root, checks);

  return summarizeValidation(checks);
}

export async function diffIntegration(manifest, { repoPath = process.cwd() } = {}) {
  const root = path.resolve(repoPath);
  const repositoryFiles = [];
  for (const file of plannedRepositoryTextTargets(manifest)) {
    repositoryFiles.push({
      path: file,
      planned_action: ensureArray(manifest.repository?.files_to_create).includes(file) ? 'create' : 'duplicate',
      exists: await pathExists(path.join(root, file)),
      status: await pathExists(path.join(root, file)) ? 'exists' : 'missing'
    });
  }
  const repositoryAssets = [];
  for (const asset of ensureArray(manifest.repository?.assets_to_create)) {
    const target = asset.target_path || asset.path;
    repositoryAssets.push({
      path: target,
      planned_action: 'create',
      exists: target ? await pathExists(path.join(root, target)) : false,
      status: target && await pathExists(path.join(root, target)) ? 'exists' : 'missing'
    });
  }
  return {
    action: 'diff_manifest',
    repository_path: root,
    integration_id: manifest.integration_id,
    repository_files: repositoryFiles,
    repository_assets: repositoryAssets,
    storyblok_components: ensureArray(manifest.storyblok?.components_to_create).map((component) => ({
      technical_name: component.technical_name || component.name,
      planned_action: 'create_or_verify'
    })),
    storyblok_stories: ensureArray(manifest.storyblok?.stories_to_create).map((story) => ({
      slug: story.slug || story.full_slug,
      planned_action: 'create_or_verify_draft'
    })),
    storyblok_assets: ensureArray(manifest.storyblok?.assets_to_create).map((asset) => ({
      filename: asset.filename || asset.local_path,
      planned_action: 'upload_or_verify'
    }))
  };
}

export async function preflightRepositoryIntegration(manifest, { repoPath = process.cwd(), mode = 'apply' } = {}) {
  const root = path.resolve(repoPath);
  const checks = [];
  const plan = validatePlan(manifest);
  addCheck(checks, 'manifest_policy', plan.valid, plan.valid ? 'Manifest satisfies additive-only policy.' : 'Manifest failed additive-only policy.', plan.violations);
  addCheck(checks, 'repository_exists', await pathExists(root), 'Repository path exists.');
  const blockingCollisions = mode !== 'dry-run';

  const targets = plannedRepositoryTargets(manifest);
  const collisions = [];
  for (const target of targets) {
    if (await pathExists(path.join(root, target))) collisions.push(target);
  }
  const reusable = blockingCollisions
    ? await classifyReusableGeneratedTargets(manifest, root, collisions)
    : { reusable: [], blocking: collisions, reason: null };
  addCheck(
    checks,
    'planned_targets_available',
    collisions.length === 0 || !blockingCollisions || reusable.blocking.length === 0,
    plannedTargetsMessage(collisions, reusable, blockingCollisions),
    blockingCollisions ? reusable.blocking : collisions,
    collisions.length > 0 && !blockingCollisions ? 'warning' : undefined
  );
  if (reusable.reusable.length > 0) {
    addCheck(
      checks,
      'generated_targets_reusable',
      true,
      'Existing generated integration targets match the hash ledger and can be reused during resume.',
      reusable.reusable
    );
  }

  const missingSources = [];
  for (const source of plannedRepositorySources(manifest)) {
    if (!(await pathExists(path.join(root, source)))) missingSources.push(source);
  }
  addCheck(
    checks,
    'duplicate_sources_available',
    missingSources.length === 0,
    missingSources.length === 0 ? 'All planned duplicate sources are available.' : 'Planned duplicate sources are missing.',
    missingSources
  );

  await checkGitStatus(manifest, root, checks);
  const failed = checks.filter((check) => check.status === 'failed');
  return {
    action: 'repository_preflight',
    status: failed.length === 0 ? 'passed' : 'failed',
    mode,
    repository_path: root,
    integration_id: manifest.integration_id,
    planned_targets: targets.length,
    collisions,
    reusable_targets: reusable.reusable,
    blocking_collisions: blockingCollisions ? reusable.blocking : collisions,
    missing_sources: missingSources,
    checks,
    failed_checks: failed.length,
    note: mode === 'dry-run'
      ? 'Preflight is read-only. Existing planned targets are reported as warnings during dry run.'
      : 'Preflight is read-only. It refuses real apply when planned files would overwrite the existing site or unrelated worktree changes are present.'
  };
}

async function classifyReusableGeneratedTargets(manifest, root, collisions) {
  if (collisions.length === 0) return { reusable: [], blocking: [], reason: null };
  const namespace = manifest.repository_namespace;
  const ledgerPath = namespace ? `${namespace}/generated-file-hashes.json` : null;
  if (!namespace || !ledgerPath || !(await pathExists(path.join(root, ledgerPath)))) {
    return { reusable: [], blocking: collisions, reason: 'generated hash ledger is missing' };
  }

  let ledger;
  try {
    ledger = await readJson(path.join(root, ledgerPath));
  } catch (error) {
    return { reusable: [], blocking: collisions, reason: `generated hash ledger is unreadable: ${error.message || String(error)}` };
  }
  if (ledger.integration_id !== manifest.integration_id || ledger.repository_namespace !== namespace || ledger.algorithm !== 'sha256') {
    return { reusable: [], blocking: collisions, reason: 'generated hash ledger does not match this integration' };
  }

  const hashByPath = new Map(ensureArray(ledger.files).map((entry) => [entry.path, entry.sha256]));
  const reusable = [];
  const blocking = [];
  for (const target of collisions) {
    if (!String(target).startsWith(`${namespace}/`)) {
      blocking.push(target);
      continue;
    }
    if (target === ledgerPath) {
      reusable.push(target);
      continue;
    }
    const expectedHash = hashByPath.get(target);
    if (!expectedHash) {
      blocking.push(target);
      continue;
    }
    const actualHash = sha256(await readFile(path.join(root, target)));
    if (actualHash === expectedHash) {
      reusable.push(target);
    } else {
      blocking.push(target);
    }
  }
  return { reusable, blocking, reason: blocking.length > 0 ? 'one or more existing generated targets drifted from the hash ledger' : null };
}

function plannedTargetsMessage(collisions, reusable, blockingCollisions) {
  if (collisions.length === 0) return 'All planned repository targets are available.';
  if (!blockingCollisions) return 'Planned repository targets already exist.';
  if (reusable.blocking.length === 0) return 'Existing planned targets are generated integration files verified by the hash ledger.';
  return reusable.reason || 'Planned repository targets already exist.';
}

export async function runRepositoryScript({ repoPath = process.cwd(), script = 'build', dryRun = false } = {}) {
  const root = path.resolve(repoPath);
  const inspection = await inspectRepository(root);
  const scripts = inspection.scripts || {};
  if (!scripts[script]) {
    return {
      action: 'run_repository_script',
      script,
      status: 'unavailable',
      reason: `package.json does not define "${script}".`
    };
  }
  const command = packageManagerCommand(inspection.package_manager, script);
  if (dryRun) {
    return {
      action: 'run_repository_script',
      dry_run: true,
      script,
      command: command.join(' '),
      package_manager: inspection.package_manager
    };
  }
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
      cwd: root,
      env: { ...process.env, CI: 'true' },
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      action: 'run_repository_script',
      dry_run: false,
      script,
      command: command.join(' '),
      status: 'passed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    };
  } catch (error) {
    return {
      action: 'run_repository_script',
      dry_run: false,
      script,
      command: command.join(' '),
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: error.code ?? 1,
      stdout: truncate(error.stdout || ''),
      stderr: truncate(error.stderr || error.message || '')
    };
  }
}

async function checkPlannedFiles(manifest, root, checks) {
  for (const file of plannedRepositoryTextTargets(manifest)) {
    const exists = await pathExists(path.join(root, file));
    addCheck(checks, `file_exists:${file}`, exists, exists ? 'Integration-owned file exists.' : 'Integration-owned file is missing.');
  }
}

async function checkPlannedAssets(manifest, root, checks) {
  for (const asset of ensureArray(manifest.repository?.assets_to_create)) {
    const target = asset.target_path || asset.path;
    if (target) {
      const exists = await pathExists(path.join(root, target));
      addCheck(checks, `asset_exists:${target}`, exists, exists ? 'Repository asset exists.' : 'Repository asset is missing.');
    }
    const source = asset.source_path;
    if (source) {
      const sourcePath = await resolveSourcePath(manifest, root, source);
      const exists = await pathExists(sourcePath);
      addCheck(checks, `asset_source_exists:${source}`, exists, exists ? 'Source asset exists.' : 'Source asset is missing.');
    }
  }
  for (const asset of ensureArray(manifest.storyblok?.assets_to_create)) {
    const localPath = asset.local_path || asset.file || asset.path;
    if (!localPath) continue;
    const exists = await pathExists(localPath);
    addCheck(checks, `storyblok_asset_source_exists:${localPath}`, exists, exists ? 'Storyblok asset source exists.' : 'Storyblok asset source is missing.');
  }
}

async function checkRepositoryAdapterPlan(manifest, root, checks) {
  const adapterPath = `${manifest.repository_namespace}/adapter-plan.json`;
  const fullPath = path.join(root, adapterPath);
  if (!(await pathExists(fullPath))) return;

  try {
    const adapter = JSON.parse(await readFile(fullPath, 'utf8'));
    const routeFailures = ensureArray(adapter.routes).filter((route) => (
      (route.preview_file && !isInsideNamespace(route.preview_file, manifest.repository_namespace)) ||
      (route.template_html_module && !isInsideNamespace(route.template_html_module, manifest.repository_namespace)) ||
      (route.route_proposal_file && !isInsideNamespace(route.route_proposal_file, manifest.repository_namespace)) ||
      !String(route.storyblok_slug || '').startsWith(`${manifest.integration_id}/`) ||
      route.registration_policy !== 'manual_review_required'
    ));
    const routeProposalFailures = [
      adapter.route_proposals?.manifest_file && !isInsideNamespace(adapter.route_proposals.manifest_file, manifest.repository_namespace) ? 'route proposal manifest must stay inside the integration namespace' : null,
      adapter.route_proposals?.readme_file && !isInsideNamespace(adapter.route_proposals.readme_file, manifest.repository_namespace) ? 'route proposal README must stay inside the integration namespace' : null,
      adapter.route_proposals?.host_routes_modified === true ? 'route proposals must not mark host routes as modified' : null,
      ...ensureArray(adapter.route_proposals?.routes).map((route) => (
        route.proposal_file && !isInsideNamespace(route.proposal_file, manifest.repository_namespace)
          ? `route proposal must stay inside the integration namespace: ${route.proposal_file}`
          : null
      ))
    ].filter(Boolean);
    const violations = [
      adapter.integration_id === manifest.integration_id ? null : 'integration_id does not match manifest',
      adapter.storyblok_prefix === manifest.storyblok_prefix ? null : 'storyblok_prefix does not match manifest',
      adapter.repository_namespace === manifest.repository_namespace ? null : 'repository_namespace does not match manifest',
      adapter.additive_only === true ? null : 'additive_only must be true',
      adapter.host_routes_modified === false ? null : 'host_routes_modified must be false',
      adapter.host_registries_modified === false ? null : 'host_registries_modified must be false',
      String(adapter.root_component || '').startsWith(manifest.storyblok_prefix) ? null : 'root_component must be namespaced',
      adapter.entrypoints?.root_preview && !isInsideNamespace(adapter.entrypoints.root_preview, manifest.repository_namespace) ? 'root_preview must stay inside the integration namespace' : null,
      adapter.entrypoints?.storyblok_renderer && !isInsideNamespace(adapter.entrypoints.storyblok_renderer, manifest.repository_namespace) ? 'storyblok_renderer must stay inside the integration namespace' : null,
      routeFailures.length === 0 ? null : `route mappings failed additive-only validation: ${routeFailures.map((route) => route.slug || route.preview_file).join(', ')}`,
      routeProposalFailures.length === 0 ? null : `route proposals failed additive-only validation: ${routeProposalFailures.join(', ')}`
    ].filter(Boolean);
    addCheck(
      checks,
      'repository_adapter_plan',
      violations.length === 0,
      violations.length === 0 ? 'Repository adapter plan is additive-only and matches the manifest.' : 'Repository adapter plan failed additive-only validation.',
      violations
    );
  } catch (error) {
    addCheck(checks, 'repository_adapter_plan', false, 'Repository adapter plan is not valid JSON.', error.message || String(error));
  }
}

async function resolveSourcePath(manifest, root, source) {
  if (path.isAbsolute(source)) return source;
  const cwdRelative = path.resolve(source);
  if (await pathExists(cwdRelative)) return cwdRelative;
  const templateRelative = manifest.template?.source_path
    ? path.resolve(manifest.template.source_path, source)
    : null;
  if (templateRelative && await pathExists(templateRelative)) return templateRelative;
  return path.join(root, source);
}

async function checkForbiddenCoupling(manifest, root, checks) {
  const namespace = manifest.repository_namespace;
  const files = await existingTextFiles(root, plannedRepositoryTextTargets(manifest));
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8');
    const violations = [];
    for (const [name, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) violations.push(name);
    }
    if (!file.endsWith('.md')) {
      for (const importPath of extractImports(content)) {
        if (isForbiddenImport(importPath, namespace, file)) {
          violations.push(`runtime import outside integration namespace: ${importPath}`);
        }
      }
    }
    addCheck(
      checks,
      `forbidden_coupling:${file}`,
      violations.length === 0,
      violations.length === 0 ? 'No forbidden coupling detected.' : 'Forbidden coupling detected.',
      violations
    );
  }
}

async function checkCssScoping(manifest, root, checks) {
  const rootClass = `hts-${manifest.integration_id}-root`;
  const cssFiles = (await existingTextFiles(root, plannedRepositoryTextTargets(manifest)))
    .filter((file) => /\.(css|scss|sass|less)$/.test(file));
  for (const file of cssFiles) {
    const content = await readFile(path.join(root, file), 'utf8');
    const facts = analyzeCss(content, { sourceFile: file });
    const unscoped = facts.global_selectors.filter((selector) => !selector.includes(rootClass));
    addCheck(
      checks,
      `css_scoped:${file}`,
      unscoped.length === 0,
      unscoped.length === 0 ? 'CSS selectors are scoped.' : 'CSS contains global selectors.',
      unscoped
    );
  }
}

function plannedRepositoryTextTargets(manifest) {
  return unique([
    ...ensureArray(manifest.repository?.files_to_create),
    ...ensureArray(manifest.repository?.components_to_duplicate).map((entry) => entry.target_path || entry.target)
  ]);
}

function plannedRepositoryTargets(manifest) {
  return unique([
    ...plannedRepositoryTextTargets(manifest),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => asset.target_path || asset.path)
  ]);
}

function plannedRepositorySources(manifest) {
  return unique([
    ...ensureArray(manifest.repository?.components_to_duplicate).map((entry) => entry.source_path || entry.source),
    ...ensureArray(manifest.repository?.assets_to_create)
      .filter((asset) => asset.source_path && asset.source_type !== 'template')
      .map((asset) => asset.source_path)
  ]);
}

function isInsideNamespace(filePath, namespace) {
  const normalized = String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const normalizedNamespace = String(namespace || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  return normalized === normalizedNamespace || normalized.startsWith(`${normalizedNamespace}/`);
}

async function checkGitStatus(manifest, root, checks) {
  const gitDir = path.join(root, '.git');
  if (!(await pathExists(gitDir))) {
    addCheck(checks, 'git_status', true, 'Repository is not a Git worktree; git status check skipped.');
    return;
  }
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: root });
    const changed = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const outsideNamespace = [];
    for (const line of changed) {
      const file = gitStatusPath(line);
      if (!file) continue;
      if (isIntegrationOwnedGitPath(file, manifest)) continue;
      if (line.startsWith('??') && await untrackedDirectoryContainsOnlyIntegrationPaths(root, file, manifest)) continue;
      outsideNamespace.push(line);
    }
    addCheck(
      checks,
      'git_status',
      outsideNamespace.length === 0,
      outsideNamespace.length === 0 ? 'No changed files outside the integration namespace.' : 'Changed files outside the integration namespace detected.',
      outsideNamespace
    );
  } catch (error) {
    addCheck(checks, 'git_status', false, 'Unable to inspect git status.', error.message);
  }
}

function gitStatusPath(line) {
  const raw = line.slice(3).replace(/^"|"$/g, '');
  const renameIndex = raw.lastIndexOf(' -> ');
  return renameIndex === -1 ? normalizeGitPath(raw) : normalizeGitPath(raw.slice(renameIndex + 4));
}

function normalizeGitPath(file) {
  return String(file || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isIntegrationOwnedGitPath(file, manifest) {
  const normalized = normalizeGitPath(file);
  return isSameOrChildPath(normalized, manifest.repository_namespace)
    || isSameOrChildPath(normalized, `public/integrations/${manifest.integration_id}`);
}

function isSameOrChildPath(file, parent) {
  const normalizedParent = normalizeGitPath(parent);
  return file === normalizedParent || file.startsWith(`${normalizedParent}/`);
}

async function untrackedDirectoryContainsOnlyIntegrationPaths(root, file, manifest) {
  const normalized = normalizeGitPath(file);
  try {
    const fileStat = await stat(path.join(root, normalized));
    if (!fileStat.isDirectory()) return false;
    const children = await recursiveDirectoryFiles(root, normalized);
    return children.length > 0 && children.every((child) => isIntegrationOwnedGitPath(child, manifest));
  } catch {
    return false;
  }
}

async function recursiveDirectoryFiles(root, dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await recursiveDirectoryFiles(root, child));
    } else {
      files.push(child);
    }
  }
  return files;
}

async function existingTextFiles(root, files) {
  const output = [];
  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!(await pathExists(fullPath))) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const fileStat = await stat(fullPath);
    if (fileStat.size > 2_000_000) continue;
    output.push(file);
  }
  return output;
}

function extractImports(content) {
  return [
    ...[...content.matchAll(/\bimport\s+(?:[^'"()]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
    ...[...content.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  ];
}

function isForbiddenImport(importPath, namespace, fromFile = '') {
  if (!importPath.startsWith('.') && !importPath.startsWith('@/') && !importPath.startsWith('~/')) return false;
  if (importPath.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), importPath));
    return !resolved.startsWith(`${namespace}/`);
  }
  if (importPath.includes('/components') || importPath.includes('/layouts') || importPath.includes('/styles')) return true;
  return !importPath.includes(namespace);
}

function addCheck(checks, name, passed, message, details = null, statusOverride = null) {
  checks.push({
    name,
    status: statusOverride || (passed ? 'passed' : 'failed'),
    message,
    details
  });
}

function summarizeValidation(checks) {
  const failed = checks.filter((check) => check.status === 'failed');
  return {
    action: 'validate_integration',
    status: failed.length === 0 ? 'passed' : 'failed',
    checks,
    failed_checks: failed.length
  };
}

function packageManagerCommand(packageManager, script) {
  if (packageManager === 'pnpm') return ['pnpm', 'run', script];
  if (packageManager === 'yarn') return ['yarn', script];
  if (packageManager === 'bun') return ['bun', 'run', script];
  return ['npm', 'run', script];
}

function truncate(value, limit = 12_000) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}
