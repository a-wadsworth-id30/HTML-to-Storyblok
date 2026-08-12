import { execFile } from 'node:child_process';
import path from 'node:path';
import { checkLiveAccess } from './access.js';
import { getGitStatus } from './discovery.js';
import { pathExists } from './utils.js';

export async function createDoctorReport({
  cwd = process.cwd(),
  config = {},
  env = process.env,
  execFileImpl = execFile,
  target = 'all'
} = {}) {
  const mode = normalizeDoctorTarget(target);
  const profile = doctorProfile(mode);
  const checks = [];
  checks.push(await commandCheck(execFileImpl, 'node', ['--version'], {
    name: 'Node version',
    required: true,
    validate: (version) => Number(version.replace(/^v/, '').split('.')[0]) >= 20,
    fix: 'Install Node.js 20 or newer.'
  }));
  checks.push(await commandCheck(execFileImpl, 'npm', ['--version'], {
    name: 'npm',
    required: true,
    fix: 'Install npm with Node.js.'
  }));
  if (profile.git) {
    checks.push(await commandCheck(execFileImpl, 'git', ['--version'], {
      name: 'Git',
      required: true,
      fix: 'Install Git and ensure it is available on PATH.'
    }));
  }
  if (profile.netlifyCli) {
    checks.push(await commandCheck(execFileImpl, 'netlify', ['--version'], {
      name: 'Netlify CLI',
      required: profile.netlifyCliRequired,
      fix: profile.netlifyCliRequired ? 'Install netlify-cli before running deploy-preview verification.' : 'Install netlify-cli to enable --include-logs snapshots.'
    }));
  }

  const access = checkLiveAccess(env);
  if (profile.storyblokManagement) {
    checks.push(accessCheck('Storyblok Management API', access.storyblok, 'Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID.', profile.storyblokManagementRequired));
  }
  if (profile.storyblokContent) {
    checks.push(accessCheck('Storyblok Content API', access.storyblok_content, 'Set STORYBLOK_PREVIEW_TOKEN or STORYBLOK_PUBLIC_TOKEN.', profile.storyblokContentRequired));
  }
  if (profile.netlifyCredentials) {
    checks.push(accessCheck('Netlify credentials', access.netlify, 'Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID when Netlify preview checks are needed.', profile.netlifyCredentialsRequired));
  }
  if (profile.github) {
    checks.push(accessCheck('GitHub credentials', access.github, 'Set GITHUB_TOKEN or GH_TOKEN when draft PR automation is needed.', false));
  }
  if (profile.gitlab) {
    checks.push(accessCheck('GitLab credentials', access.gitlab, 'Set GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN when draft MR automation is needed.', false));
  }

  if (profile.templates) {
    const templatesPath = path.resolve(cwd, config.templates_folder || 'templates');
    checks.push({
      name: 'Templates folder',
      status: await pathExists(templatesPath) ? 'passed' : 'warning',
      detail: templatesPath,
      fix: `Create ${config.templates_folder || 'templates'}/ or change templates_folder in settings.`
    });
  }

  if (profile.repository) {
    const repoPath = config.default_repository ? path.resolve(cwd, config.default_repository) : cwd;
    const gitStatus = await getGitStatus(repoPath);
    checks.push({
      name: 'Repository health',
      status: gitStatus.clean ? 'passed' : 'warning',
      detail: gitStatus.available ? `${gitStatus.changed_files.length} changed files` : gitStatus.reason,
      fix: gitStatus.clean ? '' : 'Review existing changes before applying a real integration.'
    });
  }

  return {
    target: mode,
    description: profile.description,
    status: checks.some((check) => check.status === 'failed') ? 'failed' : checks.some((check) => check.status === 'warning') ? 'warning' : 'passed',
    checks
  };
}

export function normalizeDoctorTarget(target = 'all') {
  const normalized = String(target || 'all').toLowerCase().trim().replaceAll('_', '-');
  const aliases = {
    default: 'all',
    everything: 'all',
    storyblok: 'storyblok-only',
    'storyblok-test': 'storyblok-only',
    repo: 'repo-only',
    repository: 'repo-only',
    import: 'full-import',
    full: 'full-import',
    netlify: 'netlify-preview'
  };
  return aliases[normalized] || ['all', 'storyblok-only', 'full-import', 'netlify-preview', 'repo-only'].includes(normalized)
    ? (aliases[normalized] || normalized)
    : 'all';
}

function doctorProfile(target) {
  const profiles = {
    all: {
      description: 'General environment and project readiness',
      git: true,
      netlifyCli: true,
      netlifyCliRequired: false,
      storyblokManagement: true,
      storyblokManagementRequired: false,
      storyblokContent: true,
      storyblokContentRequired: false,
      netlifyCredentials: true,
      netlifyCredentialsRequired: false,
      github: true,
      gitlab: true,
      templates: true,
      repository: true
    },
    'storyblok-only': {
      description: 'Storyblok-only import readiness',
      git: false,
      netlifyCli: false,
      storyblokManagement: true,
      storyblokManagementRequired: true,
      storyblokContent: true,
      storyblokContentRequired: false,
      netlifyCredentials: false,
      github: false,
      gitlab: false,
      templates: true,
      repository: false
    },
    'full-import': {
      description: 'Full template-to-repository import readiness',
      git: true,
      netlifyCli: false,
      storyblokManagement: true,
      storyblokManagementRequired: true,
      storyblokContent: true,
      storyblokContentRequired: false,
      netlifyCredentials: false,
      github: false,
      gitlab: false,
      templates: true,
      repository: true
    },
    'netlify-preview': {
      description: 'Netlify deploy preview verification readiness',
      git: true,
      netlifyCli: true,
      netlifyCliRequired: false,
      storyblokManagement: false,
      storyblokContent: false,
      netlifyCredentials: true,
      netlifyCredentialsRequired: true,
      github: false,
      gitlab: false,
      templates: false,
      repository: true
    },
    'repo-only': {
      description: 'Repository-only generation and validation readiness',
      git: true,
      netlifyCli: false,
      storyblokManagement: false,
      storyblokContent: false,
      netlifyCredentials: false,
      github: false,
      gitlab: false,
      templates: true,
      repository: true
    }
  };
  return profiles[target] || profiles.all;
}

async function commandCheck(execFileImpl, command, args, {
  name,
  required,
  validate = () => true,
  fix
}) {
  try {
    const { stdout } = await execFilePromise(execFileImpl, command, args);
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

function execFilePromise(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function accessCheck(name, access, fix, required = false) {
  const sourceDetail = credentialSourceDetail(access);
  return {
    name,
    status: access.ready ? 'passed' : required ? 'failed' : 'warning',
    detail: access.ready
      ? `Configured${sourceDetail ? ` (${sourceDetail})` : ''}`
      : `Missing ${access.required_variable_names.join(', ')}${sourceDetail ? `; found ${sourceDetail}` : ''}`,
    fix: access.ready ? '' : fix
  };
}

function credentialSourceDetail(access) {
  return (access.credential_sources || [])
    .filter((entry) => entry.configured)
    .map((entry) => `${entry.variable} from ${entry.source}`)
    .join('; ');
}
