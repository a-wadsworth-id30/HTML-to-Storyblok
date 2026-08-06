import path from 'node:path';
import { ensureArray, sha256 } from './utils.js';

const OVERRIDE_FIELD_TYPES = new Set([
  'asset',
  'bloks',
  'boolean',
  'datetime',
  'markdown',
  'multiasset',
  'multilink',
  'number',
  'option',
  'options',
  'richtext',
  'table',
  'text',
  'textarea'
]);

export function buildSchemaPlan({ inventory, integrationId, storyblokPrefix, repositoryNamespace, templatePath, schemaOverrides = null }) {
  const pages = inventory.page_inventory || [];
  const primaryPage = pages[0] || {};
  const components = [];
  const blocks = [];
  const mapping = [];

  const rootName = `${storyblokPrefix}template_page`;
  const blockDefinitions = inferBlockDefinitions(primaryPage, inventory, storyblokPrefix);
  for (const definition of blockDefinitions) {
    const component = buildComponentForDefinition(definition, primaryPage, storyblokPrefix);
    components.push(component);
    if (component.component_type === 'nestable' && !definition.parent) blocks.push(component.technical_name);
    mapping.push({
      template_section: definition.label,
      new_framework_component: `Hts${pascalCase(integrationId)}${pascalCase(definition.key)}`,
      new_storyblok_component: component.technical_name,
      creation_method: 'Create from template',
      source_reference: definition.source_reference || primaryPage.page || null,
      style_scope: `.hts-${integrationId}-root`,
      behaviour_module: `${repositoryNamespace}/behaviour/${integrationId}.js`,
      assets: definition.assets || [],
      risk: definition.risk || 'None detected'
    });
  }

  components.unshift({
    technical_name: rootName,
    display_name: displayName(`${integrationId} template page`),
    component_type: 'content_type',
    schema: {
      headline: {
        type: 'text',
        translatable: true,
        description: 'Internal preview headline for this imported template page.'
      },
      body: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: blocks,
        description: 'Integration-owned page blocks. Only components from this import are allowed.'
      }
    },
    preview_field: 'headline',
    source: primaryPage.page || null
  });

  const plan = {
    root_component: rootName,
    components,
    draft_story: buildDraftStory({
      integrationId,
      rootName,
      primaryPage,
      blockDefinitions
    }),
    mapping,
    repository_assets: buildRepositoryAssetPlan({ inventory, templatePath, repositoryNamespace }),
    asset_folders: buildAssetFolderPlan({ inventory, integrationId }),
    storyblok_assets: buildStoryblokAssetPlan({ inventory, templatePath, integrationId })
  };
  return applySchemaOverrides(plan, schemaOverrides, { integrationId, storyblokPrefix });
}

function inferBlockDefinitions(primaryPage, inventory, storyblokPrefix) {
  const definitions = [];
  const add = (key, label, extra = {}) => {
    const technicalName = `${storyblokPrefix}${snakeCase(key)}`;
    if (definitions.some((definition) => definition.technical_name === technicalName)) return;
    definitions.push({
      key,
      label,
      technical_name: technicalName,
      ...extra
    });
  };

  const landmarks = primaryPage.landmarks || {};
  const images = primaryPage.images || [];
  const links = primaryPage.links || [];
  const forms = primaryPage.forms || [];
  const repeated = primaryPage.repeated_candidates || [];
  const textBlocks = primaryPage.text_blocks || [];
  const classNames = primaryPage.classes || [];
  const classText = classNames.join(' ');
  const tagCounts = primaryPage.tag_counts || {};
  const hasHero = (primaryPage.headings || []).some((heading) => heading.level === 1) || images.length > 0;
  const hasFieldHints = collectExplicitFieldHints(primaryPage).length > 0;

  if (landmarks.header) {
    add('header', 'Header', {
      assets: images.slice(0, 1).map((image) => image.src),
      nested_key: links.length > 0 ? 'navigation_item' : undefined
    });
  }
  if (landmarks.nav || links.length >= 3) add('navigation', 'Navigation', { nested_key: 'navigation_item', links: links.slice(0, 12) });
  if (hasHero) add('hero', 'Hero', { assets: images.slice(0, 1).map((image) => image.src) });
  if (repeated.some((item) => /grid|card|item|feature|tile|product/i.test(item.class_name)) || textBlocks.length >= 4) {
    add('feature_grid', 'Repeated content grid', { nested_key: 'feature_item', source_candidates: repeated });
  }
  if (images.length >= 3) add('gallery', 'Media gallery', { nested_key: 'media_item', assets: images.map((image) => image.src) });
  if (hasStatsPattern(textBlocks, classText)) add('stats_grid', 'Stats grid', { nested_key: 'stat_item' });
  if (hasPricingPattern(textBlocks, classText, repeated)) add('pricing_table', 'Pricing table', { nested_key: 'pricing_plan' });
  if (hasStepsPattern(textBlocks, classText)) add('steps', 'Steps', { nested_key: 'step_item' });
  if (hasFaqPattern(textBlocks, classText, tagCounts)) add('faq_list', 'FAQ list', { nested_key: 'faq_item' });
  if (hasTeamPattern(textBlocks, classText, images)) add('team_grid', 'Team grid', { nested_key: 'team_member' });
  if (textBlocks.some((block) => block.tag === 'blockquote') || classNames.some((className) => /testimonial|quote|review/i.test(className))) {
    add('testimonial_list', 'Testimonials', { nested_key: 'testimonial_item' });
  }
  if (links.filter((link) => link.href && !link.href.startsWith('#')).length >= 2 && !landmarks.nav) {
    add('cta_group', 'Call-to-action group', { nested_key: 'cta_item' });
  }
  if (textBlocks.length > 0 || hasFieldHints) add('content_section', 'Content section', { field_hints: hasFieldHints });
  if (forms.length > 0) add('form', 'Form', { nested_key: 'form_field', risk: 'External form behaviour requires endpoint review' });
  if (landmarks.footer) add('footer', 'Footer');
  if (definitions.length === 0) add('section', 'Template section', { field_hints: hasFieldHints });

  const nested = [];
  for (const definition of definitions) {
    if (definition.nested_key) {
      nested.push({
        key: definition.nested_key,
        label: displayName(definition.nested_key),
        technical_name: `${storyblokPrefix}${snakeCase(definition.nested_key)}`,
        parent: definition.key
      });
    }
  }
  return [...definitions, ...nested];
}

