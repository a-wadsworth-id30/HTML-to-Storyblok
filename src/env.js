import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, unique, writeText } from './utils.js';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];

export const ENV_TEMPLATE = `# HTML-to-Storyblok local environment
# Copy this file to .env.local and fill values locally. Do not commit real secrets.

# Storyblok Management API
# Required for remote Storyblok inspection, component creation, asset upload, and draft story creation.
STORYBLOK_MANAGEMENT_TOKEN=
# Alternative management token names accepted by the CLI.
STORYBLOK_OAUTH_TOKEN=
STORYBLOK_PERSONAL_ACCESS_TOKEN=

# Storyblok space and region
STORYBLOK_SPACE_ID=
# Alternative space ID name accepted by the CLI.
SB_SPACE_ID=
# eu, us, ca, ap, or cn.
STORYBLOK_REGION=eu

# Storyblok Content API
# Required for draft preview verification and live sandbox validation.
STORYBLOK_PREVIEW_TOKEN=
# Alternative content token names accepted by the CLI.
STORYBLOK_PUBLIC_TOKEN=
STORYBLOK_DELIVERY_TOKEN=

# Storyblok request tuning
# Use a small interval such as 200 when a space is rate-limited.
STORYBLOK_REQUEST_INTERVAL_MS=
STORYBLOK_TIMEOUT_MS=
STORYBLOK_CONTENT_TIMEOUT_MS=
STORYBLOK_INSPECT_MAX_ITEMS=
STORYBLOK_RETRY_LIMIT=
STORYBLOK_RETRY_BASE_MS=
STORYBLOK_RETRY_MAX_MS=

# Netlify API
# Required for deploy-preview lookup and verification.
NETLIFY_AUTH_TOKEN=
# Alternative Netlify token name accepted by the CLI.
NETLIFY_TOKEN=
NETLIFY_SITE_ID=

# GitHub API
# Required for draft pull-request creation through the GitHub REST API.
GITHUB_TOKEN=
# Alternative GitHub token name accepted by the CLI.
GH_TOKEN=

# GitLab API
# Required for draft merge-request creation through the GitLab REST API.
GITLAB_TOKEN=
# Alternative GitLab token name accepted by the CLI.
GITLAB_PRIVATE_TOKEN=
# Optional for self-managed GitLab instances. Defaults to https://gitlab.com.
GITLAB_BASE_URL=

# Live test opt-in
# STORYBLOK_LIVE_TESTS=1 enables the disposable live Storyblok sandbox test.
STORYBLOK_LIVE_TESTS=0
STORYBLOK_LIVE_TEST_TEMPLATE=
`;

export async function loadEnvironment({
  cwd = process.cwd(),
  repoPath = null,
  env = process.env,
  config = {}
} = {}) {
  const fileEnv = {};
  const filesLoaded = [];
  const directories = unique([
    cwd ? path.resolve(cwd) : null,
    repoPath ? path.resolve(cwd, repoPath) : null
  ]);

  for (const directory of directories) {
    for (const name of DEFAULT_ENV_FILES) {
      const filePath = path.join(directory, name);
      if (!(await pathExists(filePath))) continue;
      Object.assign(fileEnv, parseDotEnv(await readFile(filePath, 'utf8')));
      filesLoaded.push(filePath);
    }
  }

  const merged = {
    ...fileEnv,
    ...env
  };
  if (!merged.STORYBLOK_REGION && config.storyblok_region) {
    merged.STORYBLOK_REGION = config.storyblok_region;
  }
  if (!merged.STORYBLOK_SPACE_ID && !merged.SB_SPACE_ID && config.storyblok_space_id) {
    merged.STORYBLOK_SPACE_ID = config.storyblok_space_id;
  }

  return {
    env: merged,
    files_loaded: filesLoaded,
    variables_loaded: Object.keys(fileEnv)
      .filter((key) => env[key] === undefined)
      .sort()
  };
}

export async function initEnvFile({
  cwd = process.cwd(),
  filePath = '.env.local',
  force = false
} = {}) {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, filePath);
  const relativePath = path.relative(root, resolved) || path.basename(resolved);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('env file path must stay inside the current project');
  }
  if ((await pathExists(resolved)) && !force) {
    throw new Error(`${relativePath} already exists; pass --force to overwrite it`);
  }

  await writeText(resolved, ENV_TEMPLATE);
  return {
    action: 'init_env_file',
    status: 'written',
    path: resolved,
    relative_path: relativePath,
    secrets_written: false,
    gitignored: ['.env', '.env.*'].some((pattern) => matchesDotEnvPattern(relativePath, pattern)),
    note: 'Fill this file locally with real credentials. Secret values are not stored in config, reports, or evidence.'
  };
}

export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

function parseDotEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    return quote === '"' ? unescapeDoubleQuoted(value) : value;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function unescapeDoubleQuoted(value) {
  return value
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function matchesDotEnvPattern(filePath, pattern) {
  const basename = path.basename(filePath);
  if (pattern === '.env') return basename === '.env';
  if (pattern === '.env.*') return basename.startsWith('.env.');
  return false;
}
