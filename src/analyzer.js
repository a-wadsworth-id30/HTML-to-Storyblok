import path from 'node:path';
import { pathExists, unique } from './utils.js';

export const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|eot|pdf|json)$/i;

const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'figcaption', 'blockquote'];
const LANDMARK_TAGS = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'];
const THIRD_PARTY_HOST_ALLOWLIST = new Set(['schema.org']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function analyzeHtml(content, { sourceFile = '' } = {}) {
  const tags = extractTags(content);
  const tagCounts = countBy(tags.map((tag) => tag.name));
  const title = decodeEntities(firstMatch(content, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const headings = extractPairedTagText(content, /h[1-6]/i).map((entry) => ({
    level: Number(entry.tag.slice(1)),
    text: cleanText(entry.text),
    attributes: entry.attributes,
    field_hint: extractFieldHint(entry.attributes)
  }));
  const textBlocks = extractTextBlocks(content);
  const images = tags
    .filter((tag) => tag.name === 'img')
    .map((tag) => ({
      src: tag.attributes.src || '',
      alt: tag.attributes.alt ?? null,
      width: tag.attributes.width || null,
      height: tag.attributes.height || null,
      loading: tag.attributes.loading || null,
      field_hint: extractFieldHint(tag.attributes)
    }));
  const links = extractPairedTagText(content, /^a$/i).map((entry) => ({
    href: entry.attributes.href || '',
    text: cleanText(entry.text),
    target: entry.attributes.target || null,
    field_hint: extractFieldHint(entry.attributes)
  }));
  const forms = extractPairedTagText(content, /^form$/i).map((entry) => ({
    action: entry.attributes.action || '',
    method: (entry.attributes.method || 'get').toLowerCase(),
    inputs: extractFormControls(entry.innerHtml)
  }));
  const scripts = extractScripts(content);
  const inlineHandlers = extractInlineHandlers(tags);
  const assetRefs = extractAssetReferences(content);
  const externalUrls = unique(extractUrls(content).filter((url) => isThirdPartyUrl(url)));
  const classNames = unique(tags.flatMap((tag) => splitClasses(tag.attributes.class)));
  const ids = unique(tags.map((tag) => tag.attributes.id));
  const landmarks = Object.fromEntries(LANDMARK_TAGS.map((tag) => [tag, tagCounts[tag] || 0]));

  return {
    source_file: sourceFile,
    title,
    tag_counts: tagCounts,
    landmarks,
    headings,
    text_blocks: textBlocks,
    images,
    links,
    forms,
    scripts,
    inline_handlers: inlineHandlers,
    asset_references: assetRefs,
    external_urls: externalUrls,
    classes: classNames,
    ids,
    repeated_candidates: inferRepeatedHtmlCandidates(tags),
    accessibility_issues: inferHtmlAccessibilityIssues({ images, links, forms, headings, sourceFile }),
    risks: inferHtmlRisks({ scripts, inlineHandlers, externalUrls, forms })
  };
}

export function analyzeCss(content, { sourceFile = '' } = {}) {
  const stripped = stripCssComments(content);
  const selectors = extractCssSelectors(stripped);
  const urls = extractCssUrls(stripped);
  const customProperties = unique([...stripped.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map((match) => `--${match[1]}`));
  const keyframes = unique([...stripped.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g)].map((match) => match[1]));
  const fontFaces = [...stripped.matchAll(/@font-face\s*{([\s\S]*?)}/gi)].map((match) => ({
    font_family: cleanCssValue(firstMatch(match[1], /font-family\s*:\s*([^;]+)/i)),
    sources: extractCssUrls(match[1])
  }));
  const breakpoints = unique([...stripped.matchAll(/@media\s*([^{]+)/gi)].map((match) => match[1].trim()));
  const class_selectors = unique([...stripped.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]));
  const id_selectors = unique([...stripped.matchAll(/#(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]));
  const globalSelectors = selectors.filter(isGlobalSelector);

  return {
    source_file: sourceFile,
    breakpoints,
    asset_references: urls,
    custom_properties: customProperties,
    keyframes,
    font_faces: fontFaces,
    class_selectors,
    id_selectors,
    global_selectors: globalSelectors,
    risks: [
      ...globalSelectors.map((selector) => `Global selector requires namespacing: ${selector}`),
      ...fontFaces.filter((font) => font.sources.length > 0).map((font) => `Font licence requires review: ${font.font_family || 'unknown font'}`)
    ]
  };
}

export function analyzeScript(content, { sourceFile = '' } = {}) {
  const externalUrls = unique(extractUrls(content));
  const selectors = unique([
    ...[...content.matchAll(/querySelector(?:All)?\(\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2]),
    ...[...content.matchAll(/getElementById\(\s*(['"`])([^'"`]+)\1/g)].map((match) => `#${match[2]}`)
  ]);
  const eventTypes = unique([...content.matchAll(/addEventListener\(\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2]));
  const browserApis = [
    ['window', /\bwindow\b/],
    ['document', /\bdocument\b/],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['IntersectionObserver', /\bIntersectionObserver\b/],
    ['MutationObserver', /\bMutationObserver\b/],
    ['matchMedia', /\bmatchMedia\b/],
    ['fetch', /\bfetch\s*\(/]
  ].filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
  const unsafePatterns = [
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\s*\(/],
    ['document.write', /\bdocument\.write\s*\(/],
    ['innerHTML', /\binnerHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\s*\(/]
  ].filter(([, pattern]) => pattern.test(content)).map(([name]) => name);

  return {
    source_file: sourceFile,
    bytes: Buffer.byteLength(content),
    event_types: eventTypes,
    selectors,
    browser_apis: browserApis,
    external_urls: externalUrls,
    asset_references: extractAssetReferences(content),
    unsafe_patterns: unsafePatterns,
    risks: [
      ...unsafePatterns.map((name) => `Unsafe script pattern requires rewrite: ${name}`),
      ...externalUrls.map((url) => `External URL requires review: ${url}`)
    ]
  };
}

export function extractAssetReferences(content) {
  return unique([
    ...[...content.matchAll(/\b(?:src|href|poster|data-src|data-background|content)=["']([^"']+)["']/gi)].map((match) => match[1]),
    ...[...content.matchAll(/\bsrcset=["']([^"']+)["']/gi)].flatMap((match) => parseSrcset(match[1])),
    ...extractCssUrls(content)
  ].filter((ref) => ASSET_EXTENSIONS.test(stripRefQuery(ref))));
}

export function extractUrls(content) {
  return unique([...content.matchAll(/https?:\/\/[^"')\s<>]+/gi)].map((match) => match[0].replace(/[.,;]+$/, '')));
}

export function isExternalRef(ref) {
  return /^(https?:)?\/\//i.test(ref) || /^(mailto|tel|data|blob):/i.test(ref);
}

export async function findMissingLocalAssets(root, sourceFile, references) {
  const missing = [];
  const base = path.dirname(path.join(root, sourceFile));
  for (const ref of references) {
    if (!ref || isExternalRef(ref) || ref.startsWith('#') || path.isAbsolute(ref)) continue;
    const cleanRef = stripRefQuery(ref);
    const candidates = [
      path.resolve(base, cleanRef),
      path.resolve(root, cleanRef.replace(/^\.\//, '')),
      path.resolve(root, cleanRef.replace(/^\//, ''))
    ];
    let found = false;
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push({ source_file: sourceFile, reference: ref });
    }
  }
  return missing;
}

export function splitClasses(value = '') {
  return String(value).split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

export function stripRefQuery(ref) {
  return String(ref).split(/[?#]/)[0];
}

export function cleanText(value = '') {
  return decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
}

export function extractTags(html) {
  const tags = [];
  const tagPattern = /<\s*([a-zA-Z][\w:-]*)(\s[^<>]*?)?(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const name = match[1].toLowerCase();
    if (name.startsWith('!')) continue;
    tags.push({
      name,
      attributes: parseAttributes(match[2] || ''),
      self_closing: Boolean(match[3]) || VOID_TAGS.has(name),
      index: match.index
    });
  }
  return tags;
}

export function parseAttributes(rawAttributes) {
  const attributes = {};
  const attrPattern = /([:@a-zA-Z_][:@\w.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(rawAttributes)) !== null) {
    const name = match[1];
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function extractPairedTagText(html, tagPattern) {
  const source = tagPattern.source.replace(/^\^|\$$/g, '');
  const pattern = new RegExp(`<(${source})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const entries = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    entries.push({
      tag: match[1].toLowerCase(),
      attributes: parseAttributes(match[2] || ''),
      innerHtml: match[3],
      text: match[3]
    });
  }
  return entries;
}

function extractTextBlocks(html) {
  return TEXT_TAGS.flatMap((tag) =>
    extractPairedTagText(html, new RegExp(`^${tag}$`, 'i')).map((entry) => ({
      tag,
      text: cleanText(entry.text),
      attributes: entry.attributes,
      field_hint: extractFieldHint(entry.attributes)
    }))
  ).filter((entry) => entry.text);
}

function extractScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((match) => {
    const attributes = parseAttributes(match[1] || '');
    return {
      src: attributes.src || null,
      type: attributes.type || null,
      async: Object.hasOwn(attributes, 'async'),
      defer: Object.hasOwn(attributes, 'defer'),
      inline: !attributes.src,
      bytes: Buffer.byteLength(match[2] || '')
    };
  });
}

function extractInlineHandlers(tags) {
  return tags.flatMap((tag) =>
    Object.keys(tag.attributes)
      .filter((name) => /^on[a-z]+$/i.test(name))
      .map((name) => ({ tag: tag.name, attribute: name }))
  );
}

function extractFormControls(html) {
  const labelByFor = new Map(extractPairedTagText(html, /^label$/i)
    .filter((entry) => entry.attributes.for)
    .map((entry) => [entry.attributes.for, cleanText(entry.text)]));
  const controls = [];
  const push = (tag, attributes, innerHtml = '') => {
    controls.push({
      tag,
      name: attributes.name || '',
      type: tag === 'input' ? attributes.type || 'text' : tag,
      required: Object.hasOwn(attributes, 'required'),
      checked: Object.hasOwn(attributes, 'checked'),
      id: attributes.id || null,
      field_hint: extractFieldHint(attributes),
      label: labelByFor.get(attributes.id) || attributes['aria-label'] || attributes.placeholder || attributes.name || '',
      placeholder: attributes.placeholder || null,
      value: attributes.value || null,
      options: tag === 'select'
        ? extractPairedTagText(innerHtml, /^option$/i).map((option) => ({
          label: cleanText(option.text),
          value: option.attributes.value || cleanText(option.text)
        }))
        : []
    });
  };

  for (const tag of extractTags(html).filter((entry) => entry.name === 'input')) {
    push('input', tag.attributes);
  }
  for (const entry of extractPairedTagText(html, /^select$/i)) {
    push('select', entry.attributes, entry.innerHtml);
  }
  for (const entry of extractPairedTagText(html, /^textarea$/i)) {
    push('textarea', entry.attributes, entry.innerHtml);
  }
  for (const entry of extractPairedTagText(html, /^button$/i)) {
    push('button', entry.attributes, entry.innerHtml);
  }
  return controls;
}

function extractFieldHint(attributes) {
  return attributes['data-hts-field'] ||
    attributes['data-storyblok-field'] ||
    attributes['data-sb-field'] ||
    attributes['data-field'] ||
    attributes.itemprop ||
    null;
}

function inferRepeatedHtmlCandidates(tags) {
  const classCounts = countBy(tags.flatMap((tag) => splitClasses(tag.attributes.class)));
  return Object.entries(classCounts)
    .filter(([className, count]) => count > 1 && /(card|item|grid|tile|slide|feature|product|testimonial|row|col)/i.test(className))
    .map(([className, count]) => ({ class_name: className, count }));
}

function inferHtmlAccessibilityIssues({ images, links, forms, headings, sourceFile }) {
  const issues = [];
  for (const image of images) {
    if (image.alt === null) {
      issues.push({ file: sourceFile, issue: 'Image without explicit alt attribute', reference: image.src });
    }
  }
  for (const link of links) {
    if (!link.text && !link.href.startsWith('#')) {
      issues.push({ file: sourceFile, issue: 'Link without discernible text', reference: link.href });
    }
    if (link.target === '_blank') {
      issues.push({ file: sourceFile, issue: 'New-tab link requires rel safety review', reference: link.href });
    }
  }
  for (const form of forms) {
    if (form.inputs.some((input) => input.tag !== 'button' && !input.name)) {
      issues.push({ file: sourceFile, issue: 'Form input without name attribute', reference: form.action || sourceFile });
    }
  }
  if (headings.length > 0 && headings[0].level !== 1) {
    issues.push({ file: sourceFile, issue: 'First heading is not h1', reference: headings[0].text });
  }
  return issues;
}

function inferHtmlRisks({ scripts, inlineHandlers, externalUrls, forms }) {
  const risks = [];
  if (scripts.some((script) => script.inline)) risks.push('Inline scripts require isolation or rewrite');
  scripts.filter((script) => script.src && isExternalRef(script.src)).forEach((script) => risks.push(`External script requires review: ${script.src}`));
  if (inlineHandlers.length > 0) risks.push('Inline event handlers require isolation or rewrite');
  externalUrls.forEach((url) => risks.push(`External URL requires review: ${url}`));
  forms.filter((form) => form.action && isExternalRef(form.action)).forEach((form) => risks.push(`External form endpoint requires approval: ${form.action}`));
  return risks;
}

function extractCssSelectors(css) {
  const selectors = [];
  const pattern = /([^{}]+)\{/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@') || selector.includes('%')) continue;
    selectors.push(...selector.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return unique(selectors);
}

function extractCssUrls(css) {
  return unique([...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((match) => match[2]).filter(Boolean));
}

function isGlobalSelector(selector) {
  const trimmed = selector.trim();
  if (trimmed === '*' || trimmed === ':root' || /^(html|body)\b/i.test(trimmed)) return true;
  if (/^[a-z][a-z0-9-]*(?:\s|$|:|>|\+|~)/i.test(trimmed) && !/[.#[:]/.test(trimmed.split(/\s|>|\+|~/)[0])) return true;
  return false;
}

function parseSrcset(value) {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function cleanCssValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function isThirdPartyUrl(url) {
  try {
    const parsed = new URL(url);
    return !THIRD_PARTY_HOST_ALLOWLIST.has(parsed.hostname);
  } catch {
    return true;
  }
}

function stripTags(value) {
  return String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ');
}

function stripCssComments(value) {
  return String(value).replace(/\/\*[\s\S]*?\*\//g, '');
}

function decodeEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function countBy(values) {
  const counts = {};
  for (const value of values.filter(Boolean)) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function firstMatch(value, pattern) {
  const match = String(value).match(pattern);
  return match ? match[1].trim() : '';
}