function buildComponentForDefinition(definition, primaryPage, storyblokPrefix) {
  if (definition.key === 'header') {
    return nestableComponent(definition, {
      headline: textField('Header headline'),
      logo: assetField('Optional header logo'),
      links: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}navigation_item`],
        maximum: 12,
        description: 'Optional integration-owned header links.'
      }
    });
  }
  if (definition.key === 'navigation') {
    return nestableComponent(definition, {
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}navigation_item`],
        maximum: 20,
        description: 'Integration-owned navigation links.'
      }
    });
  }
  if (definition.key === 'navigation_item') {
    return nestableComponent(definition, {
      label: textField('Navigation label'),
      link: linkField('Navigation link')
    });
  }
  if (definition.key === 'feature_grid') {
    return nestableComponent(definition, {
      headline: textField('Grid headline'),
      intro: richtextField('Grid introduction'),
      layout: optionField('Grid layout', ['grid', 'carousel', 'stack']),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}feature_item`],
        maximum: 24,
        description: 'Integration-owned repeated grid items.'
      }
    });
  }
  if (definition.key === 'feature_item') {
    return nestableComponent(definition, {
      headline: textField('Item headline'),
      body: richtextField('Item body copy'),
      image: assetField('Optional item image'),
      link: linkField('Optional item link')
    });
  }
  if (definition.key === 'gallery') {
    return nestableComponent(definition, {
      headline: textField('Gallery headline'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}media_item`],
        maximum: 48,
        description: 'Integration-owned media items.'
      }
    });
  }
  if (definition.key === 'media_item') {
    return nestableComponent(definition, {
      image: assetField('Media asset'),
      alt: textField('Alternative text'),
      caption: textareaField('Optional caption')
    });
  }
  if (definition.key === 'testimonial_list') {
    return nestableComponent(definition, {
      headline: textField('Testimonials headline'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}testimonial_item`],
        maximum: 24,
        description: 'Integration-owned testimonials.'
      }
    });
  }
  if (definition.key === 'testimonial_item') {
    return nestableComponent(definition, {
      quote: textareaField('Quote'),
      author: textField('Author'),
      role: textField('Role or attribution')
    });
  }
  if (definition.key === 'stats_grid') {
    return nestableComponent(definition, {
      headline: textField('Stats headline'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}stat_item`],
        maximum: 12,
        description: 'Integration-owned statistics.'
      }
    });
  }
  if (definition.key === 'stat_item') {
    return nestableComponent(definition, {
      value: textField('Statistic value'),
      label: textField('Statistic label'),
      description: textareaField('Optional statistic description')
    });
  }
  if (definition.key === 'pricing_table') {
    return nestableComponent(definition, {
      headline: textField('Pricing headline'),
      intro: richtextField('Pricing introduction'),
      plans: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}pricing_plan`],
        maximum: 12,
        description: 'Integration-owned pricing plans.'
      }
    });
  }
  if (definition.key === 'pricing_plan') {
    return nestableComponent(definition, {
      name: textField('Plan name'),
      price: textField('Price'),
      summary: textareaField('Plan summary'),
      features: textareaField('One feature per line'),
      cta_label: textField('CTA label'),
      cta_link: linkField('CTA link'),
      featured: booleanField('Featured plan')
    });
  }
  if (definition.key === 'steps') {
    return nestableComponent(definition, {
      headline: textField('Steps headline'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}step_item`],
        maximum: 16,
        description: 'Integration-owned process steps.'
      }
    });
  }
  if (definition.key === 'step_item') {
    return nestableComponent(definition, {
      step_number: textField('Step number'),
      headline: textField('Step headline'),
      body: richtextField('Step body copy')
    });
  }
  if (definition.key === 'faq_list') {
    return nestableComponent(definition, {
      headline: textField('FAQ headline'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}faq_item`],
        maximum: 40,
        description: 'Integration-owned frequently asked questions.'
      }
    });
  }
  if (definition.key === 'faq_item') {
    return nestableComponent(definition, {
      question: textField('Question'),
      answer: richtextField('Answer')
    });
  }
  if (definition.key === 'team_grid') {
    return nestableComponent(definition, {
      headline: textField('Team headline'),
      members: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}team_member`],
        maximum: 48,
        description: 'Integration-owned team members or profile cards.'
      }
    });
  }
  if (definition.key === 'team_member') {
    return nestableComponent(definition, {
      name: textField('Name'),
      role: textField('Role'),
      bio: richtextField('Biography'),
      image: assetField('Profile image'),
      link: linkField('Profile link')
    });
  }
  if (definition.key === 'cta_group') {
    return nestableComponent(definition, {
      headline: textField('CTA headline'),
      body: richtextField('CTA body copy'),
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}cta_item`],
        maximum: 8,
        description: 'Integration-owned calls to action.'
      }
    });
  }
  if (definition.key === 'cta_item') {
    return nestableComponent(definition, {
      label: textField('CTA label'),
      link: linkField('CTA link'),
      style: optionField('CTA style', ['primary', 'secondary', 'text'])
    });
  }
  if (definition.key === 'form') {
    return nestableComponent(definition, {
      headline: textField('Form headline'),
      body: richtextField('Form supporting copy'),
      fields: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}form_field`],
        maximum: 40,
        description: 'Integration-owned form field definitions.'
      },
      submit_label: textField('Submit button label'),
      endpoint_reference: {
        type: 'text',
        description: 'Reference name for the approved form endpoint. Do not store credentials here.'
      }
    });
  }
  if (definition.key === 'form_field') {
    return nestableComponent(definition, {
      label: textField('Field label'),
      name: textField('Field name'),
      input_type: optionField('Input type', ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'radio', 'hidden']),
      required: booleanField('Required field'),
      placeholder: textField('Placeholder'),
      options: textareaField('One select/radio option per line')
    });
  }
  return nestableComponent(definition, commonSectionSchema(primaryPage, definition));
}

