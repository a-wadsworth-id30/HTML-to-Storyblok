import path from 'node:path';
import { inspectTemplate } from './inspectors.js';
import { applyInferredDuplicationCandidates } from './duplication-inference.js';
import { createDefaultManifest, storyblokPrefixForIntegrationId, validatePlan } from './policy.js';
import { buildSchemaPlan } from './schema-generator.js';
import { plannedTemplateFilePaths } from './template-converter.js';
import { ensureArray, sha256, unique } from './utils.js';

export async function createIntegrationPlan({
  integrationId,
  storyblokPrefix,
  repositoryNamespace,
  templatePath,
  framework = 'static',
  repoPath,
  inferDuplicates = false,
  storyblokInspection = null,
  schemaOverrides = null,
  schemaOverridesPath = null
}) {
  const namespace = repositoryNamespace || path.posix.join('src/integrations', integrationId);
  const resolvedStoryblokPrefix = storyblokPrefix || storyblokPrefixForIntegrationId(integrationId);
  const manifest = createDefaultManifest({
    integrationId,
    storyblokPrefix: resolvedStoryblokPrefix,
    repositoryNamespace: namespace
  });

  addBaseRepositoryFiles(manifest, framework, Boolean(templatePath));

  if (templatePath) {
    const inventory = await inspectTemplate(templatePath);
    const schemaPlan = buildSchemaPlan({
      inventory,
      integrationId,
      storyblokPrefix: resolvedStoryblokPrefix,
      repositoryNamespace: namespace,
      templatePath,
      schemaOverrides
    });
    manifest.template = {
      source_path: String(templatePath),
      framework,
      inventory_hash: sha256(JSON.stringify(inventory)),
      pages: inventory.pages,
      shared_sections: inventory.shared_sections,
      missing_assets: inventory.missing_assets,
      accessibility_issues: inventory.accessibility_issues
    };
    manifest.mapping = schemaPlan.mapping;
    manifest.storyblok.components_to_create = schemaPlan.components;
    manifest.storyblok.stories_to_create = schemaPlan.draft_stories || [schemaPlan.draft_story];
    manifest.storyblok.asset_folders_to_create = schemaPlan.asset_folders;
    manifest.storyblok.assets_to_create = schemaPlan.storyblok_assets;
    manifest.repository.assets_to_create = schemaPlan.repository_assets;
    if (schemaPlan.schema_overrides) {
      manifest.schema_overrides = {
        source_path: schemaOverridesPath ? String(schemaOverridesPath) : null,
        ...schemaPlan.schema_overrides
      };
    }
    manifest.repository.files_to_create = unique([
      ...manifest.repository.files_to_create,
      ...plannedTemplateFilePaths(manifest, framework)
    ]);
  } else {
    manifest.storyblok.components_to_create = [
      {
        technical_name: `${resolvedStoryblokPrefix}template_page`,
        component_type: 'content_type',
        allowed_children: [`${resolvedStoryblokPrefix}section`]
      },
      { technical_name: `${resolvedStoryblokPrefix}section`, component_type: 'nestable' }
    ];
    manifest.storyblok.stories_to_create = [
      { slug: `${integrationId}/home`, component: `${resolvedStoryblokPrefix}template_page`, status: 'draft' }
    ];
  }

  if (inferDuplicates) {
    await applyInferredDuplicationCandidates(manifest, {
      repoPath: repoPath || process.cwd(),
      storyblokInspection
    });
  }

  addStoryblokManagementResources(manifest);

  manifest.operations = buildOperations(manifest);
  manifest.validation = validatePlan(manifest);
  return manifest;
}

function addBaseRepositoryFiles(manifest, framework, hasTemplate) {
  const namespace = manifest.repository_namespace;
  manifest.repository.files_to_create = [
    `${namespace}/integration-manifest.json`,
    `${namespace}/index.js`,
    `${namespace}/components.js`,
    `${namespace}/README.md`,
    `${namespace}/styles/${manifest.integration_id}.css`
  ];
  if (hasTemplate) {
    manifest.repository.files_to_create.push(...plannedTemplateFilePaths(manifest, framework));
  }
}

