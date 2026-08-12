import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectRepository } from './inspectors.js';
import { ensureArray, pathExists, writeText } from './utils.js';

export async function createVisualEditorReadiness({
  manifest,
  repoPath = null,
  previewUrl = null,
  requirePreviewUrl = false,
  workDir = null
} = {}) {
  if (!manifest) throw new Error('visual editor readiness requires a manifest');
  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : null;
  const checks = [];

  checks.push(draftContentCheck(manifest));
  checks.push(blockIdentityCheck(manifest));
  checks.push(previewUrlCheck(previewUrl, { required: requirePreviewUrl }));

  if (resolvedRepoPath) {
    checks.push(...await generatedRendererChecks(manifest, resolvedRepoPath));
    checks.push(await routeHandoffCheck(manifest, resolvedRepoPath));
    checks.push(await bridgeCheck(resolvedRepoPath));
    checks.push(await iframeSecurityCheck(resolvedRepoPath));
  } else {
    checks.push(readinessCheck('repository_files', 'warning', 'Repository path not supplied.', {
      evidence: ['Run with --repo <path> after generation to check generated renderer and route handoff files.']
    }));
  }

  const summary = summarizeChecks(checks);
  const result = {
    action: 'visual_editor_readiness',
    status: summary.failed > 0 ? 'failed' : summary.warning > 0 ? 'warning' : 'passed',
    integration_id: manifest.integration_id,
    repository_path: resolvedRepoPath,
    preview_url: previewUrl || null,
    summary,
    checks
  };

  if (workDir) {
    result.markdown_report = await writeVisualEditorReadinessReport(workDir, result);
  }

  return result;
}

export async function writeVisualEditorReadinessReport(workDir, result) {
  const filePath = path.join(workDir, 'visual-editor-readiness-report.md');
  await writeText(filePath, renderVisualEditorReadinessReport(result));
  return filePath;
}

export function renderVisualEditorReadinessReport(result) {
  const checks = result.checks.map((check) => {
    const evidence = check.evidence.length
      ? check.evidence.map((entry) => `  - ${entry}`).join('\n')
      : '  - No unresolved evidence.';
    return `## ${check.name}

- Status: ${check.status}
- Summary: ${check.summary}
${check.recommendation ? `- Recommendation: ${check.recommendation}\n` : ''}
${evidence}`;
  }).join('\n\n');

  return `# Storyblok Visual Editor Readiness

- Integration: ${result.integration_id || 'unknown'}
- Status: ${result.status}
- Repository: ${result.repository_path || 'not supplied'}
- Preview URL: ${result.preview_url || 'not supplied'}
- Passed checks: ${result.summary.passed}
- Warning checks: ${result.summary.warning}
- Failed checks: ${result.summary.failed}

${checks}

## Expected Handoff

- Fetch draft Storyblok Content API content for editor previews.
- Preserve safe \`_editable\` Storyblok markers or add framework-native \`storyblokEditable\` attributes in hand-authored components.
- Load the Storyblok Bridge in preview environments when live editing is required.
- Serve preview URLs over HTTPS and allow Storyblok iframe embedding.
`;
}

function draftContentCheck(manifest) {
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  if (stories.length === 0) {
    return readinessCheck('draft_content', 'failed', 'No draft stories are planned for Visual Editor preview.', {
      recommendation: 'Create draft stories before opening the imported routes in the Visual Editor.'
    });
  }
  return readinessCheck('draft_content', 'passed', `${stories.length} draft story/stories planned.`, {
    evidence: stories.map((story) => story.slug || story.full_slug).filter(Boolean).slice(0, 20)
  });
}

