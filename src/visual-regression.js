import { sha256 } from './utils.js';

export function buildHtmlVisualSnapshot(html, {
  site = null,
  route = '/',
  url = null
} = {}) {
  const text = String(html || '');
  const title = firstTagText(text, 'title');
  const headings = collectTagTexts(text, 'h1', 6);
  const secondaryHeadings = collectTagTexts(text, 'h2', 12);
  const images = collectImages(text);
  const links = collectLinks(text);
  const visibleText = visibleTextContent(text);
  const integrationRoot = firstAttributeValue(text, 'data-integration') || firstIntegrationRootClass(text);
  const storyblokSource = firstAttributeValue(text, 'data-hts-storyblok-source');
  const storyblokSlug = firstAttributeValue(text, 'data-hts-storyblok-slug');
  const signature = {
    title,
    headings,
    secondary_headings: secondaryHeadings,
    image_sources: images.map((image) => image.src),
    image_alts: images.map((image) => image.alt),
    link_targets: links.map((link) => link.href),
    link_labels: links.map((link) => link.label),
    integration_root: integrationRoot,
    storyblok_source: storyblokSource,
    storyblok_slug: storyblokSlug,
    metrics: {
      body_text_length: visibleText.length,
      image_count: images.length,
      link_count: links.length,
      stylesheet_count: tagCount(text, 'link', /\brel=["']?stylesheet/i),
      script_count: tagCount(text, 'script'),
      section_count: tagCount(text, 'section'),
      main_count: tagCount(text, 'main')
    }
  };
  const checks = visualSnapshotChecks(text, signature);
  const failed = checks.filter((check) => check.status === 'failed');

  return {
    action: 'html_visual_snapshot',
    status: failed.length > 0 ? 'failed' : 'passed',
    site,
    route,
    url,
    key: visualSnapshotKey(site, route),
    fingerprint: sha256(JSON.stringify(signature)),
    signature,
    checks,
    reason: failed.length > 0 ? failed.map((check) => `${check.name}: ${check.reason}`).join('; ') : null
  };
}

export function compareVisualSnapshot(snapshot, baselineSnapshot) {
  if (!baselineSnapshot) {
    return {
      action: 'compare_visual_snapshot',
      status: 'failed',
      key: snapshot.key,
      checks: [{
        name: 'baseline_present',
        status: 'failed',
        expected: snapshot.key,
        actual: null,
        reason: 'No baseline snapshot exists for this site and route.'
      }],
      reason: 'No baseline snapshot exists for this site and route.'
    };
  }

  const baseline = baselineSnapshot.signature ? baselineSnapshot : { signature: baselineSnapshot };
  const checks = [
    visualCompareCheck('fingerprint', snapshot.fingerprint, baseline.fingerprint),
    visualCompareCheck('title', snapshot.signature.title, baseline.signature?.title),
    visualCompareCheck('primary_headings', snapshot.signature.headings, baseline.signature?.headings),
    visualCompareCheck('secondary_headings', snapshot.signature.secondary_headings, baseline.signature?.secondary_headings),
    visualCompareCheck('image_sources', snapshot.signature.image_sources, baseline.signature?.image_sources),
    visualCompareCheck('link_targets', snapshot.signature.link_targets, baseline.signature?.link_targets),
    visualCompareCheck('integration_root', snapshot.signature.integration_root, baseline.signature?.integration_root),
    visualCompareCheck('storyblok_slug', snapshot.signature.storyblok_slug, baseline.signature?.storyblok_slug)
  ];
  const failed = checks.filter((check) => check.status === 'failed');
  return {
    action: 'compare_visual_snapshot',
    status: failed.length > 0 ? 'failed' : 'passed',
    key: snapshot.key,
    checks,
    reason: failed.length > 0 ? failed.map((check) => `${check.name}: expected ${formatValue(check.expected)}, got ${formatValue(check.actual)}`).join('; ') : null
  };
}

export function buildVisualBaseline(routeSnapshots = []) {
  return {
    action: 'html_visual_baseline',
    version: 1,
    generated_at: new Date().toISOString(),
    snapshots: Object.fromEntries(routeSnapshots.map((snapshot) => [snapshot.key, snapshot]))
  };
}

export function visualSnapshotKey(site, route) {
  return `${site || 'site'} ${normalizeRoute(route)}`;
}

function visualSnapshotChecks(html, signature) {
  return [
    {
      name: 'html_document',
      status: /<html|<!doctype html/i.test(html) ? 'passed' : 'failed',
      reason: 'Expected an HTML document.'
    },
    {
      name: 'visible_text',
      status: signature.metrics.body_text_length > 0 ? 'passed' : 'failed',
      reason: 'Expected visible text content.'
    },
    {
      name: 'primary_heading',
      status: signature.headings.length > 0 ? 'passed' : 'warning',
      reason: 'No h1 heading found.'
    }
  ];
}

function visualCompareCheck(name, actual, expected) {
  const actualText = JSON.stringify(actual ?? null);
  const expectedText = JSON.stringify(expected ?? null);
  return {
    name,
    status: actualText === expectedText ? 'passed' : 'failed',
    expected,
    actual
  };
}

function visibleTextContent(html) {
  return decodeHtml(stripTags(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
  )).replace(/\s+/g, ' ').trim();
}

function collectTagTexts(html, tagName, limit) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const values = [];
  for (const match of String(html || '').matchAll(pattern)) {
    values.push(normalizeText(stripTags(match[1])));
    if (values.length >= limit) break;
  }
  return values.filter(Boolean);
}

function firstTagText(html, tagName) {
  return collectTagTexts(html, tagName, 1)[0] || null;
}

function collectImages(html) {
  return collectVoidTags(html, 'img').map((attributes) => ({
    src: normalizeAttributeValue(firstAttributeFrom(attributes, 'src')),
    alt: normalizeAttributeValue(firstAttributeFrom(attributes, 'alt'))
  })).filter((image) => image.src || image.alt);
}

function collectLinks(html) {
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const values = [];
  for (const match of String(html || '').matchAll(pattern)) {
    const href = normalizeAttributeValue(firstAttributeFrom(match[1], 'href'));
    const label = normalizeText(stripTags(match[2]));
    if (href || label) values.push({ href, label });
    if (values.length >= 30) break;
  }
  return values;
}

function collectVoidTags(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  return [...String(html || '').matchAll(pattern)].map((match) => match[1] || '');
}

function tagCount(html, tagName, attributePattern = null) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let count = 0;
  for (const match of String(html || '').matchAll(pattern)) {
    if (!attributePattern || attributePattern.test(match[1] || '')) count += 1;
  }
  return count;
}

function firstIntegrationRootClass(html) {
  const match = String(html || '').match(/\bclass=["'][^"']*\bhts-([a-z0-9-]+)-root\b[^"']*["']/i);
  return match ? match[1] : null;
}

function firstAttributeValue(html, attributeName) {
  return normalizeAttributeValue(firstAttributeFrom(html, attributeName));
}

function firstAttributeFrom(text, attributeName) {
  const escaped = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`${escaped}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? match[1] : null;
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function normalizeText(value) {
  return decodeHtml(stripTags(value)).replace(/\s+/g, ' ').trim();
}

function normalizeAttributeValue(value) {
  return value === null || value === undefined ? null : decodeHtml(String(value)).trim();
}

function normalizeRoute(route) {
  const value = String(route || '/').trim();
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+/, '').replace(/\/+$/g, '')}`;
}

function decodeHtml(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#x22;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function formatValue(value) {
  return JSON.stringify(value ?? null);
}