function commonSectionSchema(primaryPage, definition = {}) {
  const schema = {
    headline: textField('Section headline'),
    body: richtextField('Section body copy')
  };
  if ((primaryPage.images || []).length > 0) schema.image = assetField('Section image');
  if ((primaryPage.links || []).length > 0) {
    schema.cta_label = textField('Call-to-action label');
    schema.cta_link = linkField('Call-to-action link');
  }
  if (definition.field_hints) {
    Object.assign(schema, explicitFieldHintSchema(primaryPage, schema));
  }
  return schema;
}

function nestableComponent(definition, schema) {
  return {
    technical_name: definition.technical_name,
    display_name: displayName(definition.label),
    component_type: 'nestable',
    schema,
    preview_field: schema.headline ? 'headline' : Object.keys(schema)[0],
    source: definition.source_reference || null
  };
}

function buildDraftStory({ integrationId, rootName, primaryPage, blockDefinitions }) {
  const blocks = blockDefinitions
    .filter((definition) => !definition.parent)
    .map((definition) => draftBlock(definition, primaryPage, integrationId));
  const title = primaryPage.headings?.[0]?.text || primaryPage.title || displayName(integrationId);
  return {
    name: `Integration Preview - ${displayName(integrationId)}`,
    slug: `integration-preview/${integrationId}`,
    component: rootName,
    status: 'draft',
    content: {
      component: rootName,
      headline: title,
      body: blocks
    }
  };
}

