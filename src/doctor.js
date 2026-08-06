import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkLiveAccess } from './access.js';
import { getGitStatus } from './discovery.js';
import { pathExists } from './utils.js';

const execFileAsync = promisify(execFile);

export async function createDoctorReport({
  cwd = process.cwd(),
  config = {},
  env = process.env
} = {}) {
  const checks = [];
  checks.push(await commandCheck('node', ['--version'], {
    name: 'Node version',
    required: true,
    validate: (version) => Number(version.replace(/^v/, '').split('.')[0]) >= 20,
    fix: 'Install Node.js 20 or newer.'
  }));
  checks.push(await commandCheck('npm', ['--version'], {
    name: 'npm',
    required: true,
    fix: 'Install npm with Node.js.'
  }));
  checks.push(await commandCheck('git', ['--version'], {
    name: 'Git',
    required: true,
    fix: 'Install Git and ensure it is available on PATH.'
  }));

  const access = checkLiveAccess(env);
  checks.push(accessCheck('Storyblok Management API', access.storyblok, 'Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID.'));
  checks.push(accessCheck('Storyblok Content API', access.storyblok_content, 'Set STORYBLOK_PREVIEW_TOKEN or STORYBLOK_PUBLIC_TOKEN.'));
  checks.push(accessCheck('Netlify credentials', access.netlify, 'Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID when Netlify preview checks are needed.'));
  checks.push(accessCheck('GitHub credentials', access.github, 'Set GITHUB_TOKEN or GH_TOKEN when draft PR automation is needed.'));
  checks.push(accessCheck('GitLab credentials', access.gitlab, 'Set GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN when draft MR automation is needed.'));

  const templatesPath = path.resolve(cwd, config.templates_folder || 'templates');
  checks.push({
    name: 'Templates folder',
    status: await pathExists(templatesPath) ? 'passed' : 'warning',
    detail: templatesPath,
    fix: `Create ${config.templates_folder || 'templates'}/ or change templates_folder in settings.`
  });

  const repoPath = config.default_repository ? path.resolve(cwd, config.default_repository) : cwd;
  const gitStatus = await getGitStatus(repoPath);
  checks.push({
    name: 'Repository health',
    status: gitStatus.clean ? 'passed' : 'warning',
    detail: gitStatus.available ? `${gitStatus.changed_files.length} changed files` : gitStatus.reason,
    fix: gitStatus.clean ? '' : 'Review existing changes before applying a real integration.'
  });

  return {
    status: checks.some((check) => check.status === 'failed') ? 'failed' : checks.some((check) => check.status === 'warning') ? 'warning' : 'passed',
    checks
  };
}

async function commandCheck(command, args, {
  name,
  required,
  validate = () => true,
  fix
}) {
  try {
    const { stdout } = await execFileAsync(command, args);
    const detail = stdout.trim();
    const valid = validate(detail);
    return {
      name,
      status: valid ? 'passed' : required ? 'failed' : 'warning',
      detail,
      fix: valid ? '' : fix
    };
  } catch {
    return {
      name,
      status: required ? 'failed' : 'warning',
      detail: 'Not available',
      fix
    };
  }
}

function accessCheck(name, access, fix) {
  return {
    name,
    status: access.ready ? 'passed' : 'warning',
    detail: access.ready ? 'Configured' : `Missing ${access.required_variable_names.join(', ')}`,
    fix: access.ready ? '' : fix
  };
}
