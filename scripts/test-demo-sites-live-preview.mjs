import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WORK_DIR } from '../src/evidence.js';

const DEFAULT_SITES = ['static', 'astro', 'next', 'nuxt', 'vue', 'react'];
const DEFAULT_ROUTES = ['/', '/about', '/services', '/gallery', '/contact'];
const DEFAULT_TIMEOUT_MS = 20000;

const args = parseArgs(process.argv.slice(2));
const selectedSites = args.site ? csv(args.site) : DEFAULT_SITES;
const routes = args.routes ? csv(args.routes).map(normalizeRoutePath) : DEFAULT_ROUTES;
const timeoutMs = Number(args.timeout_ms || args.timeoutMs || DEFAULT_TIMEOUT_MS);
const requireConfigured = Boolean(args.require_configured || args.requireConfigured);
const requireStoryblokDraft = Boolean(args.require_storyblok_draft || args.requireStoryblokDraft);
const integrationId = args.integration_id || args.integrationId || '';
const urlMap = resolveConfiguredUrls(args, process.env);
const fixtureResponses = args.fixture ? await readFixtureResponses(args.fixture) : null;
const reportPath = args.report === false || args.report === 'false'
  ? null
  : String(args.report_path || args.reportPath || path.join(DEFAULT_WORK_DIR, 'demo-sites-live-preview-report.md'));

if (args.list) {
  console.log(JSON.stringify({
    action: 'test_demo_sites_live_preview',
    status: 'listed',
    routes,
    sites: DEFAULT_SITES.map((site) => ({
      site,
      configured: Boolean(urlMap[site]),
      url: urlMap[site] || null,
      env: envNameForSite(site)
    }))
  }, null, 2));
  process.exit(0);
}

const configuredSites = selectedSites
  .map((site) => site.toLowerCase())
  .filter((site) => urlMap[site]);

if (configuredSites.length === 0) {
  const result = {
    action: 'test_demo_sites_live_preview',
    status: requireConfigured ? 'failed' : 'skipped',
    reason: 'No deployed demo site URLs were configured.',
    required_env: selectedSites.map((site) => envNameForSite(site)),
    routes
  };
  if (reportPath) result.preview_report = await writeLivePreviewReport(reportPath, result);
  console.log(JSON.stringify(result, null, 2));
  if (requireConfigured) process.exit(1);
  process.exit(0);
}

const summaries = [];
for (const site of configuredSites) {
  summaries.push(await testSite(site, urlMap[site], { routes, timeoutMs, requireStoryblokDraft, integrationId, fixtureResponses }));
}

const failed = summaries.some((site) => site.status === 'failed');
const result = {
  action: 'test_demo_sites_live_preview',
  status: failed ? 'failed' : 'passed',
  require_storyblok_draft: requireStoryblokDraft,
  integration_id: integrationId || null,
  routes,
  sites: summaries
};
if (reportPath) result.preview_report = await writeLivePreviewReport(reportPath, result);
console.log(JSON.stringify(result, null, 2));

if (failed) process.exit(1);

async function testSite(site, baseUrl, { routes, timeoutMs, requireStoryblokDraft, integrationId, fixtureResponses }) {
  const routeResults = [];
  for (const route of routes) {
    routeResults.push(await testRoute(site, baseUrl, route, { timeoutMs, requireStoryblokDraft, integrationId, fixtureResponses }));
  }
  return {
    site,
    url: baseUrl,
    status: routeResults.some((route) => route.status === 'failed') ? 'failed' : 'passed',
    routes: routeResults
  };
}

async function testRoute(site, baseUrl, route, { timeoutMs, requireStoryblokDraft, integrationId, fixtureResponses }) {
  const url = joinUrl(baseUrl, route);
  const startedAt = Date.now();
  try {
    const response = fixtureResponses
      ? fixtureResponseFor(route, fixtureResponses)
      : await fetchWithTimeout(url, timeoutMs);
    const text = await response.text();
    const marker = parseStoryblokSourceMarker(text);
    const htmlLooksValid = /<html|<!doctype html/i.test(text);
    const status = evaluateRouteStatus({
      response,
      htmlLooksValid,
      marker,
      requireStoryblokDraft,
      integrationId,
      route
    });
    return {
      route,
      url,
      status: status.status,
      http_status: response.status,
      html: htmlLooksValid,
      storyblok_source: marker.source,
      storyblok_slug: marker.slug,
      storyblok_draft_rendered: marker.source === 'storyblok-draft',
      generated_fallback_rendered: marker.source === 'generated-fallback',
      elapsed_ms: Date.now() - startedAt,
      reason: status.reason
    };
  } catch (error) {
    return {
      route,
      url,
      status: 'failed',
      http_status: null,
      html: false,
      storyblok_source: null,
      storyblok_slug: null,
      storyblok_draft_rendered: false,
      generated_fallback_rendered: false,
      elapsed_ms: Date.now() - startedAt,
      reason: error.message
    };
  }
}

