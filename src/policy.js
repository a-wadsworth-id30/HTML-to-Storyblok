import { ensureArray } from './utils.js';

const PERMITTED_OPERATIONS = new Set([
  'read_existing_resource',
  'snapshot_existing_resource',
  'duplicate_existing_resource',
  'create_new_resource'
]);

const REJECTED_MANIFEST_PATHS = [
  ['repository', 'files_to_modify', 'Existing repository files cannot be modified automatically.'],
  ['repository', 'existing_components_reused', 'Existing frontend components cannot be reused at runtime.'],
  ['storyblok', 'existing_components_reused', 'Existing Storyblok components cannot be reused at runtime.'],
  ['storyblok', 'stories_to_modify', 'Existing Storyblok stories cannot be modified.'],
  ['storyblok', 'assets_to_modify', 'Existing Storyblok assets cannot be modified.'],
  ['deployment', 'configuration_changes', 'Netlify or deployment configuration cannot be changed automatically.']
];

export function createDefaultManifest({
  integrationId,
  storyblokPrefix,
  repositoryNamespace
}) {
  const resolvedStoryblokPrefix = storyblokPrefix || storyblokPrefixForIntegrationId(integrationId);
  return {
    integration_id: integrationId,
    policy: 'additive-only-isolated',
    storyblok_prefix: resolvedStoryblokPrefix,
    repository_namespace: repositoryNamespace,
    repository: {
      files_to_create: [],
      files_to_modify: [],
      existing_components_reused: [],
      components_to_duplicate: [],
      assets_to_create: []
    },
    storyblok: {
      components_to_create: [],
      components_to_duplicate: [],
      existing_components_reused: [],
      stories_to_create: [],
      stories_to_modify: [],
      asset_folders_to_create: [],
      assets_to_create: [],
      assets_to_modify: []
    },
    deployment: {
      configuration_changes: []
    },
    authorisation: {
      publish_content: false,
      modify_existing_resources: false,
      change_dependencies: false,
      change_netlify: false
    },
    operations: []
  };
}