function draftBlock(definition, primaryPage, integrationId) {
  const title = primaryPage.headings?.[0]?.text || displayName(definition.label);
  const body = primaryPage.text_blocks?.find((block) => block.tag === 'p')?.text || '';
  const block = {
    _uid: stableUid(integrationId, definition.key),
    component: definition.technical_name,
    headline: title,
    body: richTextDocument(body)
  };
  const firstImage = primaryPage.images?.[0];
  if (firstImage) {
    block.image = {
      id: null,
      filename: firstImage.src,
      alt: firstImage.alt || ''
    };
  }
  const firstLink = primaryPage.links?.find((link) => link.href);
  if (firstLink) {
    block.cta_label = firstLink.text || 'Learn more';
    block.cta_link = toStoryblokLink(firstLink.href);
  }
  if (definition.key === 'navigation') {
    block.items = (primaryPage.links || []).slice(0, 12).map((link, index) => ({
      _uid: stableUid(integrationId, `navigation-item-${index}-${link.href}`),
      component: definition.technical_name.replace(/navigation$/, 'navigation_item'),
      label: link.text || link.href || `Item ${index + 1}`,
      link: toStoryblokLink(link.href)
    }));
  }
  if (definition.key === 'feature_grid') {
    const textBlocks = (primaryPage.text_blocks || []).filter((entry) => entry.text).slice(0, 6);
    block.items = textBlocks.map((entry, index) => ({
      _uid: stableUid(integrationId, `feature-item-${index}-${entry.text}`),
      component: definition.technical_name.replace(/feature_grid$/, 'feature_item'),
      headline: entry.text.slice(0, 80),
      body: richTextDocument(entry.text),
      image: draftImage(primaryPage.images?.[index])
    }));
  }
  if (definition.key === 'gallery') {
    block.items = (primaryPage.images || []).slice(0, 24).map((image, index) => ({
      _uid: stableUid(integrationId, `media-item-${index}-${image.src}`),
      component: definition.technical_name.replace(/gallery$/, 'media_item'),
      image: draftImage(image),
      alt: image.alt || '',
      caption: image.alt || ''
    }));
  }
  if (definition.key === 'testimonial_list') {
    block.items = (primaryPage.text_blocks || [])
      .filter((entry) => entry.tag === 'blockquote' || /testimonial|quote|review/i.test(entry.text))
      .slice(0, 12)
      .map((entry, index) => ({
        _uid: stableUid(integrationId, `testimonial-item-${index}-${entry.text}`),
        component: definition.technical_name.replace(/testimonial_list$/, 'testimonial_item'),
        quote: entry.text,
        author: '',
        role: ''
      }));
  }
  if (definition.key === 'stats_grid') {
    block.items = inferStats(primaryPage.text_blocks || []).slice(0, 12).map((stat, index) => ({
      _uid: stableUid(integrationId, `stat-item-${index}-${stat.value}-${stat.label}`),
      component: definition.technical_name.replace(/stats_grid$/, 'stat_item'),
      value: stat.value,
      label: stat.label,
      description: stat.description
    }));
  }
  if (definition.key === 'pricing_table') {
    const links = primaryPage.links || [];
    block.plans = inferPricingPlans(primaryPage.text_blocks || [], links).slice(0, 12).map((plan, index) => ({
      _uid: stableUid(integrationId, `pricing-plan-${index}-${plan.name}-${plan.price}`),
      component: definition.technical_name.replace(/pricing_table$/, 'pricing_plan'),
      name: plan.name,
      price: plan.price,
      summary: plan.summary,
      features: plan.features.join('\n'),
      cta_label: links[index]?.text || '',
      cta_link: links[index]?.href ? toStoryblokLink(links[index].href) : emptyStoryblokLink(),
      featured: index === 0
    }));
  }
  if (definition.key === 'steps') {
    block.items = inferSteps(primaryPage.text_blocks || []).slice(0, 16).map((step, index) => ({
      _uid: stableUid(integrationId, `step-item-${index}-${step.headline}`),
      component: definition.technical_name.replace(/steps$/, 'step_item'),
      step_number: String(index + 1),
      headline: step.headline,
      body: richTextDocument(step.body)
    }));
  }
  if (definition.key === 'faq_list') {
    block.items = inferFaqs(primaryPage.text_blocks || []).slice(0, 40).map((faq, index) => ({
      _uid: stableUid(integrationId, `faq-item-${index}-${faq.question}`),
      component: definition.technical_name.replace(/faq_list$/, 'faq_item'),
      question: faq.question,
      answer: richTextDocument(faq.answer)
    }));
  }
  if (definition.key === 'team_grid') {
    block.members = inferTeamMembers(primaryPage.text_blocks || [], primaryPage.images || [], primaryPage.links || []).slice(0, 48).map((member, index) => ({
      _uid: stableUid(integrationId, `team-member-${index}-${member.name}`),
      component: definition.technical_name.replace(/team_grid$/, 'team_member'),
      name: member.name,
      role: member.role,
      bio: richTextDocument(member.bio),
      image: draftImage(member.image),
      link: member.link ? toStoryblokLink(member.link.href) : emptyStoryblokLink()
    }));
  }
  if (definition.key === 'cta_group') {
    block.items = (primaryPage.links || [])
      .filter((link) => link.href && !link.href.startsWith('#'))
      .slice(0, 8)
      .map((link, index) => ({
        _uid: stableUid(integrationId, `cta-item-${index}-${link.href}`),
        component: definition.technical_name.replace(/cta_group$/, 'cta_item'),
        label: link.text || link.href || `CTA ${index + 1}`,
        link: toStoryblokLink(link.href),
        style: index === 0 ? 'primary' : 'secondary'
      }));
  }
  if (definition.key === 'form') {
    const form = primaryPage.forms?.[0];
    block.fields = (form?.inputs || [])
      .filter((input) => input.tag !== 'button')
      .map((input, index) => ({
        _uid: stableUid(integrationId, `form-field-${index}-${input.name || input.label}`),
        component: definition.technical_name.replace(/form$/, 'form_field'),
        label: input.label || input.name || `Field ${index + 1}`,
        name: input.name || `field_${index + 1}`,
        input_type: normalizeInputType(input),
        required: Boolean(input.required),
        placeholder: input.placeholder || '',
        options: (input.options || []).map((option) => option.label || option.value).filter(Boolean).join('\n')
      }));
    block.submit_label = 'Submit';
    block.endpoint_reference = form?.action && /^https?:\/\//i.test(form.action) ? 'external-endpoint-review-required' : '';
  }
  if (definition.key === 'header') {
    block.logo = draftImage(primaryPage.images?.[0]);
    block.links = (primaryPage.links || []).slice(0, 8).map((link, index) => ({
      _uid: stableUid(integrationId, `header-link-${index}-${link.href}`),
      component: definition.technical_name.replace(/header$/, 'navigation_item'),
      label: link.text || link.href || `Link ${index + 1}`,
      link: toStoryblokLink(link.href)
    }));
  }
  if (definition.field_hints) {
    Object.assign(block, draftExplicitFieldValues(primaryPage, block));
  }
  return block;
}

