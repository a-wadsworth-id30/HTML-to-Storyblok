import path from 'node:path';
import { sha256 } from './utils.js';

export function buildSchemaPlan({ inventory, integrationId, storyblokPrefix, repositoryNamespace, templatePath }) {
  const primaryPage = inventory.page_inventory?.[0] || {};
  const components = [];
  const blocks = [];
  const mapping = [];

  const rootName = `${storyblokPrefix}template_page`;
  const blockDefinitions = inferBlockDefinitions(primaryPage, inventory, storyblokPrefix);
  for (const definition of blockDefinitions) {
    const component = buildComponentForDefinition(definition, primaryPage, storyblokPrefix);
    components.push(component);
    if (component.component_type === 'nestable') blocks.push(component.technical_name);
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

  return {
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
    storyblok_assets: buildStoryblokAssetPlan({ inventory, templatePath, integrationId })
  };
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
  const hasHero = (primaryPage.headings || []).some((heading) => heading.level === 1) || images.length > 0;

  if (landmarks.header) add('header', 'Header', { assets: images.slice(0, 1).map((image) => image.src) });
  if (landmarks.nav || links.length >= 3) add('navigation', 'Navigation', { nested_key: 'navigation_item', links: links.slice(0, 12) });
  if (hasHero) add('hero', 'Hero', { assets: images.slice(0, 1).map((image) => image.src) });
  if (repeated.some((item) => /grid|card|item|feature/i.test(item.class_name))) {
    add('feature_grid', 'Repeated content grid', { nested_key: 'feature_item' });
  }
  if ((primaryPage.text_blocks || []).length > 0) add('content_section', 'Content section');
  if (forms.length > 0) add('form', 'Form', { risk: 'External form behaviour requires endpoint review' });
  if (landmarks.footer) add('footer', 'Footer');
  if (definitions.length === 0) add('section', 'Template section');

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
  if (definition.key === 'navigation') {
    return nestableComponent(definition, {
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}navigation_item`],
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
      items: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: [`${storyblokPrefix}feature_item`],
        description: 'Integration-owned repeated grid items.'
      }
    });
  }
  if (definition.key === 'feature_item') {
    return nestableComponent(definition, {
      headline: textField('Item headline'),
      body: textareaField('Item body copy'),
      image: assetField('Optional item image')
    });
  }
  if (definition.key === 'form') {
    return nestableComponent(definition, {
      headline: textField('Form headline'),
      body: textareaField('Form supporting copy'),
      submit_label: textField('Submit button label'),
      endpoint_reference: {
        type: 'text',
        description: 'Reference name for the approved form endpoint. Do not store credentials here.'
      }
    });
  }
  return nestableComponent(definition, commonSectionSchema(primaryPage));
}

function commonSectionSchema(primaryPage) {
  const schema = {
    headline: textField('Section headline'),
    body: textareaField('Section body copy')
  };
  if ((primaryPage.images || []).length > 0) schema.image = assetField('Section image');
  if ((primaryPage.links || []).length > 0) {
    schema.cta_label = textField('Call-to-action label');
    schema.cta_link = linkField('Call-to-action link');
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
    body
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
      body: entry.text
    }));
  }
  if (definition.key === 'form') {
    block.submit_label = 'Submit';
    block.endpoint_reference = '';
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
      alt: image.alt || '',
      source_ref: image.src,
      status: 'planned'
    };
  });
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
