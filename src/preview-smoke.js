const SERVER_RENDERED_GENERATED_SITES = new Set(['astro', 'next', 'nuxt']);
const CLIENT_APP_SHELL_GENERATED_SITES = new Set(['react', 'vue']);

export function buildPreviewSmokeTargets({ baseUrl, site, generated = null } = {}) {
  const targets = [{
    name: 'base',
    route: '/',
    url: joinUrl(baseUrl, '/'),
    render_mode: 'html_response',
    expected: {
      html: true
    }
  }];

  if (!generated?.integration_id) return targets;

  const normalizedSite = String(site || '').toLowerCase();
  const serverRendered = SERVER_RENDERED_GENERATED_SITES.has(normalizedSite);
  const clientAppShell = CLIENT_APP_SHELL_GENERATED_SITES.has(normalizedSite);
  const route = generated.smoke_route || (serverRendered ? '/about' : '/');
  targets.push({
    name: 'generated_route',
    route,
    url: joinUrl(baseUrl, route),
    render_mode: serverRendered ? 'server_rendered' : 'client_app_shell',
    expected: {
      html: true,
      integration_id: serverRendered ? generated.integration_id : null,
      storyblok_source: serverRendered ? ['generated-fallback', 'storyblok-draft'] : null,
      storyblok_slug: serverRendered ? generated.storyblok_slug : null,
      client_app_shell: clientAppShell
    }
  });

  return targets;
}

export function evaluatePreviewSmokeHtml(target, {
  responseOk = false,
  httpStatus = null,
  html = '',
  elapsedMs = 0
} = {}) {
  const text = String(html || '');
  const checks = [
    {
      name: 'html_response',
      status: responseOk && htmlLooksValid(text) ? 'passed' : 'failed',
      expected: 'HTTP success with HTML document',
      actual: responseOk ? `HTTP ${httpStatus}` : `HTTP ${httpStatus || 'unavailable'}`
    }
  ];

  if (target.expected?.integration_id) {
    const integrationId = firstAttributeValue(text, 'data-integration') || classIntegrationId(text, target.expected.integration_id);
    checks.push({
      name: 'integration_root',
      status: integrationId === target.expected.integration_id ? 'passed' : 'failed',
      expected: target.expected.integration_id,
      actual: integrationId
    });
  }

  if (target.expected?.storyblok_source) {
    const source = firstAttributeValue(text, 'data-hts-storyblok-source');
    checks.push({
      name: 'storyblok_source_marker',
      status: target.expected.storyblok_source.includes(source) ? 'passed' : 'failed',
      expected: target.expected.storyblok_source.join(' or '),
      actual: source
    });
  }

  if (target.expected?.storyblok_slug) {
    const slug = firstAttributeValue(text, 'data-hts-storyblok-slug');
    checks.push({
      name: 'storyblok_slug_marker',
      status: slug === target.expected.storyblok_slug ? 'passed' : 'failed',
      expected: target.expected.storyblok_slug,
      actual: slug
    });
  }

  if (target.expected?.client_app_shell) {
    checks.push({
      name: 'client_app_shell',
      status: htmlLooksValid(text) && hasClientAppShell(text) ? 'passed' : 'failed',
      expected: 'HTML app shell for browser-rendered generated route',
      actual: hasClientAppShell(text) ? 'app shell detected' : 'app shell not detected'
    });
  }

  const failed = checks.filter((check) => check.status === 'failed');
  return {
    name: target.name,
    route: target.route,
    url: target.url,
    status: failed.length > 0 ? 'failed' : 'passed',
    render_mode: target.render_mode,
    http_status: httpStatus,
    html: htmlLooksValid(text),
    elapsed_ms: elapsedMs,
    checks,
    reason: failed.length > 0 ? failed.map((check) => `${check.name}: expected ${check.expected}, got ${check.actual || 'nothing'}`).join('; ') : null
  };
}

export function joinUrl(baseUrl, route) {
  const url = new URL(normalizeRoutePath(route), `${normalizeBaseUrl(baseUrl)}/`);
  return url.toString();
}

export function normalizeRoutePath(value) {
  const route = String(value || '/').trim();
  if (!route || route === '/') return '/';
  return `/${route.replace(/^\/+/, '').replace(/\/+$/g, '')}`;
}

function htmlLooksValid(html) {
  return /<html|<!doctype html/i.test(html);
}

function hasClientAppShell(html) {
  return /\bid=["'](?:root|app|__next|__nuxt)["']/i.test(html) || /<script\b[^>]*\b(?:type=["']module["']|src=)/i.test(html);
}

function classIntegrationId(html, expected) {
  return html.includes(`hts-${expected}-root`) ? expected : null;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function firstAttributeValue(html, attributeName) {
  const escaped = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html || '').match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match ? decodeHtmlAttribute(match[1]) : null;
}

function decodeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#x22;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}