export function validatePlan(manifest) {
  const violations = [];
  if (manifest.policy !== 'additive-only-isolated') {
    violations.push({
      operation: 'policy',
      resource_type: 'manifest',
      resource: 'policy',
      reason: 'Policy must be additive-only-isolated.'
    });
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.integration_id || '')) {
    violations.push({
      operation: 'validate',
      resource_type: 'integration',
      resource: 'integration_id',
      reason: 'Integration ID must be lowercase kebab-case.'
    });
  }

  const expectedStoryblokPrefix = storyblokPrefixForIntegrationId(manifest.integration_id || '');
  if (!/^hts_[a-z0-9_]+_$/.test(manifest.storyblok_prefix || '')) {
    violations.push({
      operation: 'validate',
      resource_type: 'storyblok',
      resource: 'storyblok_prefix',
      reason: 'Storyblok prefix must be lowercase, start with hts_, and end with underscore.'
    });
  } else if (manifest.storyblok_prefix !== expectedStoryblokPrefix) {
    violations.push({
      operation: 'validate',
      resource_type: 'storyblok',
      resource: 'storyblok_prefix',
      reason: `Storyblok prefix must be derived from integration_id. Expected ${expectedStoryblokPrefix}.`
    });
  }

  const namespace = manifest.repository_namespace;
  if (!isSafeRelativePath(namespace || '')) {
    violations.push({
      operation: 'validate',
      resource_type: 'repository_namespace',
      resource: namespace || 'repository_namespace',
      reason: 'Repository namespace must be a safe relative path.'
    });
  }

  for (const [section, key, reason] of REJECTED_MANIFEST_PATHS) {
    const value = manifest[section]?.[key];
    if (ensureArray(value).length > 0) {
      violations.push({
        operation: 'modify',
        resource_type: `${section}.${key}`,
        resource: key,
        reason
      });
    }
  }

  const auth = manifest.authorisation || {};
  for (const [key, value] of Object.entries(auth)) {
    if (value !== false) {
      violations.push({
        operation: 'authorisation',
        resource_type: 'manifest',
        resource: key,
        reason: `Authorisation flag ${key} must be false for the default safe mode.`
      });
    }
  }

  for (const operation of ensureArray(manifest.operations)) {
    if (!PERMITTED_OPERATIONS.has(operation.type)) {
      violations.push({
        operation: operation.type || 'unknown',
        resource_type: operation.resource_type || 'unknown',
        resource: operation.resource || 'unknown',
        reason: 'Operation is not permitted by additive-only policy.'
      });
    }
  }

  const createdFiles = ensureArray(manifest.repository?.files_to_create);
  for (const file of createdFiles) {
    if (!isSafeRelativePath(file) || !isInsideNamespace(file, namespace)) {
      violations.push({
        operation: 'create',
        resource_type: 'repository_file',
        resource: file,
        reason: 'Created repository files must be safe relative paths inside the integration namespace.'
      });
    }
  }
  const duplicateFiles = findDuplicates(createdFiles);
  for (const file of duplicateFiles) {
    violations.push({
      operation: 'create',
      resource_type: 'repository_file',
      resource: file,
      reason: 'Duplicate file path in manifest.'
    });
  }

  const repositoryAssetTargets = ensureArray(manifest.repository?.assets_to_create).map((asset) => asset.target_path || asset.path || asset);
  for (const target of repositoryAssetTargets) {
    if (!isSafeRelativePath(target) || (!isInsideNamespace(target, namespace) && !String(target).startsWith(`public/integrations/${manifest.integration_id}/`))) {
      violations.push({
        operation: 'create',
        resource_type: 'repository_asset',
        resource: target,
        reason: 'Repository asset targets must be safe relative paths inside the integration namespace or public integration namespace.'
      });
    }
  }
  for (const target of findDuplicates(repositoryAssetTargets)) {
    violations.push({
      operation: 'create',
      resource_type: 'repository_asset',
      resource: target,
      reason: 'Duplicate repository asset target in manifest.'
    });
  }

  for (const entry of ensureArray(manifest.repository?.components_to_duplicate)) {
    const target = entry.target_path || entry.target;
    if (!isSafeRelativePath(target || '') || !isInsideNamespace(target, namespace)) {
      violations.push({
        operation: 'duplicate',
        resource_type: 'repository_component',
        resource: target || 'target_path',
        reason: 'Duplicated frontend component targets must be safe relative paths inside the integration namespace.'
      });
    }
  }

  const technicalNames = [
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => component.technical_name || component),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => component.technical_name || component)
  ];
  for (const name of findDuplicates(technicalNames)) {
    violations.push({
      operation: 'create',
      resource_type: 'storyblok_component',
      resource: name,
      reason: 'Duplicate Storyblok technical name in manifest.'
    });
  }
  for (const name of technicalNames) {
    if (typeof name === 'string' && !name.startsWith(manifest.storyblok_prefix)) {
      violations.push({
        operation: 'create',
        resource_type: 'storyblok_component',
        resource: name,
        reason: 'Storyblok component technical name is not namespaced with the integration prefix.'
      });
    }
  }

  for (const component of ensureArray(manifest.storyblok?.components_to_create)) {
    for (const nestedName of nestedComponentWhitelists(component.schema)) {
      if (!String(nestedName).startsWith(manifest.storyblok_prefix)) {
        violations.push({
          operation: 'create',
          resource_type: 'storyblok_component_schema',
          resource: component.technical_name || component.name,
          reason: `Nested component whitelist contains unnamespaced component: ${nestedName}`
        });
      }
    }
  }

  const storySlugs = ensureArray(manifest.storyblok?.stories_to_create).map((story) => story.slug || story.full_slug);
  for (const story of ensureArray(manifest.storyblok?.stories_to_create)) {
    const slug = story.slug || story.full_slug;
    if (!isSafeStorySlug(slug)) {
      violations.push({
        operation: 'create',
        resource_type: 'storyblok_story',
        resource: slug || 'slug',
        reason: 'Draft story slug must be a safe relative slug.'
      });
    }
    if (isSafeStorySlug(slug) && !isInsideIntegrationPreview(manifest, slug)) {
      violations.push({
        operation: 'create',
        resource_type: 'storyblok_story',
        resource: slug,
        reason: `Draft story slug must remain inside integration-preview/${manifest.integration_id}.`
      });
    }
    for (const componentName of storyComponentNames(story)) {
      if (!String(componentName).startsWith(manifest.storyblok_prefix)) {
        violations.push({
          operation: 'create',
          resource_type: 'storyblok_story_content',
          resource: slug || 'story_content',
          reason: `Draft story content contains unnamespaced component: ${componentName}`
        });
      }
    }
  }
  for (const slug of findDuplicates(storySlugs)) {
    violations.push({
      operation: 'create',
      resource_type: 'storyblok_story',
      resource: slug,
      reason: 'Duplicate Storyblok story slug in manifest.'
    });
  }

  const storyblokAssetNames = ensureArray(manifest.storyblok?.assets_to_create).map((asset) => asset.filename || asset.path || asset.local_path);
  for (const filename of storyblokAssetNames) {
    if (filename && !String(filename).startsWith(`${manifest.integration_id}/`) && !String(filename).startsWith(`${manifest.storyblok_prefix}`)) {
      violations.push({
        operation: 'create',
        resource_type: 'storyblok_asset',
        resource: filename,
        reason: 'Storyblok asset filenames must be namespaced by integration ID or Storyblok prefix.'
      });
    }
  }
  for (const filename of findDuplicates(storyblokAssetNames)) {
    violations.push({
      operation: 'create',
      resource_type: 'storyblok_asset',
      resource: filename,
      reason: 'Duplicate Storyblok asset filename in manifest.'
    });
  }

  const assetFolderPaths = ensureArray(manifest.storyblok?.asset_folders_to_create).map((folder) => folder.path || folder.name || folder);
  for (const folderPath of assetFolderPaths) {
    if (!isSafeStorySlug(folderPath) || (!String(folderPath).startsWith(`${manifest.integration_id}`) && !String(folderPath).startsWith(`${manifest.storyblok_prefix}`))) {
      violations.push({
        operation: 'create',
        resource_type: 'storyblok_asset_folder',
        resource: folderPath || 'asset_folder',
        reason: 'Storyblok asset folder paths must be safe and namespaced by integration ID or Storyblok prefix.'
      });
    }
  }
  for (const folderPath of findDuplicates(assetFolderPaths)) {
    violations.push({
      operation: 'create',
      resource_type: 'storyblok_asset_folder',
      resource: folderPath,
      reason: 'Duplicate Storyblok asset folder path in manifest.'
    });
  }

  return {
    valid: violations.length === 0,
    policy: 'additive-only-isolated',
    permitted_operations: [...PERMITTED_OPERATIONS],
    violations
  };
}