function buildRepositoryAssetPlan({ inventory, templatePath, repositoryNamespace }) {
  const root = templatePath ? path.resolve(templatePath) : null;
  return (inventory.asset_inventory || []).map((asset) => ({
    source_type: 'template',
    source_path: root ? toPosix(path.relative(process.cwd(), path.join(root, asset.file))) : asset.file,
    target_path: `${repositoryNamespace}/assets/${asset.file}`,
    bytes: asset.bytes,
    type: asset.type
  }));
}

function buildStoryblokAssetPlan({ inventory, templatePath, integrationId }) {
  const root = templatePath ? path.resolve(templatePath) : null;
  return (inventory.page_inventory || []).flatMap((page) => page.images || []).map((image) => {
    const clean = image.src ? image.src.replace(/^\.\//, '') : '';
    const absolute = root && clean ? path.resolve(root, clean) : clean;
    return {
      local_path: absolute,
      filename: `${integrationId}/${path.basename(clean || 'asset')}`,
      asset_folder_path: integrationId,
      alt: image.alt || '',
      source_ref: image.src,
      status: 'planned'
    };
  });
}

function buildAssetFolderPlan({ inventory, integrationId }) {
  const hasStoryblokAssets = (inventory.page_inventory || []).some((page) => (page.images || []).length > 0);
  if (!hasStoryblokAssets) return [];
  return [
    {
      path: integrationId,
      name: integrationId,
      parent_id: 0
    }
  ];
}

function textField(description) {
  return {
    type: 'text',
    translatable: true,
    description
  };
}

function textareaField(description) {
  return {
    type: 'textarea',
    translatable: true,
    description
  };
}

function richtextField(description) {
  return {
    type: 'richtext',
    translatable: true,
    description
  };
}

function booleanField(description) {
  return {
    type: 'boolean',
    description
  };
}

function optionField(description, options) {
  return {
    type: 'option',
    source: 'self',
    options: options.map((value) => ({ value, name: displayName(value) })),
    description
  };
}

function assetField(description) {
  return {
    type: 'asset',
    filetypes: ['images'],
    description
  };
}

function linkField(description) {
  return {
    type: 'multilink',
    allow_target_blank: true,
    description
  };
}

function toStoryblokLink(href = '') {
  if (/^https?:\/\//i.test(href)) return { linktype: 'url', url: href };
  if (href.startsWith('#')) return { linktype: 'url', url: href };
  return { linktype: 'story', cached_url: href.replace(/^\//, '') };
}

function draftImage(image) {
  if (!image) return null;
  return {
    id: null,
    filename: image.src,
    alt: image.alt || ''
  };
}

function richTextDocument(text = '') {
  const value = String(text || '').trim();
  return {
    type: 'doc',
    content: value
      ? [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: value
            }
          ]
        }
      ]
      : []
  };
}

function normalizeInputType(input) {
  if (input.tag === 'textarea') return 'textarea';
  if (input.tag === 'select') return 'select';
  const type = String(input.type || 'text').toLowerCase();
  if (['text', 'email', 'tel', 'number', 'checkbox', 'radio', 'hidden'].includes(type)) return type;
  return 'text';
}

function emptyStoryblokLink() {
  return { linktype: 'url', url: '' };
}

function explicitFieldHintSchema(primaryPage, existingSchema = {}) {
  const schema = {};
  for (const hint of collectExplicitFieldHints(primaryPage).slice(0, 24)) {
    const fieldName = safeFieldName(hint.field_hint);
    if (!fieldName || existingSchema[fieldName] || schema[fieldName]) continue;
    schema[fieldName] = fieldForHint(hint);
  }
  return schema;
}

function draftExplicitFieldValues(primaryPage, existingValues = {}) {
  const values = {};
  for (const hint of collectExplicitFieldHints(primaryPage).slice(0, 24)) {
    const fieldName = safeFieldName(hint.field_hint);
    if (!fieldName || Object.hasOwn(existingValues, fieldName) || Object.hasOwn(values, fieldName)) continue;
    const field = fieldForHint(hint);
    values[fieldName] = draftValueForHint(hint, field);
  }
  return values;
}

function applySchemaOverrides(plan, schemaOverrides, { integrationId, storyblokPrefix }) {
  if (!schemaOverrides) return plan;
  const summary = {
    components: [],
    draft_story: false
  };

  for (const override of normalizeComponentOverrides(schemaOverrides.components)) {
    const technicalName = resolveComponentOverrideName(override.selector, storyblokPrefix);
    const component = plan.components.find((entry) => entry.technical_name === technicalName);
    if (!component) {
      throw new Error(`schema override references unknown generated component: ${override.selector}`);
    }

    if (override.display_name) component.display_name = String(override.display_name);
    if (override.preview_field) component.preview_field = safeFieldName(override.preview_field);
    if (override.component_type) component.component_type = normalizeComponentType(override.component_type, override.selector);

    const addedFields = [];
    const fieldOverrides = normalizeFieldOverrides(override.fields || override.schema || {});
    for (const [fieldName, fieldDefinition] of fieldOverrides) {
      const safeName = safeFieldName(fieldName);
      if (!safeName) throw new Error(`schema override contains an unsafe field name for ${override.selector}: ${fieldName}`);
      component.schema[safeName] = normalizeOverrideField(fieldDefinition, { storyblokPrefix });
      addedFields.push(safeName);
    }

    const draftValues = override.draft || override.draft_values || override.default_values || null;
    const draftFields = draftValues ? mergeDraftValues(plan.draft_story, technicalName, draftValues, { storyblokPrefix }) : [];
    if (addedFields.length > 0 || draftFields.length > 0 || override.display_name || override.preview_field || override.component_type) {
      summary.components.push({
        technical_name: technicalName,
        fields: addedFields,
        draft_fields: draftFields
      });
    }
  }

  if (schemaOverrides.draft_story || schemaOverrides.draftStory) {
    applyDraftStoryOverride(plan.draft_story, schemaOverrides.draft_story || schemaOverrides.draftStory, { integrationId, storyblokPrefix });
    summary.draft_story = true;
  }

  if (summary.components.length > 0 || summary.draft_story) {
    plan.schema_overrides = summary;
  }
  return plan;
}

function normalizeComponentOverrides(components = {}) {
  if (Array.isArray(components)) {
    return components.map((entry) => ({
      ...entry,
      selector: entry.component || entry.technical_name || entry.name || entry.key
    }));
  }
  return Object.entries(components || {}).map(([selector, entry]) => ({
    ...(entry || {}),
    selector
  }));
}

function normalizeFieldOverrides(fields = {}) {
  if (Array.isArray(fields)) {
    return fields.map((field) => [field.name || field.field || field.key, field]);
  }
  return Object.entries(fields || {});
}

function resolveComponentOverrideName(selector, storyblokPrefix) {
  const key = String(selector || '').trim();
  if (!key) throw new Error('schema override component entries require a component selector');
  if (key.startsWith(storyblokPrefix)) return key;
  return `${storyblokPrefix}${snakeCase(key)}`;
}

function normalizeComponentType(value, selector) {
  const type = String(value || '').trim();
  if (type === 'content_type' || type === 'nestable') return type;
  throw new Error(`schema override for ${selector} uses unsupported component_type: ${value}`);
}

function normalizeOverrideField(fieldDefinition, { storyblokPrefix }) {
  const raw = typeof fieldDefinition === 'string'
    ? { type: fieldDefinition }
    : cloneJson(fieldDefinition || {});
  const type = String(raw.type || 'text').trim();
  if (!OVERRIDE_FIELD_TYPES.has(type)) {
    throw new Error(`schema override field type is not supported: ${type}`);
  }

  const normalized = {
    ...raw,
    type
  };
  delete normalized.name;
  delete normalized.field;
  delete normalized.key;
  delete normalized.whitelist;
  delete normalized.components;

  if (!normalized.description) normalized.description = 'Added by schema override.';
  if (type === 'asset' && !normalized.filetypes) normalized.filetypes = ['images'];
  if (type === 'option' || type === 'options') {
    normalized.source ||= 'self';
    if (Array.isArray(normalized.options)) normalized.options = normalized.options.map(normalizeOption);
  }
  if (type === 'bloks') {
    const whitelist = ensureArray(raw.component_whitelist || raw.whitelist || raw.components)
      .map((name) => resolveComponentOverrideName(name, storyblokPrefix));
    if (whitelist.length === 0) {
      throw new Error('schema override bloks fields require component_whitelist, whitelist, or components');
    }
    normalized.restrict_components = true;
    normalized.component_whitelist = whitelist;
  }
  return normalized;
}

function normalizeOption(option) {
  if (typeof option === 'string') return { value: option, name: displayName(option) };
  return {
    value: String(option.value || option.name || ''),
    name: String(option.name || option.value || '')
  };
}

function mergeDraftValues(draftStory, technicalName, draftValues, { storyblokPrefix }) {
  const normalized = normalizeDraftValue(draftValues, { storyblokPrefix });
  const targets = technicalName === draftStory.component
    ? [draftStory.content]
    : ensureArray(draftStory.content?.body).filter((block) => block.component === technicalName);
  for (const target of targets) {
    Object.assign(target, normalized);
  }
  return targets.length > 0 ? Object.keys(normalized) : [];
}

function applyDraftStoryOverride(draftStory, override, { integrationId, storyblokPrefix }) {
  if (override.name) draftStory.name = String(override.name);
  if (override.slug) {
    const slug = String(override.slug);
    const allowedPrefix = `integration-preview/${integrationId}`;
    if (slug !== allowedPrefix && !slug.startsWith(`${allowedPrefix}/`)) {
      throw new Error(`draft story override slug must remain inside ${allowedPrefix}`);
    }
    draftStory.slug = slug;
  }
  if (override.headline) draftStory.content.headline = String(override.headline);
  const values = override.field_values || override.fields || null;
  if (values) Object.assign(draftStory.content, normalizeDraftValue(values, { storyblokPrefix }));
}

function normalizeDraftValue(value, { storyblokPrefix }) {
  if (Array.isArray(value)) return value.map((entry) => normalizeDraftValue(entry, { storyblokPrefix }));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'component' && typeof entry === 'string') {
      output.component = entry.startsWith(storyblokPrefix) ? entry : resolveComponentOverrideName(entry, storyblokPrefix);
    } else {
      output[key] = normalizeDraftValue(entry, { storyblokPrefix });
    }
  }
  return output;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectExplicitFieldHints(primaryPage) {
  const hints = [];
  for (const heading of primaryPage.headings || []) {
    if (heading.field_hint) hints.push({ source_type: 'text', field_hint: heading.field_hint, tag: `h${heading.level}`, text: heading.text || '' });
  }
  for (const block of primaryPage.text_blocks || []) {
    if (block.field_hint) hints.push({ source_type: 'text', field_hint: block.field_hint, tag: block.tag, text: block.text || '' });
  }
  for (const image of primaryPage.images || []) {
    if (image.field_hint) hints.push({ source_type: 'image', field_hint: image.field_hint, image });
  }
  for (const link of primaryPage.links || []) {
    if (link.field_hint) hints.push({ source_type: 'link', field_hint: link.field_hint, link });
  }
  for (const form of primaryPage.forms || []) {
    for (const input of form.inputs || []) {
      if (input.field_hint) hints.push({ source_type: 'input', field_hint: input.field_hint, input });
    }
  }
  return hints;
}

