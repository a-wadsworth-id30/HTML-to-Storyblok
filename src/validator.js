import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { analyzeCss } from './analyzer.js';
import { inspectRepository } from './inspectors.js';
import { validatePlan } from './policy.js';
import { ensureArray, pathExists, unique } from './utils.js';

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
    for (const importPath of extractImports(content)) {
      if (isForbiddenImport(importPath, namespace)) {
        violations.push(`runtime import outside integration namespace: ${importPath}`);
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

async function checkGitStatus(manifest, root, checks) {
  const gitDir = path.join(root, '.git');
  if (!(await pathExists(gitDir))) {
    addCheck(checks, 'git_status', true, 'Repository is not a Git worktree; git status check skipped.');
    return;
  }
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: root });
    const changed = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const outsideNamespace = changed.filter((line) => {
      const file = line.slice(3).replace(/^"|"$/g, '');
      return file && !file.startsWith(`${manifest.repository_namespace}/`) && !file.startsWith(`public/integrations/${manifest.integration_id}/`);
    });
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

function isForbiddenImport(importPath, namespace) {
  if (!importPath.startsWith('.') && !importPath.startsWith('@/') && !importPath.startsWith('~/')) return false;
  if (importPath.startsWith('./')) return false;
  if (importPath.startsWith('../')) return escapesNamespace(importPath);
  if (importPath.includes('/components') || importPath.includes('/layouts') || importPath.includes('/styles')) return true;
  return !importPath.includes(namespace);
}

function escapesNamespace(importPath) {
  return importPath.split('/').filter((part) => part === '..').length > 1;
}

function addCheck(checks, name, passed, message, details = null) {
  checks.push({
    name,
    status: passed ? 'passed' : 'failed',
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
