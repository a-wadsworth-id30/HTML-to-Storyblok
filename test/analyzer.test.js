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