export function buildOperations(manifest) {
  return [
    ...ensureArray(manifest.repository?.files_to_create).map((resource) => ({
      type: 'create_new_resource',
      resource_type: 'repository_file',
      resource
    })),
    ...ensureArray(manifest.repository?.components_to_duplicate).map((component) => ({
      type: 'duplicate_existing_resource',
      resource_type: 'repository_component',
      resource: component.target_path || component.target
    })),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => ({
      type: 'create_new_resource',
      resource_type: 'repository_asset',
      resource: asset.target_path
    })),
    ...ensureArray(manifest.storyblok?.component_groups_to_create).map((group) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_component_group',
      resource: group.path || group.name || group
    })),
    ...ensureArray(manifest.storyblok?.internal_tags_to_create).map((tag) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_internal_tag',
      resource: tag.name || tag.tag || tag
    })),
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_component',
      resource: component.technical_name || component.name
    })),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => ({
      type: 'duplicate_existing_resource',
      resource_type: 'storyblok_component',
      resource: component.technical_name || component.name
    })),
    ...ensureArray(manifest.storyblok?.asset_folders_to_create).map((folder) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_asset_folder',
      resource: folder.path || folder.name || folder
    })),
    ...ensureArray(manifest.storyblok?.assets_to_create).map((asset) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_asset',
      resource: asset.filename || asset.local_path
    })),
    ...ensureArray(manifest.storyblok?.presets_to_create).map((preset) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_preset',
      resource: preset.name || preset.component_technical_name || preset.component
    })),
    ...ensureArray(manifest.storyblok?.stories_to_create).map((story) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_story',
      resource: story.slug || story.full_slug
    }))
  ];
}

function addStoryblokManagementResources(manifest) {
  const storyblok = manifest.storyblok || {};
  const createdComponents = ensureArray(storyblok.components_to_create);
  const createdAssets = ensureArray(storyblok.assets_to_create);
  const draftStories = ensureArray(storyblok.stories_to_create);
  if (createdComponents.length > 0) {
    storyblok.component_groups_to_create = addUniqueBy(
      ensureArray(storyblok.component_groups_to_create),
      { path: manifest.integration_id, name: manifest.integration_id, parent_id: 0 },
      (group) => group.path || group.name || group
    );
    for (const component of createdComponents) {
      component.component_group_path ||= manifest.integration_id;
    }
    storyblok.internal_tags_to_create = addUniqueBy(
      ensureArray(storyblok.internal_tags_to_create),
      { name: `${manifest.storyblok_prefix}components`, object_type: 'component' },
      (tag) => `${tag.object_type || 'component'}:${tag.name || tag}`
    );
  }
  if (createdAssets.length > 0) {
    storyblok.internal_tags_to_create = addUniqueBy(
      ensureArray(storyblok.internal_tags_to_create),
      { name: `${manifest.storyblok_prefix}assets`, object_type: 'asset' },
      (tag) => `${tag.object_type || 'component'}:${tag.name || tag}`
    );
  }
  storyblok.presets_to_create = addUniqueManyBy(
    ensureArray(storyblok.presets_to_create),
    defaultPresetsFromDraftStories(manifest, createdComponents, draftStories),
    (preset) => `${preset.component_technical_name || preset.component}:${preset.name}`
  );
  manifest.storyblok = storyblok;
}

function defaultPresetsFromDraftStories(manifest, components, draftStories) {
  const generatedComponentNames = new Set(components
    .filter((component) => component.component_type !== 'content_type' && component.is_root !== true)
    .map((component) => component.technical_name || component.name)
    .filter(Boolean));
  const presets = [];
  const seen = new Set();
  for (const story of draftStories) {
    for (const block of collectPresetBlocks(story.content || {})) {
      const componentName = block.component;
      if (!generatedComponentNames.has(componentName) || seen.has(componentName)) continue;
      seen.add(componentName);
      presets.push({
        name: `${componentName}_default`,
        component_technical_name: componentName,
        preset: stripStoryblokEditorMetadata(block)
      });
    }
  }
  return presets;
}

function collectPresetBlocks(value, blocks = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPresetBlocks(entry, blocks);
    return blocks;
  }
  if (!value || typeof value !== 'object') return blocks;
  if (typeof value.component === 'string') blocks.push(value);
  for (const entry of Object.values(value)) collectPresetBlocks(entry, blocks);
  return blocks;
}

function stripStoryblokEditorMetadata(value) {
  if (Array.isArray(value)) return value.map(stripStoryblokEditorMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== '_uid' && key !== '_editable')
    .map(([key, entry]) => [key, stripStoryblokEditorMetadata(entry)]));
}

function addUniqueBy(entries, entry, keyFn) {
  return addUniqueManyBy(entries, [entry], keyFn);
}

function addUniqueManyBy(entries, additions, keyFn) {
  const output = [...entries];
  const seen = new Set(output.map(keyFn).filter(Boolean));
  for (const addition of additions) {
    const key = keyFn(addition);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(addition);
  }
  return output;
}