export function storyblokPrefixForIntegrationId(integrationId) {
  return `hts_${String(integrationId || '').replaceAll('-', '_')}_`;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values.filter(Boolean)) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function isSafeRelativePath(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function isInsideNamespace(filePath, namespace) {
  if (!namespace) return false;
  return filePath === namespace || String(filePath).startsWith(`${namespace}/`);
}

function nestedComponentWhitelists(schema = {}) {
  return Object.values(schema || {})
    .filter((field) => field && field.type === 'bloks')
    .flatMap((field) => ensureArray(field.component_whitelist));
}

function storyComponentNames(value) {
  const names = [];
  collectStoryComponentNames(value, names);
  return [...new Set(names)];
}

function collectStoryComponentNames(value, names) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStoryComponentNames(entry, names));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.component === 'string') names.push(value.component);
  Object.entries(value)
    .filter(([key]) => key !== 'component')
    .forEach(([, entry]) => collectStoryComponentNames(entry, names));
}

function isInsideIntegrationPreview(manifest, slug) {
  const allowedPrefix = `integration-preview/${manifest.integration_id}`;
  return slug === allowedPrefix || String(slug).startsWith(`${allowedPrefix}/`);
}

function isSafeStorySlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  if (slug.startsWith('/') || slug.includes('..')) return false;
  return /^[a-z0-9][a-z0-9/_-]*[a-z0-9]$/.test(slug);
}
