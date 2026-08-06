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

test('buildSchemaPlan seeds draft assets by block role instead of leaking the first image everywhere', () => {
  const plan = buildSchemaPlan({
    integrationId: 'acme-campaign-v1',
    storyblokPrefix: 'hts_acme_campaign_v1_',
    repositoryNamespace: 'src/integrations/acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Acme Campaign',
          landmarks: {
            header: 1,
            nav: 1,
            footer: 1
          },
          tag_counts: {},
          classes: ['hero', 'feature-card', 'feature-card', 'pricing-card'],
          headings: [{ level: 1, text: 'Turn a static campaign page into editable Storyblok content.' }],
          text_blocks: [
            { tag: 'p', text: 'Launch copy.' },
            { tag: 'p', text: 'Feature one.' },
            { tag: 'p', text: 'Feature two.' },
            { tag: 'p', text: '$49 / month' }
          ],
          repeated_candidates: [
            { class_name: 'feature-card', count: 2 },
            { class_name: 'pricing-card', count: 2 }
          ],
          images: [
            { src: './assets/logo.svg', alt: 'Acme Studio logo' },
            { src: './assets/hero.svg', alt: 'Dashboard preview for campaign import' },
            { src: './assets/card-import.svg', alt: '' }
          ],
          links: [
            { href: '/', text: 'Acme Studio' },
            { href: '#features', text: 'Features' },
            { href: '/book-demo', text: 'Book demo' }
          ],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  const body = plan.draft_story.content.body;
  const header = body.find((block) => block.component === 'hts_acme_campaign_v1_header');
  const navigation = body.find((block) => block.component === 'hts_acme_campaign_v1_navigation');
  const hero = body.find((block) => block.component === 'hts_acme_campaign_v1_hero');
  const featureGrid = body.find((block) => block.component === 'hts_acme_campaign_v1_feature_grid');
  const gallery = body.find((block) => block.component === 'hts_acme_campaign_v1_gallery');
  const pricing = body.find((block) => block.component === 'hts_acme_campaign_v1_pricing_table');
  const footer = body.find((block) => block.component === 'hts_acme_campaign_v1_footer');

  assert.equal(header.logo.filename, './assets/logo.svg');
  assert.equal(Object.hasOwn(header, 'image'), false);
  assert.equal(Object.hasOwn(navigation, 'image'), false);
  assert.equal(Object.hasOwn(navigation, 'body'), false);
  assert.equal(hero.image.filename, './assets/hero.svg');
  assert.equal(hero.cta_label, 'Book demo');
  assert.equal(featureGrid.items[0].image.filename, './assets/hero.svg');
  assert.equal(Object.hasOwn(featureGrid, 'image'), false);
  assert.equal(gallery.items[0].image.filename, './assets/hero.svg');
  assert.equal(Object.hasOwn(pricing, 'image'), false);
  assert.equal(Object.hasOwn(pricing, 'body'), false);
  assert.equal(Object.hasOwn(footer, 'image'), false);
});

test('buildSchemaPlan uses index.html as the primary draft page when templates contain multiple routes', () => {
  const plan = buildSchemaPlan({
    integrationId: 'multi-route-v1',
    storyblokPrefix: 'hts_multi_route_v1_',
    repositoryNamespace: 'src/integrations/multi-route-v1',
    templatePath: 'templates/multi-route',
    inventory: {
      page_inventory: [
        {
          page: 'about.html',
          title: 'About',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [{ level: 1, text: 'About page' }],
          text_blocks: [],
          repeated_candidates: [],
          images: [],
          links: [],
          forms: []
        },
        {
          page: 'index.html',
          title: 'Home',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [{ level: 1, text: 'Home page' }],
          text_blocks: [],
          repeated_candidates: [],
          images: [],
          links: [],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  assert.equal(plan.draft_story.content.headline, 'Home page');
  assert.deepEqual(plan.draft_stories.map((story) => story.slug), [
    'integration-preview/multi-route-v1/home',
    'integration-preview/multi-route-v1/about'
  ]);
  assert.equal(plan.draft_stories[0].source_page, 'index.html');
  assert.equal(plan.draft_stories[1].content.headline, 'About page');
  assert.equal(plan.components[0].source, 'index.html');
});

test('buildSchemaPlan resolves template route links to generated draft stories', () => {
  const plan = buildSchemaPlan({
    integrationId: 'multi-route-v1',
    storyblokPrefix: 'hts_multi_route_v1_',
    repositoryNamespace: 'src/integrations/multi-route-v1',
    templatePath: 'templates/multi-route',
    inventory: {
      page_inventory: [
        multiRoutePage('index.html', 'Home page', [
          { href: '/home', text: 'Home' },
          { href: '/about', text: 'About' },
          { href: '/services.html', text: 'Services' },
          { href: '/gallery#work', text: 'Gallery' },
          { href: '/contact', text: 'Contact', field_hint: 'primary_cta' },
          { href: '#features', text: 'Features' },
          { href: 'https://example.com', text: 'External' }
        ]),
        multiRoutePage('about.html', 'About page'),
        multiRoutePage('services.html', 'Services page'),
        multiRoutePage('gallery.html', 'Gallery page'),
        multiRoutePage('contact.html', 'Contact page')
      ],
      asset_inventory: []
    }
  });

  const homeStory = plan.draft_stories.find((story) => story.source_page === 'index.html');
  const navigation = homeStory.content.body.find((block) => block.component === 'hts_multi_route_v1_navigation');
  const linksByLabel = Object.fromEntries(navigation.items.map((item) => [item.label, item.link]));
  const contentSection = homeStory.content.body.find((block) => block.component === 'hts_multi_route_v1_content_section');

  assert.deepEqual(linksByLabel.Home, {
    linktype: 'story',
    cached_url: 'integration-preview/multi-route-v1/home'
  });
  assert.deepEqual(linksByLabel.About, {
    linktype: 'story',
    cached_url: 'integration-preview/multi-route-v1/about'
  });
  assert.deepEqual(linksByLabel.Services, {
    linktype: 'story',
    cached_url: 'integration-preview/multi-route-v1/services'
  });
  assert.deepEqual(linksByLabel.Gallery, {
    linktype: 'story',
    cached_url: 'integration-preview/multi-route-v1/gallery',
    anchor: 'work'
  });
  assert.deepEqual(linksByLabel.Features, {
    linktype: 'url',
    url: '#features'
  });
  assert.deepEqual(linksByLabel.External, {
    linktype: 'url',
    url: 'https://example.com'
  });
  assert.deepEqual(contentSection.primary_cta, {
    linktype: 'story',
    cached_url: 'integration-preview/multi-route-v1/contact'
  });
});

test('buildSchemaPlan applies route-specific draft story overrides to multi-page templates', () => {
  const plan = buildSchemaPlan({
    integrationId: 'multi-route-v1',
    storyblokPrefix: 'hts_multi_route_v1_',
    repositoryNamespace: 'src/integrations/multi-route-v1',
    templatePath: 'templates/multi-route',
    schemaOverrides: {
      draft_stories: {
        about: {
          name: 'About Preview',
          headline: 'About Override'
        },
        'index.html': {
          headline: 'Home Override'
        }
      }
    },
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Home',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [{ level: 1, text: 'Home page' }],
          text_blocks: [],
          repeated_candidates: [],
          images: [],
          links: [],
          forms: []
        },
        {
          page: 'about.html',
          title: 'About',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [{ level: 1, text: 'About page' }],
          text_blocks: [],
          repeated_candidates: [],
          images: [],
          links: [],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  assert.equal(plan.draft_stories[0].content.headline, 'Home Override');
  assert.equal(plan.draft_stories[1].name, 'About Preview');
  assert.equal(plan.draft_stories[1].content.headline, 'About Override');
  assert.equal(plan.schema_overrides.draft_stories.length, 2);
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

test('buildSchemaPlan converts explicit field hints into namespaced content fields and draft values', () => {
  const plan = buildSchemaPlan({
    integrationId: 'service-template-v1',
    storyblokPrefix: 'hts_service_template_v1_',
    repositoryNamespace: 'src/integrations/service-template-v1',
    templatePath: 'templates/service-template',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Service',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [
            { level: 1, text: 'Service', field_hint: 'service_title' }
          ],
          text_blocks: [
            { tag: 'h1', text: 'Service', field_hint: 'service_title' },
            { tag: 'p', text: 'A complete managed import service.', field_hint: 'service_intro' }
          ],
          repeated_candidates: [],
          images: [
            { src: 'service.jpg', alt: 'Service', field_hint: 'service_image' }
          ],
          links: [
            { href: '/book', text: 'Book now', field_hint: 'booking_link' }
          ],
          forms: [
            {
              inputs: [
                { tag: 'input', type: 'email', name: 'email', value: 'team@example.com', field_hint: 'lead_email' },
                { tag: 'input', type: 'checkbox', name: 'newsletter', checked: true, field_hint: 'newsletter_opt_in' },
                {
                  tag: 'select',
                  type: 'select',
                  name: 'plan',
                  field_hint: 'preferred_plan',
                  options: [
                    { label: 'Starter', value: 'starter' },
                    { label: 'Scale', value: 'scale' }
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

  const section = plan.components.find((component) => component.technical_name === 'hts_service_template_v1_content_section');

  assert.equal(section.schema.service_title.type, 'text');
  assert.equal(section.schema.service_intro.type, 'richtext');
  assert.equal(section.schema.service_image.type, 'asset');
  assert.equal(section.schema.booking_link.type, 'multilink');
  assert.equal(section.schema.lead_email.type, 'text');
  assert.equal(section.schema.newsletter_opt_in.type, 'boolean');
  assert.equal(section.schema.preferred_plan.type, 'option');
  assert.deepEqual(section.schema.preferred_plan.options.map((option) => option.value), ['starter', 'scale']);

  const draftSection = plan.draft_story.content.body.find((block) => block.component === 'hts_service_template_v1_content_section');
  assert.equal(draftSection.service_title, 'Service');
  assert.equal(draftSection.service_intro.content[0].content[0].text, 'A complete managed import service.');
  assert.equal(draftSection.service_image.filename, 'service.jpg');
  assert.equal(draftSection.booking_link.cached_url, 'book');
  assert.equal(draftSection.lead_email, 'team@example.com');
  assert.equal(draftSection.newsletter_opt_in, true);
  assert.equal(draftSection.preferred_plan, 'starter');
});

test('buildSchemaPlan applies additive schema overrides with namespaced nested relationships', () => {
  const plan = buildSchemaPlan({
    integrationId: 'campaign-template-v1',
    storyblokPrefix: 'hts_campaign_template_v1_',
    repositoryNamespace: 'src/integrations/campaign-template-v1',
    templatePath: 'templates/campaign-template',
    schemaOverrides: {
      components: {
        hero: {
          display_name: 'Campaign Hero',
          preview_field: 'campaign_code',
          fields: {
            campaign_code: { type: 'text', description: 'CRM campaign code' },
            related_services: {
              type: 'options',
              source: 'stories',
              folder_slug: 'services/'
            },
            cards: {
              type: 'bloks',
              component_whitelist: ['feature_item'],
              maximum: 3
            },
            theme: {
              type: 'option',
              options: ['light', 'dark']
            }
          },
          draft: {
            campaign_code: 'summer-launch',
            cards: [
              {
                component: 'feature_item',
                headline: 'Managed migration'
              }
            ]
          }
        }
      },
      draft_story: {
        name: 'Campaign Import Preview',
        headline: 'Campaign Preview'
      }
    },
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Campaign',
          landmarks: {},
          tag_counts: {},
          classes: ['feature-card'],
          headings: [{ level: 1, text: 'Campaign' }],
          text_blocks: [
            { tag: 'p', text: 'Launch campaign copy.' },
            { tag: 'p', text: 'Feature one.' },
            { tag: 'p', text: 'Feature two.' },
            { tag: 'p', text: 'Feature three.' }
          ],
          repeated_candidates: [
            { class_name: 'feature-card', count: 3 }
          ],
          images: [
            { src: 'hero.jpg', alt: 'Hero' }
          ],
          links: [],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  const hero = plan.components.find((component) => component.technical_name === 'hts_campaign_template_v1_hero');
  assert.equal(hero.display_name, 'Campaign Hero');
  assert.equal(hero.preview_field, 'campaign_code');
  assert.equal(hero.schema.campaign_code.type, 'text');
  assert.equal(hero.schema.related_services.type, 'options');
  assert.equal(hero.schema.related_services.source, 'stories');
  assert.equal(hero.schema.cards.type, 'bloks');
  assert.equal(hero.schema.cards.restrict_components, true);
  assert.deepEqual(hero.schema.cards.component_whitelist, ['hts_campaign_template_v1_feature_item']);
  assert.deepEqual(hero.schema.theme.options.map((option) => option.value), ['light', 'dark']);

  const draftHero = plan.draft_story.content.body.find((block) => block.component === 'hts_campaign_template_v1_hero');
  assert.equal(draftHero.campaign_code, 'summer-launch');
  assert.equal(draftHero.cards[0].component, 'hts_campaign_template_v1_feature_item');
  assert.equal(plan.draft_story.name, 'Campaign Import Preview');
  assert.equal(plan.draft_story.content.headline, 'Campaign Preview');
  assert.equal(plan.schema_overrides.components[0].technical_name, 'hts_campaign_template_v1_hero');
});

test('buildSchemaPlan rejects unsafe schema override targets and draft story slugs', () => {
  const baseInput = {
    integrationId: 'campaign-template-v1',
    storyblokPrefix: 'hts_campaign_template_v1_',
    repositoryNamespace: 'src/integrations/campaign-template-v1',
    templatePath: 'templates/campaign-template',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Campaign',
          landmarks: {},
          tag_counts: {},
          classes: [],
          headings: [{ level: 1, text: 'Campaign' }],
          text_blocks: [],
          repeated_candidates: [],
          images: [],
          links: [],
          forms: []
        }
      ],
      asset_inventory: []
    }
  };

  assert.throws(
    () => buildSchemaPlan({
      ...baseInput,
      schemaOverrides: {
        components: {
          unknown_block: {
            fields: {
              title: 'text'
            }
          }
        }
      }
    }),
    /unknown generated component/
  );

  assert.throws(
    () => buildSchemaPlan({
      ...baseInput,
      schemaOverrides: {
        draft_story: {
          slug: 'landing-pages/campaign'
        }
      }
    }),
    /must remain inside integration-preview\/campaign-template-v1/
  );
});

test('buildSchemaPlan deduplicates shared nested components and repeated Storyblok asset sources', () => {
  const plan = buildSchemaPlan({
    integrationId: 'acme-campaign-v1',
    storyblokPrefix: 'hts_acme_campaign_v1_',
    repositoryNamespace: 'src/integrations/acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    inventory: {
      page_inventory: [
        {
          page: 'index.html',
          title: 'Acme Campaign',
          landmarks: {
            header: 1,
            nav: 1,
            footer: 0
          },
          tag_counts: {},
          classes: ['feature-card'],
          headings: [{ level: 1, text: 'Campaign' }],
          text_blocks: [
            { tag: 'p', text: 'Feature one.' },
            { tag: 'p', text: 'Feature two.' },
            { tag: 'p', text: 'Feature three.' },
            { tag: 'p', text: 'Feature four.' }
          ],
          repeated_candidates: [
            { class_name: 'feature-card', count: 4 }
          ],
          images: [
            { src: './assets/card.svg', alt: 'Card' },
            { src: './assets/card.svg', alt: 'Card duplicate' },
            { src: './assets/hero.svg', alt: 'Hero' }
          ],
          links: [
            { href: '/one', text: 'One' },
            { href: '/two', text: 'Two' },
            { href: '/three', text: 'Three' }
          ],
          forms: []
        }
      ],
      asset_inventory: []
    }
  });

  const componentNames = plan.components.map((component) => component.technical_name);
  const storyblokAssetFilenames = plan.storyblok_assets.map((asset) => asset.filename);

  assert.equal(componentNames.filter((name) => name === 'hts_acme_campaign_v1_navigation_item').length, 1);
  assert.deepEqual(storyblokAssetFilenames.sort(), ['acme-campaign-v1/card.svg', 'acme-campaign-v1/hero.svg']);
});

function multiRoutePage(page, headline, links = []) {
  return {
    page,
    title: headline,
    landmarks: {
      nav: links.length > 0 ? 1 : 0
    },
    tag_counts: {},
    classes: [],
    headings: [{ level: 1, text: headline }],
    text_blocks: [
      { tag: 'p', text: `${headline} content.` }
    ],
    repeated_candidates: [],
    images: [],
    links,
    forms: []
  };
}