function blockIdentityCheck(manifest) {
  const blocks = ensureArray(manifest.storyblok?.stories_to_create).flatMap((story) => flattenBloks(story.content));
  const missingUid = blocks.filter((block) => !block._uid);
  const missingComponent = blocks.filter((block) => !block.component);
  const editable = blocks.filter((block) => typeof block._editable === 'string' && block._editable.trim());
  if (missingComponent.length > 0) {
    return readinessCheck('block_identity', 'failed', 'Some draft blocks are missing component values.', {
      evidence: [
        `${missingUid.length} block(s) missing _uid.`,
        `${missingComponent.length} block(s) missing component.`
      ],
      recommendation: 'Regenerate the plan so every imported Storyblok block has stable identity fields.'
    });
  }
  const status = missingUid.length > 0 || editable.length === 0 ? 'warning' : 'passed';
  return readinessCheck('block_identity', status, `${blocks.length} block(s) have component identity; ${missingUid.length} missing local _uid; ${editable.length} include _editable markers locally.`, {
    evidence: [
      ...(missingUid.length > 0 ? [`${missingUid.length} block(s) are missing local _uid values.`] : []),
      editable.length > 0
        ? 'Local draft content already includes safe _editable comments.'
        : 'Storyblok adds _editable markers to draft Content API responses; local manifests usually do not include them.'
    ],
    recommendation: status === 'passed' ? null : 'Run a draft Content API validation after apply to confirm remote _uid and _editable markers are returned.'
  });
}

async function generatedRendererChecks(manifest, repoPath) {
  const namespace = manifest.repository_namespace;
  const framework = String(manifest.template?.framework || 'static').toLowerCase();
  const rootPreview = rootPreviewPath(namespace, framework);
  const checks = [];

  checks.push(await fileContainsCheck(repoPath, `${namespace}/template-html.js`, 'editable_marker_preservation', [
    'injectStoryblokEditableMarkers',
    'storyblokEditableComment',
    '<!--#storyblok#'
  ], {
    summary: 'Generated HTML renderer preserves safe Storyblok editable comments.',
    recommendation: 'Run generate/apply before this check, or keep hand-authored renderers compatible with _editable markers.'
  }));

  checks.push(await fileContainsCheck(repoPath, rootPreview, 'integration_preview_root', [
    `hts-${manifest.integration_id}-root`,
    `data-integration="${manifest.integration_id}"`
  ], {
    summary: 'Generated preview root exposes the isolated integration marker.',
    recommendation: 'Regenerate isolated frontend output before wiring preview routes.'
  }));

  return checks;
}

async function routeHandoffCheck(manifest, repoPath) {
  const namespace = manifest.repository_namespace;
  const routeManifestPath = path.join(repoPath, namespace, 'route-proposals', 'manifest.json');
  if (!(await pathExists(routeManifestPath))) {
    return readinessCheck('route_handoff_preview', 'warning', 'Route proposal manifest has not been generated.', {
      recommendation: 'Run generate/apply and wire-routes before validating Visual Editor route previews.'
    });
  }
  const routeManifest = JSON.parse(await readFile(routeManifestPath, 'utf8'));
  const routes = ensureArray(routeManifest.routes);
  const missingSlugs = routes.filter((route) => !route.storyblok_slug);
  return readinessCheck('route_handoff_preview', missingSlugs.length > 0 ? 'failed' : 'passed', `${routes.length} route proposal(s) include Storyblok draft slugs.`, {
    evidence: routes.map((route) => `${route.suggested_site_path} -> ${route.storyblok_slug || 'missing'}`).slice(0, 20),
    recommendation: missingSlugs.length > 0 ? 'Regenerate the route proposals so every preview route can fetch the correct draft story.' : null
  });
}

async function bridgeCheck(repoPath) {
  const inspection = await inspectRepository(repoPath);
  const packages = ensureArray(inspection.storyblok_sdk).map((entry) => entry.name);
  const hasBridgePackage = packages.includes('@storyblok/preview-bridge') || packages.includes('@storyblok/js');
  const sourceEvidence = await scanRepoText(repoPath, ['StoryblokBridge', 'useStoryblokBridge', 'storyblokEditable', 'v-editable']);
  if (hasBridgePackage || sourceEvidence.length > 0) {
    return readinessCheck('preview_bridge', 'passed', 'Storyblok bridge or editable helper evidence was found.', {
      evidence: [
        `Packages: ${packages.join(', ') || 'none'}`,
        ...sourceEvidence
      ]
    });
  }
  return readinessCheck('preview_bridge', 'warning', 'No Storyblok Bridge or framework editable-helper evidence was found in the repository.', {
    evidence: [`Packages: ${packages.join(', ') || 'none'}`],
    recommendation: 'Add Storyblok Bridge support to preview-only routes when live editing, context menus, and editor refresh behavior are required.'
  });
}

