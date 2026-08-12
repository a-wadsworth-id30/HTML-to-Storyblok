import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeHtml } from '../src/analyzer.js';

test('analyzeHtml exposes explicit editorial field hints from template attributes', () => {
  const facts = analyzeHtml(`
    <section>
      <h2 data-hts-field="service_title">Managed imports</h2>
      <p data-storyblok-field="service_intro">Launch without overwrites.</p>
      <img src="service.jpg" alt="Service" data-sb-field="service_image">
      <a href="/book" data-field="booking_link">Book now</a>
      <form>
        <input name="email" type="email" data-hts-field="lead_email" required>
        <input name="newsletter" type="checkbox" data-storyblok-field="newsletter_opt_in" checked>
      </form>
    </section>
  `);

  assert.equal(facts.text_blocks.find((block) => block.text === 'Managed imports').field_hint, 'service_title');
  assert.equal(facts.text_blocks.find((block) => block.text === 'Launch without overwrites.').field_hint, 'service_intro');
  assert.equal(facts.images[0].field_hint, 'service_image');
  assert.equal(facts.links[0].field_hint, 'booking_link');
  assert.equal(facts.forms[0].inputs[0].field_hint, 'lead_email');
  assert.equal(facts.forms[0].inputs[1].field_hint, 'newsletter_opt_in');
  assert.equal(facts.forms[0].inputs[1].checked, true);
});

test('analyzeHtml extracts route SEO metadata from head tags', () => {
  const facts = analyzeHtml(`
    <!doctype html>
    <html>
      <head>
        <title>Launch &amp; Convert</title>
        <meta name="description" content="Import landing pages into Storyblok safely.">
        <link rel="canonical" href="https://example.com/imports">
        <meta name="robots" content="noindex,nofollow">
        <meta property="og:title" content="Open Graph Launch">
        <meta property="og:description" content="OG description.">
        <meta property="og:image" content="https://example.com/og.jpg">
        <meta property="og:type" content="website">
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="Twitter Launch">
        <meta name="twitter:description" content="Twitter description.">
        <meta name="twitter:image" content="https://example.com/twitter.jpg">
      </head>
    </html>
  `);

  assert.equal(facts.title, 'Launch & Convert');
  assert.equal(facts.description, 'Import landing pages into Storyblok safely.');
  assert.deepEqual(facts.seo, {
    title: 'Launch & Convert',
    description: 'Import landing pages into Storyblok safely.',
    canonical_url: 'https://example.com/imports',
    robots: 'noindex,nofollow',
    open_graph: {
      title: 'Open Graph Launch',
      description: 'OG description.',
      image: 'https://example.com/og.jpg',
      type: 'website',
      url: ''
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Twitter Launch',
      description: 'Twitter description.',
      image: 'https://example.com/twitter.jpg'
    }
  });
});