function fieldForHint(hint) {
  const label = displayName(hint.field_hint);
  if (hint.source_type === 'image') return assetField(`Explicit template field: ${label}`);
  if (hint.source_type === 'link') return linkField(`Explicit template field: ${label}`);
  if (hint.source_type === 'input') return fieldForInputHint(hint.input, label);
  if (isLongTextHint(hint)) return richtextField(`Explicit template field: ${label}`);
  return textField(`Explicit template field: ${label}`);
}

function fieldForInputHint(input = {}, label) {
  const type = normalizeInputType(input);
  const options = (input.options || []).map((option) => option.value || option.label).filter(Boolean);
  if (type === 'checkbox') return booleanField(`Explicit template field: ${label}`);
  if ((type === 'select' || type === 'radio') && options.length > 0) {
    return optionField(`Explicit template field: ${label}`, options);
  }
  if (type === 'textarea') return textareaField(`Explicit template field: ${label}`);
  return textField(`Explicit template field: ${label}`);
}

function draftValueForHint(hint, field) {
  if (field.type === 'asset') return draftImage(hint.image);
  if (field.type === 'multilink') return toStoryblokLink(hint.link?.href || '');
  if (field.type === 'boolean') return Boolean(hint.input?.checked);
  if (field.type === 'option') {
    return hint.input?.value || field.options?.[0]?.value || '';
  }
  if (field.type === 'richtext') return richTextDocument(hint.text || '');
  return hint.text || hint.input?.value || hint.input?.placeholder || '';
}

