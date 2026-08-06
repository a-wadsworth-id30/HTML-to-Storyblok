import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceCss } from '../src/css-isolation.js';

test('namespaceCss scopes selectors while preserving import at-rules and keyframes', () => {
  const css = [
    "@import './base.css';",
    'body { margin: 0; }',
    '.hero, #headline { animation: fade 1s ease; }',
    '@media (min-width: 48rem) {',
    '  .hero h1 { font-size: 4rem; }',
    '}',
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }'
  ].join('\n');

  const scoped = namespaceCss(css, 'acme-homepage-v1');

  assert.match(scoped, /@import '\.\/base\.css';/);
  assert.match(scoped, /\.hts-acme-homepage-v1-root \{/);
  assert.match(scoped, /\.hts-acme-homepage-v1-root \.hts-acme-homepage-v1-hero/);
  assert.match(scoped, /#hts-acme-homepage-v1-headline/);
  assert.match(scoped, /hts-acme-homepage-v1-fade/);
});
