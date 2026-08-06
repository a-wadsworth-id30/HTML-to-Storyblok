import path from 'node:path';
import { inspectTemplate } from './inspectors.js';
import { createDefaultManifest, storyblokPrefixForIntegrationId, validatePlan } from './policy.js';
import { buildSchemaPlan } from './schema-generator.js';
import { plannedTemplateFilePaths } from './template-converter.js';
import { ensureArray, sha256 } from './utils.js';

export async function createIntegrationPlan({
  integrationId,
  storyblokPrefix,
  repositoryNamespace,
  templatePath,
  framework = 'static'
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
      templatePath
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
    manifest.storyblok.stories_to_create = [schemaPlan.draft_story];
    manifest.storyblok.asset_folders_to_create = schemaPlan.asset_folders;
    manifest.storyblok.assets_to_create = schemaPlan.storyblok_assets;
    manifest.repository.assets_to_create = schemaPlan.repository_assets;
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
      { slug: `integration-preview/${integrationId}`, component: `${resolvedStoryblokPrefix}template_page`, status: 'draft' }
    ];
  }

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

function buildOperations(manifest) {
  return [
    ...ensureArray(manifest.repository?.files_to_create).map((resource) => ({
      type: 'create_new_resource',
      resource_type: 'repository_file',
      resource
    })),
    ...ensureArray(manifest.repository?.assets_to_create).map((asset) => ({
      type: 'create_new_resource',
      resource_type: 'repository_asset',
      resource: asset.target_path
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
    ...ensureArray(manifest.storyblok?.stories_to_create).map((story) => ({
      type: 'create_new_resource',
      resource_type: 'storyblok_story',
      resource: story.slug || story.full_slug
    }))
  ];
}
