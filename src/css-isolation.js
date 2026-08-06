import { unique } from './utils.js';

export function namespaceCss(css, integrationId) {
  const keyframeNames = unique([...String(css || '').matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g)].map((match) => match[1]));
  let rewritten = String(css || '');
  for (const name of keyframeNames) {
    rewritten = rewritten.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), `hts-${integrationId}-${name}`);
  }
  return scopeCssRules(rewritten, integrationId).trimEnd();
}

export function scopeCssRules(css, integrationId) {
  let output = '';
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    const semicolon = css.indexOf(';', index);
    if (semicolon !== -1 && (open === -1 || semicolon < open)) {
      const statement = css.slice(index, semicolon + 1);
      if (isSemicolonAtRule(statement)) {
        output += statement;
        index = semicolon + 1;
        continue;
      }
    }
    if (open === -1) {
      output += css.slice(index);
      break;
    }
    const prelude = css.slice(index, open).trim();
    const close = findMatchingBrace(css, open);
    if (close === -1) {
      output += css.slice(index);
      break;
    }
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@container') || prelude.startsWith('@layer')) {
      output += `${prelude} {\n${scopeCssRules(body, integrationId)}\n}\n`;
    } else if (prelude.startsWith('@')) {
      output += `${prelude} {${body}}\n`;
    } else {
      output += `${scopeSelectorList(prelude, integrationId)} {${body}}\n`;
    }
    index = close + 1;
  }
  return output;
}

function isSemicolonAtRule(statement) {
  return /^@(?:charset|import|namespace)\b/i.test(statement.trim());
}

function findMatchingBrace(value, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function scopeSelectorList(selectorList, integrationId) {
  const root = `.hts-${integrationId}-root`;
  return selectorList
    .split(',')
    .map((selector) => scopeSelector(selector.trim(), integrationId, root))
    .join(', ');
}

function scopeSelector(selector, integrationId, root) {
  if (!selector) return selector;
  let rewritten = selector
    .replace(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g, (_match, className) => {
      if (className.startsWith(`hts-${integrationId}-`)) return `.${className}`;
      return `.hts-${integrationId}-${className}`;
    })
    .replace(/#(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g, (_match, id) => {
      if (id.startsWith(`hts-${integrationId}-`)) return `#${id}`;
      return `#hts-${integrationId}-${id}`;
    });
  rewritten = rewritten.replace(/^html\b|^body\b|^:root\b/, root);
  if (rewritten.startsWith(root)) return rewritten;
  return `${root} ${rewritten}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
