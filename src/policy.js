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
  return {
    integration_id: integrationId,
    policy: 'additive-only-isolated',
    storyblok_prefix: storyblokPrefix,
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

  if (!/^hts_[a-z0-9_]+_$/.test(manifest.storyblok_prefix || '')) {
    violations.push({
      operation: 'validate',
      resource_type: 'storyblok',
      resource: 'storyblok_prefix',
      reason: 'Storyblok prefix must be lowercase, start with hts_, and end with underscore.'
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
  const duplicateFiles = findDuplicates(createdFiles);
  for (const file of duplicateFiles) {
    violations.push({
      operation: 'create',
      resource_type: 'repository_file',
      resource: file,
      reason: 'Duplicate file path in manifest.'
    });
  }

  const technicalNames = [
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => component.technical_name || component),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => component.technical_name || component)
  ];
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

  return {
    valid: violations.length === 0,
    policy: 'additive-only-isolated',
    permitted_operations: [...PERMITTED_OPERATIONS],
    violations
  };
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

