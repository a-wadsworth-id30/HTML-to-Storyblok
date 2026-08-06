import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchemaPlan } from '../src/schema-generator.js';

test('buildSchemaPlan infers richer nested schemas from complex template facts', () => {
  const plan = buildSchemaPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1',
    templatePath: 'templates/acme-homepage',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Acme Homepage',
          landmarks: {
            header: 1,
            nav: 0,
            footer: 1
          },
          classes: ['hero', 'feature-card', 'feature-card', 'testimonial-card'],
          headings: [{ level: 1, text: 'Welcome to Acme' }],
          text_blocks: [
            { tag: 'p', text: 'Intro copy for the page.' },
            { tag: 'p', text: 'Feature one copy.' },
            { tag: 'p', text: 'Feature two copy.' },
            { tag: 'blockquote', text: 'A useful quote from a customer.' }
          ],
          repeated_candidates: [
            { class_name: 'feature-card', count: 2 },
            { class_name: 'testimonial-card', count: 2 }
          ],
          images: [
            { src: 'hero.jpg', alt: 'Hero' },
            { src: 'gallery-1.jpg', alt: 'Gallery one' },
            { src: 'gallery-2.jpg', alt: 'Gallery two' }
          ],
          links: [
            { href: '/contact', text: 'Contact' },
            { href: '/pricing', text: 'Pricing' }
          ],
          forms: [
            {
              action: 'https://forms.example.com/acme',
              method: 'post',
              inputs: [
                {
                  tag: 'input',
                  name: 'email',
                  type: 'email',
                  label: 'Email',
                  placeholder: 'you@example.com',
                  required: true,
                  options: []
                },
                {
                  tag: 'select',
                  name: 'plan',
                  type: 'select',
                  label: 'Plan',
                  required: false,
                  options: [
                    { label: 'Starter', value: 'starter' },
                    { label: 'Pro', value: 'pro' }
                  ]
                }
              ]
            }
          ]
        }
      ],
      asset_inventory: []
    }
  });

  const componentNames = plan.components.map((component) => component.technical_name);
  assert.ok(componentNames.includes('hts_acme_homepage_v1_gallery'));
  assert.ok(componentNames.includes('hts_acme_homepage_v1_media_item'));
  assert.ok(componentNames.includes('hts_acme_homepage_v1_form_field'));
  assert.ok(componentNames.includes('hts_acme_homepage_v1_testimonial_item'));

  const root = plan.components.find((component) => component.technical_name === 'hts_acme_homepage_v1_template_page');
  assert.ok(root.schema.body.component_whitelist.includes('hts_acme_homepage_v1_gallery'));
  assert.ok(!root.schema.body.component_whitelist.includes('hts_acme_homepage_v1_media_item'));

  const form = plan.components.find((component) => component.technical_name === 'hts_acme_homepage_v1_form');
  assert.deepEqual(form.schema.fields.component_whitelist, ['hts_acme_homepage_v1_form_field']);
  assert.equal(form.schema.body.type, 'richtext');

  const draftForm = plan.draft_story.content.body.find((block) => block.component === 'hts_acme_homepage_v1_form');
  assert.equal(draftForm.fields.length, 2);
  assert.equal(draftForm.fields[0].input_type, 'email');
  assert.equal(draftForm.fields[0].required, true);
  assert.equal(draftForm.fields[1].options, 'Starter\nPro');

  const gallery = plan.draft_story.content.body.find((block) => block.component === 'hts_acme_homepage_v1_gallery');
  assert.equal(gallery.items.length, 3);
  assert.equal(gallery.items[0].component, 'hts_acme_homepage_v1_media_item');
});

test('buildSchemaPlan infers bespoke editorial patterns without exposing child items at root', () => {
  const plan = buildSchemaPlan({
    integrationId: 'summit-template-v1',
    storyblokPrefix: 'hts_summit_template_v1_',
    repositoryNamespace: 'src/integrations/summit-template-v1',
    templatePath: 'templates/summit-template',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Summit',
          landmarks: {
            header: 0,
            nav: 0,
            footer: 0
          },
          tag_counts: {
            details: 2
          },
          classes: ['stats-grid', 'pricing-card', 'timeline-step', 'team-profile', 'faq-accordion'],
          headings: [{ level: 1, text: 'Summit' }],
          text_blocks: [
            { tag: 'p', text: '95% customer satisfaction' },
            { tag: 'p', text: 'Starter' },
            { tag: 'p', text: '$49 / month' },
            { tag: 'p', text: 'Best for small teams' },
            { tag: 'p', text: 'Step 1. Choose your plan' },
            { tag: 'p', text: 'How does billing work?' },
            { tag: 'p', text: 'Billing is monthly and can be cancelled.' },
            { tag: 'p', text: 'Ada Lovelace' },
            { tag: 'p', text: 'Technical Director' },
            { tag: 'p', text: 'Ada leads the technical programme.' }
          ],
          repeated_candidates: [
            { class_name: 'pricing-card', count: 3 }
          ],
          images: [
            { src: 'ada.jpg', alt: 'Ada Lovelace' },
            { src: 'team-2.jpg', alt: 'Team member' }
          ],
          links: [
            { href: '/buy', text: 'Buy now' },
            { href: '/ada', text: 'Ada profile' }
          ],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  const names = plan.components.map((component) => component.technical_name);
  assert.ok(names.includes('hts_summit_template_v1_stats_grid'));
  assert.ok(names.includes('hts_summit_template_v1_pricing_table'));
  assert.ok(names.includes('hts_summit_template_v1_steps'));
  assert.ok(names.includes('hts_summit_template_v1_faq_list'));
  assert.ok(names.includes('hts_summit_template_v1_team_grid'));

  const rootWhitelist = plan.components.find((component) =>
    component.technical_name === 'hts_summit_template_v1_template_page'
  ).schema.body.component_whitelist;
  assert.ok(rootWhitelist.includes('hts_summit_template_v1_pricing_table'));
  assert.ok(!rootWhitelist.includes('hts_summit_template_v1_pricing_plan'));
  assert.ok(!rootWhitelist.includes('hts_summit_template_v1_faq_item'));
  assert.ok(!rootWhitelist.includes('hts_summit_template_v1_team_member'));

  const stats = plan.draft_story.content.body.find((block) => block.component === 'hts_summit_template_v1_stats_grid');
  const pricing = plan.draft_story.content.body.find((block) => block.component === 'hts_summit_template_v1_pricing_table');
  const faq = plan.draft_story.content.body.find((block) => block.component === 'hts_summit_template_v1_faq_list');
  const team = plan.draft_story.content.body.find((block) => block.component === 'hts_summit_template_v1_team_grid');

  assert.equal(stats.items[0].value, '95%');
  assert.equal(pricing.plans[0].price, '$49 / month');
  assert.equal(faq.items[0].question, 'How does billing work?');
  assert.equal(team.members[0].name, 'Ada Lovelace');
});