async function iframeSecurityCheck(repoPath) {
  const candidates = ['netlify.toml', 'public/_headers', '_headers'];
  const evidence = [];
  for (const candidate of candidates) {
    const filePath = path.join(repoPath, candidate);
    if (!(await pathExists(filePath))) continue;
    const content = await readFile(filePath, 'utf8');
    if (/frame-ancestors[\s\S]*app\.storyblok\.com/i.test(content) || /X-Frame-Options:\s*(ALLOW|ALLOW-FROM)/i.test(content)) {
      evidence.push(`${candidate}: Storyblok iframe policy found.`);
    } else {
      evidence.push(`${candidate}: no explicit Storyblok iframe policy found.`);
    }
  }
  const passed = evidence.some((entry) => /Storyblok iframe policy found/i.test(entry));
  return readinessCheck('iframe_security', passed ? 'passed' : 'warning', passed ? 'Preview iframe policy references Storyblok.' : 'Storyblok iframe/CSP policy was not confirmed.', {
    evidence: evidence.length ? evidence : ['No Netlify headers, public _headers, or root _headers file found.'],
    recommendation: passed ? null : 'Confirm the preview deployment allows embedding in the Storyblok Visual Editor iframe.'
  });
}

function previewUrlCheck(previewUrl, { required }) {
  if (!previewUrl) {
    return readinessCheck('preview_url', required ? 'failed' : 'warning', 'No Visual Editor preview URL was supplied.', {
      recommendation: 'Pass --preview-url <https-url> or configure the URL in Storyblok Settings -> Visual Editor.'
    });
  }
  const isHttps = /^https:\/\//i.test(String(previewUrl));
  return readinessCheck('preview_url', isHttps ? 'passed' : 'failed', isHttps ? 'Preview URL is HTTPS.' : 'Preview URL must use HTTPS for Storyblok Visual Editor.', {
    evidence: [String(previewUrl)],
    recommendation: isHttps ? null : 'Use a deployed HTTPS preview or an HTTPS local tunnel/certificate for editor previews.'
  });
}

async function fileContainsCheck(repoPath, relativePath, name, tokens, { summary, recommendation }) {
  const filePath = path.join(repoPath, relativePath);
  if (!(await pathExists(filePath))) {
    return readinessCheck(name, 'failed', `${relativePath} was not found.`, {
      recommendation
    });
  }
  const content = await readFile(filePath, 'utf8');
  const missing = tokens.filter((token) => !content.includes(token));
  return readinessCheck(name, missing.length > 0 ? 'failed' : 'passed', missing.length > 0 ? `${relativePath} is missing expected Visual Editor marker support.` : summary, {
    evidence: missing.map((token) => `Missing token: ${token}`),
    recommendation: missing.length > 0 ? recommendation : null
  });
}

async function scanRepoText(repoPath, needles) {
  const roots = ['src', 'pages', 'app', 'components'];
  const matches = [];
  for (const root of roots) {
    await scanDirectory(path.join(repoPath, root), repoPath, needles, matches);
  }
  return matches.slice(0, 20);
}

async function scanDirectory(directory, repoPath, needles, matches) {
  if (!(await pathExists(directory)) || matches.length >= 20) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= 20) return;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(filePath, repoPath, needles, matches);
      continue;
    }
    if (!/\.(?:js|jsx|mjs|ts|tsx|vue|astro|html)$/i.test(entry.name)) continue;
    const content = await readFile(filePath, 'utf8');
    const needle = needles.find((item) => content.includes(item));
    if (needle) matches.push(`${path.relative(repoPath, filePath).split(path.sep).join('/')}: ${needle}`);
  }
}

function flattenBloks(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenBloks(item, output);
    return output;
  }
  if (value.component) output.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') flattenBloks(child, output);
  }
  return output;
}

function rootPreviewPath(namespace, framework) {
  if (framework === 'astro') return `${namespace}/TemplatePage.astro`;
  if (framework === 'vue' || framework === 'nuxt') return `${namespace}/TemplatePage.vue`;
  if (framework === 'react' || framework === 'next') return `${namespace}/TemplatePage.jsx`;
  return `${namespace}/template.html`;
}

function readinessCheck(name, status, summary, { evidence = [], recommendation = null } = {}) {
  return {
    name,
    status,
    summary,
    evidence: ensureArray(evidence).filter(Boolean),
    recommendation
  };
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === 'passed').length,
    warning: checks.filter((check) => check.status === 'warning').length,
    failed: checks.filter((check) => check.status === 'failed').length
  };
}