function isLongTextHint(hint) {
  const name = snakeCase(hint.field_hint);
  return hint.tag === 'p' ||
    hint.tag === 'blockquote' ||
    /body|bio|copy|content|description|details|intro|summary|text|rich/i.test(name);
}

function safeFieldName(value) {
  const name = snakeCase(value);
  if (!name) return '';
  return /^[a-z_]/.test(name) ? name : `field_${name}`;
}

function hasStatsPattern(textBlocks, classText) {
  return /stat|metric|kpi|counter|number/i.test(classText) ||
    textBlocks.some((block) => /\b\d{2,}[%+x]?\b/.test(block.text || ''));
}

function hasPricingPattern(textBlocks, classText, repeated) {
  return /pricing|price|plan|package|tier/i.test(classText) ||
    repeated.some((item) => /pricing|price|plan|package|tier/i.test(item.class_name || '')) ||
    textBlocks.some((block) => /[$£€]\s?\d|\b\d+\s?(?:\/|per)\s?(month|mo|year|yr)\b/i.test(block.text || ''));
}

function hasStepsPattern(textBlocks, classText) {
  return /step|timeline|process|how-it-works|journey/i.test(classText) ||
    textBlocks.some((block) => /^(step\s*)?\d+[.)]\s+/i.test(block.text || ''));
}

