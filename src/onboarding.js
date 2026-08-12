import path from 'node:path';
import { checkLiveAccess } from './access.js';
import { discoverRepositories, discoverTemplates, isRepository } from './discovery.js';
import { DEFAULT_WORK_DIR } from './evidence.js';
import { pathExists } from './utils.js';

export async function createOnboardingGuide({
  cwd = process.cwd(),
  config = {},
  env = process.env,
  configExists = false,
  workDir = config.default_output_folder || DEFAULT_WORK_DIR,
  filesLoaded = []
} = {}) {
  const root = path.resolve(cwd);
  const templatesFolder = config.templates_folder || 'templates';
  const templatesFolderPath = path.resolve(root, templatesFolder);
  const outputFolder = workDir || config.default_output_folder || DEFAULT_WORK_DIR;
  const outputPath = path.resolve(root, outputFolder);
  const defaultRepositoryPath = config.default_repository
    ? path.resolve(root, config.default_repository)
    : '';
  const [templates, repositories, templatesFolderExists, outputFolderExists, defaultRepositoryDetected] = await Promise.all([
    discoverTemplates({ templatesFolder, cwd: root }),
    discoverRepositories({ cwd: root }),
    pathExists(templatesFolderPath),
    pathExists(outputPath),
    defaultRepositoryPath ? isRepository(defaultRepositoryPath) : false
  ]);
  const access = checkLiveAccess(env);
  const templatesReady = templates.length > 0;
  const repositoryReady = Boolean(defaultRepositoryDetected || repositories.length > 0);
  const storyblokManagementReady = Boolean(access.storyblok.ready);
  const storyblokPreviewReady = Boolean(access.storyblok_content.ready);
  const netlifyReady = Boolean(access.netlify.ready);
  const githubReady = Boolean(access.github.ready);
  const gitlabReady = Boolean(access.gitlab.ready);
  const storyblokOnlyReady = templatesReady && storyblokManagementReady;
  const fullImportReady = templatesReady && repositoryReady && storyblokManagementReady;
  const livePreviewReady = storyblokPreviewReady && netlifyReady;
  const checks = [
    createCheck({
      id: 'config',
      label: 'Local config',
      status: configExists ? 'passed' : 'warning',
      detail: configExists ? 'Configured' : 'Not created yet',
      fix: 'Run html-to-storyblok settings to store safe defaults.'
    }),
    createCheck({
      id: 'templates',
      label: 'Templates folder',
      status: templatesReady ? 'passed' : templatesFolderExists ? 'warning' : 'failed',
      detail: templatesReady ? `${templates.length} template${templates.length === 1 ? '' : 's'} found` : `${templatesFolder} has no importable template folders`,
      fix: `Place supplied HTML templates under ${templatesFolder}/<template-name>.`
    }),
    createCheck({
      id: 'repository',
      label: 'Repository target',
      status: repositoryReady ? 'passed' : 'warning',
      detail: defaultRepositoryDetected
        ? `Default repository ${path.relative(root, defaultRepositoryPath) || '.'}`
        : repositories.length
          ? `${repositories.length} nearby repositor${repositories.length === 1 ? 'y' : 'ies'} found`
          : 'No repository selected yet',
      fix: 'Set default_repository in settings or select a repository in the wizard.'
    }),
    createCheck({
      id: 'storyblok_management',
      label: 'Storyblok Management API',
      status: storyblokManagementReady ? 'passed' : 'failed',
      detail: storyblokManagementReady ? credentialSourceLabel(access.storyblok.credential_sources) : 'Management token and space ID missing',
      fix: 'Run html-to-storyblok env --init, then fill STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID locally.'
    }),
    createCheck({
      id: 'storyblok_preview',
      label: 'Storyblok Preview API',
      status: storyblokPreviewReady ? 'passed' : 'warning',
      detail: storyblokPreviewReady ? credentialSourceLabel(access.storyblok_content.credential_sources) : 'Preview token missing',
      fix: 'Add STORYBLOK_PREVIEW_TOKEN when you need draft preview validation or live demo checks.'
    }),
    createCheck({
      id: 'netlify',
      label: 'Netlify',
      status: netlifyReady ? 'passed' : 'warning',
      detail: netlifyReady ? credentialSourceLabel(access.netlify.credential_sources) : 'Not configured',
      fix: 'Add NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID when validating deployed previews.'
    }),
    createCheck({
      id: 'review_platform',
      label: 'Review platform',
      status: githubReady || gitlabReady ? 'passed' : 'warning',
      detail: githubReady ? 'GitHub ready' : gitlabReady ? 'GitLab ready' : 'GitHub/GitLab not configured',
      fix: 'Add GITHUB_TOKEN or GITLAB_TOKEN only when automated PR/MR creation is required.'
    })
  ];
  const workflows = [
    createWorkflow({
      id: 'storyblok_only',
      label: 'Storyblok-only test',
      ready: storyblokOnlyReady,
      detail: storyblokOnlyReady
        ? 'Can create components, assets, presets, and draft stories without a repository.'
        : 'Needs a template and Storyblok Management API credentials.'
    }),
    createWorkflow({
      id: 'full_import',
      label: 'Full repository import',
      ready: fullImportReady,
      detail: fullImportReady
        ? 'Can inspect a repository, generate isolated files, validate, and apply Storyblok drafts.'
        : 'Needs a template, repository target, and Storyblok Management API credentials.'
    }),
    createWorkflow({
      id: 'live_preview',
      label: 'Live preview validation',
      ready: livePreviewReady,
      detail: livePreviewReady
        ? 'Can validate deployed previews against Storyblok draft content.'
        : 'Needs Storyblok Preview API and Netlify credentials.'
    })
  ];
  const nextSteps = buildNextSteps({
    configExists,
    templatesReady,
    repositoryReady,
    storyblokManagementReady,
    storyblokPreviewReady,
    netlifyReady,
    fullImportReady,
    storyblokOnlyReady
  });
  const status = fullImportReady ? 'ready' : storyblokOnlyReady ? 'partial' : 'needs_setup';

  return {
    action: 'onboarding',
    status,
    first_run: shouldShowFirstRun({ configExists, templatesReady, repositoryReady, storyblokManagementReady }),
    recommended_action: recommendedAction({ fullImportReady, storyblokOnlyReady }),
    config: {
      path: config.config_path || null,
      exists: Boolean(configExists),
      active_profile: config.active_profile || '',
      templates_folder: templatesFolder,
      default_repository: config.default_repository || '',
      storyblok_region: config.storyblok_region || 'eu',
      output_folder: outputFolder,
      output_folder_exists: outputFolderExists
    },
    discovery: {
      templates_folder_path: templatesFolderPath,
      templates_found: templates.length,
      templates: templates.map((template) => ({
        name: template.name,
        label: template.label,
        path: template.path
      })),
      repositories_found: repositories.length,
      repositories: repositories.map((repository) => ({
        label: repository.label,
        path: repository.path
      })),
      default_repository_path: defaultRepositoryPath || null,
      default_repository_detected: Boolean(defaultRepositoryDetected)
    },
    credentials: {
      files_loaded: filesLoaded,
      storyblok_management_ready: storyblokManagementReady,
      storyblok_preview_ready: storyblokPreviewReady,
      netlify_ready: netlifyReady,
      github_ready: githubReady,
      gitlab_ready: gitlabReady,
      sources: {
        storyblok_management: summarizeCredentialSources(access.storyblok.credential_sources),
        storyblok_preview: summarizeCredentialSources(access.storyblok_content.credential_sources),
        netlify: summarizeCredentialSources(access.netlify.credential_sources),
        github: summarizeCredentialSources(access.github.credential_sources),
        gitlab: summarizeCredentialSources(access.gitlab.credential_sources)
      },
      note: 'Secret values are intentionally omitted.'
    },
    checks,
    workflows,
    next_steps: nextSteps
  };
}