function evaluateRouteStatus({ response, htmlLooksValid, marker, requireStoryblokDraft, integrationId, route }) {
  if (!response.ok) return { status: 'failed', reason: `HTTP ${response.status}` };
  if (!htmlLooksValid) return { status: 'failed', reason: 'Response did not look like HTML.' };
  if (requireStoryblokDraft && marker.source !== 'storyblok-draft') {
    return {
      status: 'failed',
      reason: marker.source
        ? `Expected Storyblok draft content, got ${marker.source}.`
        : 'Expected Storyblok draft content marker, but no marker was found.'
    };
  }
  if (integrationId && marker.slug && !marker.slug.startsWith(`${integrationId}/`)) {
    return {
      status: 'failed',
      reason: `Storyblok slug ${marker.slug} did not match integration ${integrationId}.`
    };
  }
  if (integrationId && marker.source === 'storyblok-draft') {
    const expected = route === '/' ? `${integrationId}/home` : `${integrationId}${route}`;
    if (marker.slug !== expected) {
      return { status: 'failed', reason: `Expected Storyblok slug ${expected}, got ${marker.slug}.` };
    }
  }
  return { status: 'passed', reason: null };
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'html-to-storyblok-live-preview-smoke/1.0'
    },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

async function readFixtureResponses(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  return Object.fromEntries(Object.entries(parsed).map(([route, response]) => [
    normalizeRoutePath(route),
    typeof response === 'string' ? { status: 200, body: response } : response
  ]));
}

function fixtureResponseFor(route, fixtureResponses) {
  const fixture = fixtureResponses[normalizeRoutePath(route)] || { status: 404, body: '<!doctype html><html><body>Not found</body></html>' };
  return new Response(fixture.body || '', {
    status: fixture.status || 200,
    headers: { 'Content-Type': fixture.content_type || fixture.contentType || 'text/html' }
  });
}

function parseStoryblokSourceMarker(html) {
  return {
    source: firstAttributeValue(html, 'data-hts-storyblok-source'),
    slug: firstAttributeValue(html, 'data-hts-storyblok-slug')
  };
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

function resolveConfiguredUrls(args, env) {
  const map = {};
  const envMap = parseUrlMap(env.HTS_DEMO_LIVE_URLS);
  for (const site of DEFAULT_SITES) {
    const key = `${site}_url`;
    const camelKey = `${site}Url`;
    map[site] = normalizeBaseUrl(
      args[key] ||
      args[camelKey] ||
      envMap[site] ||
      env[envNameForSite(site)] ||
      ''
    );
  }
  if (args.url) {
    for (const entry of Array.isArray(args.url) ? args.url : [args.url]) {
      const [site, url] = String(entry).split('=', 2);
      if (site && url) map[site.toLowerCase()] = normalizeBaseUrl(url);
    }
  }
  if (args.base_url || args.baseUrl) {
    if (selectedSites.length !== 1) {
      throw new Error('--base-url can only be used with exactly one --site value.');
    }
    map[selectedSites[0].toLowerCase()] = normalizeBaseUrl(args.base_url || args.baseUrl);
  }
  return map;
}

function parseUrlMap(value) {
  if (!value) return {};
  const text = String(value).trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return Object.fromEntries(Object.entries(parsed).map(([key, url]) => [key.toLowerCase(), normalizeBaseUrl(url)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(text.split(',').map((entry) => {
    const [site, url] = entry.split('=', 2);
    return [String(site || '').trim().toLowerCase(), normalizeBaseUrl(url || '')];
  }).filter(([site, url]) => site && url));
}

function envNameForSite(site) {
  return `HTS_DEMO_${String(site).toUpperCase()}_URL`;
}

function joinUrl(baseUrl, route) {
  const url = new URL(normalizeRoutePath(route), `${normalizeBaseUrl(baseUrl)}/`);
  return url.toString();
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function normalizeRoutePath(value) {
  const route = String(value || '/').trim();
  if (!route || route === '/') return '/';
  return `/${route.replace(/^\/+/, '').replace(/\/+$/g, '')}`;
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function writeLivePreviewReport(filePath, result) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderLivePreviewReport(result));
  return filePath;
}

function renderLivePreviewReport(result) {
  const siteSections = result.sites?.length
    ? result.sites.map(renderSiteSection).join('\n\n')
    : renderNoConfiguredSites(result);
  return `# Demo Site Live Preview Evidence

- Action: ${result.action}
- Status: ${result.status}
- Storyblok draft required: ${result.require_storyblok_draft ? 'yes' : 'no'}
- Integration: ${result.integration_id || 'not supplied'}
- Routes checked: ${ensureArray(result.routes).join(', ') || 'none'}

${siteSections}
`;
}

function renderSiteSection(site) {
  const routeRows = ensureArray(site.routes).map((route) =>
    `- ${route.route}: ${route.status} HTTP ${route.http_status ?? 'n/a'} source=${route.storyblok_source || 'none'} slug=${route.storyblok_slug || 'none'}${route.reason ? ` reason=${route.reason}` : ''}`
  ).join('\n') || '- No routes checked';
  return `## ${site.site}

- URL: ${site.url}
- Status: ${site.status}

${routeRows}`;
}

function renderNoConfiguredSites(result) {
  const required = ensureArray(result.required_env).map((name) => `- ${name}`).join('\n') || '- None';
  return `## No Configured Sites

- Reason: ${result.reason || 'No deployed demo sites were checked.'}

Required environment variables:

${required}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replaceAll('-', '_');
    const value = inlineValue !== undefined
      ? inlineValue
      : argv[index + 1] && !argv[index + 1].startsWith('--')
        ? argv[++index]
        : true;
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
  }
  return parsed;
}