function hasFaqPattern(textBlocks, classText, tagCounts) {
  return /faq|accordion|question|answers?/i.test(classText) ||
    Number(tagCounts.details || 0) > 0 ||
    textBlocks.some((block) => /\?$/.test(block.text || '') || /^(q:|question:)/i.test(block.text || ''));
}

function hasTeamPattern(textBlocks, classText, images) {
  return /team|person|people|profile|bio|avatar|staff|leader/i.test(classText) ||
    (images.length >= 2 && textBlocks.some((block) => /\b(founder|director|manager|designer|developer|consultant|lead|ceo|cto|cfo)\b/i.test(block.text || '')));
}

function inferStats(textBlocks) {
  return textBlocks
    .map((block) => String(block.text || '').trim())
    .map((text) => {
      const match = text.match(/(\d[\d,.]*\s?[%+x]?)\s*(.*)/);
      if (!match) return null;
      return {
        value: match[1].trim(),
        label: cleanDraftText(match[2]).slice(0, 80) || 'Statistic',
        description: cleanDraftText(text)
      };
    })
    .filter(Boolean);
}

function inferPricingPlans(textBlocks, links) {
  const prices = textBlocks
    .map((block) => cleanDraftText(block.text))
    .filter((text) => /[$£€]\s?\d|\b\d+\s?(?:\/|per)\s?(month|mo|year|yr)\b/i.test(text));
  if (prices.length === 0) return [];
  return prices.map((priceText, index) => ({
    name: previousMeaningfulText(textBlocks, priceText) || `Plan ${index + 1}`,
    price: priceText,
    summary: nextMeaningfulText(textBlocks, priceText) || '',
    features: textBlocks
      .map((block) => cleanDraftText(block.text))
      .filter((text) => text && text !== priceText && !links.some((link) => link.text === text))
      .slice(index * 4, index * 4 + 4)
  }));
}

function inferSteps(textBlocks) {
  const numbered = textBlocks
    .map((block) => cleanDraftText(block.text))
    .filter((text) => /^(step\s*)?\d+[.)]\s+/i.test(text))
    .map((text) => {
      const withoutNumber = text.replace(/^(step\s*)?\d+[.)]\s+/i, '');
      return {
        headline: withoutNumber.slice(0, 80),
        body: withoutNumber
      };
    });
  if (numbered.length > 0) return numbered;
  return textBlocks
    .map((block) => cleanDraftText(block.text))
    .filter(Boolean)
    .slice(0, 6)
    .map((text) => ({
      headline: text.slice(0, 80),
      body: text
    }));
}

function inferFaqs(textBlocks) {
  const texts = textBlocks.map((block) => cleanDraftText(block.text)).filter(Boolean);
  const faqs = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    if (!/\?$/.test(text) && !/^(q:|question:)/i.test(text)) continue;
    faqs.push({
      question: text.replace(/^(q:|question:)\s*/i, ''),
      answer: texts[index + 1] && !/\?$/.test(texts[index + 1]) ? texts[index + 1].replace(/^(a:|answer:)\s*/i, '') : ''
    });
  }
  return faqs;
}

function inferTeamMembers(textBlocks, images, links) {
  const texts = textBlocks.map((block) => cleanDraftText(block.text)).filter(Boolean);
  const rolePattern = /\b(founder|director|manager|designer|developer|consultant|lead|ceo|cto|cfo|head|president|partner)\b/i;
  const roleIndexes = texts
    .map((text, index) => ({ text, index }))
    .filter((entry) => rolePattern.test(entry.text));
  return roleIndexes.map((entry, memberIndex) => ({
    name: texts[entry.index - 1] || `Team Member ${memberIndex + 1}`,
    role: entry.text,
    bio: texts[entry.index + 1] || '',
    image: images[memberIndex] || null,
    link: links[memberIndex] || null
  }));
}

function previousMeaningfulText(textBlocks, currentText) {
  const texts = textBlocks.map((block) => cleanDraftText(block.text)).filter(Boolean);
  const index = texts.indexOf(currentText);
  if (index <= 0) return '';
  return texts[index - 1];
}

function nextMeaningfulText(textBlocks, currentText) {
  const texts = textBlocks.map((block) => cleanDraftText(block.text)).filter(Boolean);
  const index = texts.indexOf(currentText);
  if (index < 0 || index >= texts.length - 1) return '';
  return texts[index + 1];
}

function cleanDraftText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stableUid(integrationId, seed) {
  return sha256(`${integrationId}:${seed}`).slice(0, 16);
}

function snakeCase(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function displayName(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