export function renderOnboardingText(guide) {
  return `HTML -> Storyblok Onboarding

Status: ${guide.status}
Recommended action: ${guide.recommended_action}

Readiness
${guide.checks.map((check) => `- ${check.label}: ${check.status} - ${check.detail}`).join('\n')}

Workflow Readiness
${guide.workflows.map((workflow) => `- ${workflow.label}: ${workflow.status} - ${workflow.detail}`).join('\n')}

Next Steps
${guide.next_steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

Config
- Path: ${guide.config.path || 'default'}
- Templates folder: ${guide.config.templates_folder}
- Default repository: ${guide.config.default_repository || 'not set'}
- Output folder: ${guide.config.output_folder}

Credentials
- Storyblok Management API: ${guide.credentials.storyblok_management_ready ? 'ready' : 'missing'}
- Storyblok Preview API: ${guide.credentials.storyblok_preview_ready ? 'ready' : 'missing'}
- Netlify: ${guide.credentials.netlify_ready ? 'ready' : 'missing'}
- GitHub: ${guide.credentials.github_ready ? 'ready' : 'missing'}
- GitLab: ${guide.credentials.gitlab_ready ? 'ready' : 'missing'}
- Secrets: omitted
`;
}

function createCheck({ id, label, status, detail, fix }) {
  return {
    id,
    label,
    status,
    detail,
    fix: status === 'passed' ? '' : fix
  };
}

function createWorkflow({ id, label, ready, detail }) {
  return {
    id,
    label,
    status: ready ? 'ready' : 'not_ready',
    ready: Boolean(ready),
    detail
  };
}

function buildNextSteps({
  configExists,
  templatesReady,
  repositoryReady,
  storyblokManagementReady,
  storyblokPreviewReady,
  netlifyReady,
  fullImportReady,
  storyblokOnlyReady
}) {
  const steps = [];
  if (!configExists) steps.push('Open Settings and store safe defaults for templates, repository, region, output folder, and colour mode.');
  if (!templatesReady) steps.push('Add a supplied HTML template under templates/<template-name>/ with at least one .html file.');
  if (!storyblokManagementReady) steps.push('Run html-to-storyblok env --init and fill Storyblok Management API token plus space ID in .env.local.');
  if (!repositoryReady) steps.push('Select a repository during the wizard or set default_repository with html-to-storyblok settings --set default_repository=<path>.');
  if (!storyblokPreviewReady) steps.push('Add STORYBLOK_PREVIEW_TOKEN before draft Content API validation or deployed preview checks.');
  if (!netlifyReady) steps.push('Add Netlify credentials before deploy-preview or live demo validation.');
  if (fullImportReady) steps.push('Choose Import Template Into Existing Site from Start Here.');
  else if (storyblokOnlyReady) steps.push('Choose Test Storyblok Only to prove the template model before touching a repository.');
  if (steps.length === 0) steps.push('Run html-to-storyblok doctor before client-facing work, then start the import wizard.');
  return steps;
}

function shouldShowFirstRun({ configExists, templatesReady, repositoryReady, storyblokManagementReady }) {
  return !configExists || !templatesReady || !repositoryReady || !storyblokManagementReady;
}

function recommendedAction({ fullImportReady, storyblokOnlyReady }) {
  if (fullImportReady) return 'Import Template Into Existing Site';
  if (storyblokOnlyReady) return 'Test Storyblok Only';
  return 'Set Up Credentials And Defaults';
}

function credentialSourceLabel(sources = []) {
  const configured = summarizeCredentialSources(sources).filter((source) => source.configured);
  if (!configured.length) return 'Configured';
  return configured.map((source) => `${source.label} from ${source.source}`).join(', ');
}

function summarizeCredentialSources(sources = []) {
  return sources.map((source) => ({
    label: source.label,
    variable: source.variable,
    configured: Boolean(source.configured),
    source: source.source || 'unknown'
  }));
}
