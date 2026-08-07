import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { envValue, ensureArray, pathExists, sha256, unique } from './utils.js';

const REGION_BASE_URLS = {
  eu: 'https://mapi.storyblok.com/v1',
  us: 'https://api-us.storyblok.com/v1',
  ca: 'https://api-ca.storyblok.com/v1',
  ap: 'https://api-ap.storyblok.com/v1',
  cn: 'https://app.storyblokchina.cn/v1'
};

const CONTENT_BASE_URLS = {
  eu: 'https://api.storyblok.com/v2/cdn',
  us: 'https://api-us.storyblok.com/v2/cdn',
  ca: 'https://api-ca.storyblok.com/v2/cdn',
  ap: 'https://api-ap.storyblok.com/v2/cdn',
  cn: 'https://app.storyblokchina.cn/v2/cdn'
};

const STORYBLOK_APP_BASE_URLS = {
  eu: 'https://app.storyblok.com',
  us: 'https://app.storyblok.com',
  ca: 'https://app.storyblok.com',
  ap: 'https://app.storyblok.com',
  cn: 'https://app.storyblokchina.cn'
};

const DEFAULT_STORYBLOK_RETRY_LIMIT = 6;
const DEFAULT_STORYBLOK_RETRY_BASE_MS = 1000;
const DEFAULT_STORYBLOK_RETRY_MAX_MS = 8000;
const DEFAULT_STORYBLOK_TIMEOUT_MS = 30000;
const DEFAULT_STORYBLOK_INSPECT_MAX_ITEMS = 1000;
const DEFAULT_STORYBLOK_REQUEST_INTERVAL_MS = 0;

const requestQueues = new Map();
const lastRequestTimes = new Map();

export function getStoryblokConfig(env = process.env) {
  const token = envValue([
    'STORYBLOK_MANAGEMENT_TOKEN',
    'STORYBLOK_OAUTH_TOKEN',
    'STORYBLOK_PERSONAL_ACCESS_TOKEN'
  ], env);
  const spaceId = envValue(['STORYBLOK_SPACE_ID', 'SB_SPACE_ID'], env);
  const region = (envValue(['STORYBLOK_REGION'], env) || 'eu').toLowerCase();
  return {
    token,
    spaceId,
    region,
    baseUrl: REGION_BASE_URLS[region] || REGION_BASE_URLS.eu,
    retryLimit: integerEnv(envValue(['STORYBLOK_RETRY_LIMIT'], env), DEFAULT_STORYBLOK_RETRY_LIMIT),
    retryBaseMs: integerEnv(envValue(['STORYBLOK_RETRY_BASE_MS'], env), DEFAULT_STORYBLOK_RETRY_BASE_MS),
    retryMaxMs: integerEnv(envValue(['STORYBLOK_RETRY_MAX_MS'], env), DEFAULT_STORYBLOK_RETRY_MAX_MS),
    timeoutMs: integerEnv(envValue(['STORYBLOK_TIMEOUT_MS'], env), DEFAULT_STORYBLOK_TIMEOUT_MS),
    inspectMaxItems: integerEnv(envValue(['STORYBLOK_INSPECT_MAX_ITEMS'], env), DEFAULT_STORYBLOK_INSPECT_MAX_ITEMS),
    requestIntervalMs: integerEnv(envValue(['STORYBLOK_REQUEST_INTERVAL_MS'], env), DEFAULT_STORYBLOK_REQUEST_INTERVAL_MS),
    available: Boolean(token && spaceId)
  };
}

export function getStoryblokContentConfig(env = process.env) {
  const token = envValue([
    'STORYBLOK_PREVIEW_TOKEN',
    'STORYBLOK_PUBLIC_TOKEN',
    'STORYBLOK_DELIVERY_TOKEN'
  ], env);
  const region = (envValue(['STORYBLOK_REGION'], env) || 'eu').toLowerCase();
  return {
    token,
    region,
    baseUrl: CONTENT_BASE_URLS[region] || CONTENT_BASE_URLS.eu,
    retryLimit: integerEnv(envValue(['STORYBLOK_CONTENT_RETRY_LIMIT', 'STORYBLOK_RETRY_LIMIT'], env), DEFAULT_STORYBLOK_RETRY_LIMIT),
    retryBaseMs: integerEnv(envValue(['STORYBLOK_CONTENT_RETRY_BASE_MS', 'STORYBLOK_RETRY_BASE_MS'], env), DEFAULT_STORYBLOK_RETRY_BASE_MS),
    retryMaxMs: integerEnv(envValue(['STORYBLOK_CONTENT_RETRY_MAX_MS', 'STORYBLOK_RETRY_MAX_MS'], env), DEFAULT_STORYBLOK_RETRY_MAX_MS),
    timeoutMs: integerEnv(envValue(['STORYBLOK_CONTENT_TIMEOUT_MS', 'STORYBLOK_TIMEOUT_MS'], env), DEFAULT_STORYBLOK_TIMEOUT_MS),
    available: Boolean(token)
  };
}

export async function inspectStoryblokSpace({ env = process.env, full = false, audit = false } = {}) {
  const config = getStoryblokConfig(env);
  const access = {
    management_api_available: Boolean(config.token),
    space_id_available: Boolean(config.spaceId),
    region: config.region,
    base_url: config.baseUrl,
    inspection_limit: full ? 'unlimited' : config.inspectMaxItems,
    variable_names: Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name)).sort(),
    note: 'Secret values are intentionally omitted.'
  };
  if (!config.available) {
    return {
      ...access,
      status: 'unavailable',
      reason: 'Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID to query the Management API.'
    };
  }

  const space = await storyblokRequest(config, `/spaces/${config.spaceId}`);
  const listOptions = full ? {} : { maxItems: config.inspectMaxItems };
  const components = await listStoryblokComponents(config, {}, listOptions);
  const componentGroups = await listStoryblokComponentGroups(config, {}, listOptions);
  const stories = await listStoryblokStories(config, {}, listOptions);
  const assetFolders = await listStoryblokAssetFolders(config, {}, listOptions);
  const assets = await listStoryblokAssets(config, {}, listOptions);
  const internalTagsResult = await optionalStoryblokItems(config, 'internal_tags', listStoryblokInternalTags, {}, listOptions);
  const internalTags = internalTagsResult.items;
  const presets = await listStoryblokPresets(config, {}, listOptions);
  const auditResult = audit ? await inspectStoryblokAuditResources(config, listOptions) : null;

  return {
    ...access,
    status: 'ok',
    space: space.space ? summarizeSpace(space.space) : space,
    components: components.map(summarizeComponent),
    component_groups: componentGroups.map(summarizeComponentGroup),
    stories: stories.map(summarizeStory),
    asset_folders: assetFolders.map(summarizeAssetFolder),
    assets: assets.map(summarizeAsset),
    internal_tags: internalTags.map(summarizeInternalTag),
    optional_unavailable: [
      ...(internalTagsResult.status === 'ok' ? [] : [{ name: 'internal_tags', reason: internalTagsResult.reason }])
    ],
    presets: presets.map(summarizePreset),
    readiness: summarizeStoryblokReadiness({
      space: space.space,
      components,
      stories,
      assets,
      assetFolders,
      componentGroups,
      internalTags,
      presets,
      audit: auditResult
    }),
    ...(auditResult ? { audit: auditResult } : {})
  };
}

export async function preflightStoryblokIntegration(manifest, { dryRun = false, env = process.env } = {}) {
  const requirements = storyblokRequirements(manifest);
  const checks = [];
  if (requirements.operation_count === 0) {
    return {
      action: 'storyblok_preflight',
      dry_run: dryRun,
      status: 'skipped',
      reason: 'Manifest does not contain Storyblok operations.',
      requirements,
      checks
    };
  }

  const config = getStoryblokConfig(env);
  const contentConfig = getStoryblokContentConfig(env);
  checks.push(preflightCheck('management_token', Boolean(config.token), 'Management API token is present.'));
  checks.push(preflightCheck('space_id', Boolean(config.spaceId), 'Storyblok space id is present.'));
  checks.push(preflightCheck('content_api_token', Boolean(contentConfig.token), 'Content API token is present for post-apply draft validation.', {
    required: false
  }));

  if (dryRun) {
    return {
      action: 'storyblok_preflight',
      dry_run: true,
      status: 'skipped',
      reason: 'Dry run does not require live Storyblok access.',
      requirements,
      checks,
      capabilities: {
        management_api: config.available ? 'configured' : 'not_configured',
        content_api: contentConfig.available ? 'configured' : 'not_configured',
        write_permissions: 'not_checked_in_dry_run'
      },
      permission_matrix: storyblokPermissionMatrix(requirements, checks, { dryRun: true })
    };
  }

  if (!config.available) {
    return {
      action: 'storyblok_preflight',
      dry_run: dryRun,
      status: 'failed',
      reason: 'Storyblok Management API credentials are required before real apply.',
      requirements,
      checks
    };
  }

  checks.push(await endpointPreflight(config, 'space_read', `/spaces/${config.spaceId}`));
  if (requirements.component_groups) {
    checks.push(await endpointPreflight(config, 'component_groups_read', `/spaces/${config.spaceId}/component_groups/?per_page=1&page=1`));
  }
  if (requirements.internal_tags) {
    checks.push(await endpointPreflight(config, 'internal_tags_read', `/spaces/${config.spaceId}/internal_tags/?per_page=1&page=1`, {
      required: false,
      optional: true
    }));
  }
  if (requirements.components) {
    checks.push(await endpointPreflight(config, 'components_read', `/spaces/${config.spaceId}/components/?per_page=1&page=1`));
  }
  if (requirements.stories) {
    checks.push(await endpointPreflight(config, 'stories_read', `/spaces/${config.spaceId}/stories?per_page=1&page=1`));
  }
  if (requirements.asset_folders) {
    checks.push(await endpointPreflight(config, 'asset_folders_read', `/spaces/${config.spaceId}/asset_folders/?per_page=1&page=1`));
  }
  if (requirements.assets) {
    checks.push(await endpointPreflight(config, 'assets_read', `/spaces/${config.spaceId}/assets?per_page=1&page=1`));
  }
  if (requirements.presets) {
    checks.push(await endpointPreflight(config, 'presets_read', `/spaces/${config.spaceId}/presets/?per_page=1&page=1`));
  }

  const requiredChecks = checks.filter((check) => check.required !== false);
  return {
    action: 'storyblok_preflight',
    dry_run: dryRun,
    status: requiredChecks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    requirements,
    checks,
    capabilities: {
      management_api: requiredChecks.every((check) => check.status === 'passed') ? 'available' : 'unavailable',
      content_api: contentConfig.available ? 'available' : 'not_configured',
      write_permissions: 'verified during additive create calls; preflight performs non-mutating reads only'
    },
    permission_matrix: storyblokPermissionMatrix(requirements, checks)
  };
}

export async function createStoryblokComponentGroups(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const groups = plannedComponentGroups(manifest);
  const results = [];
  if (groups.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  if (dryRun) {
    return groups.map((group) => ({
      action: 'create_component_group',
      dry_run: true,
      group_path: group.path,
      payload: {
        component_group: componentGroupPayload(group, null)
      },
      collision_policy: 'reuse_matching_component_folder_or_create'
    }));
  }

  const existingGroups = await listStoryblokComponentGroups(config);
  const resolved = new Map();
  for (const group of groups) {
    const parent = group.parent_path ? resolved.get(group.parent_path) : rootComponentGroupParent(group);
    if (group.parent_path && !parent) throw new Error(`parent Storyblok component folder was not resolved: ${group.parent_path}`);
    const existing = existingGroups.find((entry) => componentGroupMatches(entry, group.name, parent));
    if (existing) {
      const summary = summarizeComponentGroup(existing, group.path);
      resolved.set(group.path, summary);
      results.push({
        action: 'create_component_group',
        dry_run: false,
        status: 'already_exists',
        group_path: group.path,
        id: summary.id,
        uuid: summary.uuid,
        verification: summary
      });
      continue;
    }

    const payload = {
      component_group: componentGroupPayload(group, parent)
    };
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/component_groups/`, {
      method: 'POST',
      body: payload
    });
    const created = response.component_group || response;
    existingGroups.push(created);
    const summary = summarizeComponentGroup(created, group.path);
    resolved.set(group.path, summary);
    results.push({
      action: 'create_component_group',
      dry_run: false,
      status: 'created',
      group_path: group.path,
      id: summary.id,
      uuid: summary.uuid,
      verification: summary
    });
  }
  return results;
}

export async function createStoryblokInternalTags(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const tags = plannedInternalTags(manifest);
  const results = [];
  if (tags.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  if (dryRun) {
    return tags.map((tag) => ({
      action: 'create_internal_tag',
      dry_run: true,
      name: tag.name,
      object_type: tag.object_type,
      payload: {
        internal_tag: tag
      },
      collision_policy: 'reuse_matching_internal_tag_or_create'
    }));
  }

  const existingTagsResult = await optionalStoryblokItems(config, 'internal_tags', listStoryblokInternalTags);
  if (existingTagsResult.status !== 'ok') {
    return tags.map((tag) => ({
      action: 'create_internal_tag',
      dry_run: false,
      status: 'skipped_optional',
      name: tag.name,
      object_type: tag.object_type,
      reason: 'Storyblok internal tags are unavailable for this space, token, region, or plan.',
      details: existingTagsResult.reason,
      collision_policy: 'optional_metadata_only'
    }));
  }
  const existingTags = existingTagsResult.items;
  for (const tag of tags) {
    const existing = existingTags.find((entry) => internalTagMatches(entry, tag));
    if (existing) {
      results.push({
        action: 'create_internal_tag',
        dry_run: false,
        status: 'already_exists',
        name: tag.name,
        object_type: tag.object_type,
        id: existing.id || null,
        verification: summarizeInternalTag(existing)
      });
      continue;
    }

    let response;
    try {
      response = await storyblokRequest(config, `/spaces/${config.spaceId}/internal_tags/`, {
        method: 'POST',
        body: {
          internal_tag: tag
        }
      });
    } catch (error) {
      results.push({
        action: 'create_internal_tag',
        dry_run: false,
        status: 'skipped_optional',
        name: tag.name,
        object_type: tag.object_type,
        reason: 'Storyblok internal tag creation is optional and was skipped after the create call failed.',
        details: error.message || String(error),
        collision_policy: 'optional_metadata_only'
      });
      continue;
    }
    const created = response.internal_tag || response;
    existingTags.push(created);
    results.push({
      action: 'create_internal_tag',
      dry_run: false,
      status: 'created',
      name: created.name || tag.name,
      object_type: created.object_type || tag.object_type,
      id: created.id || null,
      verification: summarizeInternalTag(created)
    });
  }
  return results;
}

export async function createStoryblokComponents(manifest, { dryRun = false, env = process.env, componentGroupResults = null } = {}) {
  const config = getStoryblokConfig(env);
  const components = ensureArray(manifest.storyblok?.components_to_create);
  const results = [];
  if (components.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  let existingComponents = null;
  const componentGroupUuids = dryRun
    ? new Map()
    : await resolveComponentGroupUuids(manifest, { env, componentGroupResults });
  for (const component of components) {
    const payload = {
      component: normalizeComponent(component, {
        componentGroupUuid: component.component_group_uuid ||
          (component.component_group_path ? componentGroupUuids.get(component.component_group_path) : null)
      })
    };
    if (dryRun) {
      results.push({
        action: 'create_component',
        dry_run: true,
        technical_name: payload.component.name,
        component_group_path: component.component_group_path || null,
        collision_policy: 'verify_matching_or_stop',
        payload
      });
      continue;
    }
    existingComponents ||= await listStoryblokComponents(config);
    const existing = existingComponents.find((entry) => entry.name === payload.component.name);
    if (existing) {
      assertComponentMatches(existing, payload.component);
      results.push({
        action: 'create_component',
        dry_run: false,
        status: 'already_exists',
        technical_name: existing.name,
        id: existing.id || null,
        verification: summarizeComponent(existing)
      });
      continue;
    }
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`, {
      method: 'POST',
      body: payload
    });
    existingComponents.push(response.component);
    results.push({
      action: 'create_component',
      dry_run: false,
      status: 'created',
      technical_name: response.component?.name || payload.component.name,
      id: response.component?.id || null,
      verification: response.component ? summarizeComponent(response.component) : response
    });
  }
  return results;
}

export async function createDraftStories(manifest, { dryRun = false, env = process.env, assetResults = null } = {}) {
  const config = getStoryblokConfig(env);
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  const results = [];
  if (stories.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  const assetMap = await createStoryAssetMap(manifest, { config, dryRun, assetResults });
  const plannedStories = stories.map((story) => ({
    story,
    content: hydrateStoryAssets(story.content || {
      component: story.component,
      body: ensureArray(story.body)
    }, assetMap)
  }));
  if (dryRun) {
    for (const { story, content } of plannedStories) {
      const target = plannedStoryTarget(story);
      const payload = draftStoryPayload(story, target, content);
      results.push({
        action: 'create_draft_story',
        dry_run: true,
        slug: target.full_slug,
        story_slug: target.slug,
        parent_slug: target.parent_slug,
        collision_policy: 'verify_matching_draft_or_stop',
        asset_resolution: assetMap.size > 0 ? 'planned_storyblok_assets' : 'no_storyblok_assets',
        link_summary: summarizeStoryLinks(content),
        payload
      });
    }
    return results;
  }

  const appliedStories = [];
  for (const { story, content } of plannedStories) {
    const existing = await findStoryBySlug(config, story.slug);
    if (existing) {
      appliedStories.push({
        story,
        content,
        existing,
        remote: existing,
        target: plannedStoryTarget(story)
      });
      continue;
    }
    const target = await resolveStoryTarget(config, story);
    const payload = draftStoryPayload(story, target, content);
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories`, {
      method: 'POST',
      body: payload
    });
    appliedStories.push({
      story,
      content,
      target,
      created: response.story || response,
      remote: response.story || response,
      folder_results: target.folder_results
    });
  }

  const storyReferences = createStoryReferenceMap(appliedStories);
  for (const entry of appliedStories) {
    const resolvedContent = hydrateStoryLinks(entry.content, storyReferences);
    if (entry.existing) {
      const match = assertStoryMatches(entry.existing, { slug: entry.story.slug, content: resolvedContent });
      const repair = match.repairable_link_metadata_difference && canRepairDraftStoryLinkMetadata(entry.existing, manifest, entry.story.slug);
      if (repair) {
        const updated = await updateDraftStoryContent(config, entry.story, entry.target, resolvedContent, entry.existing);
        results.push({
          action: 'create_draft_story',
          dry_run: false,
          status: 'updated_link_metadata',
          slug: updated.full_slug || entry.existing.full_slug || entry.story.slug,
          id: updated.id || entry.existing.id || null,
          uuid: updated.uuid || entry.existing.uuid || null,
          editor_url: storyblokEditorUrl(config, updated.id || entry.existing.id),
          published: Boolean(updated.published_at || entry.existing.published_at),
          link_resolution: 'story_uuid_hydrated',
          link_summary: summarizeStoryLinks(resolvedContent, storyReferences),
          verification: summarizeStory(updated)
        });
        continue;
      }
      results.push({
        action: 'create_draft_story',
        dry_run: false,
        status: 'already_exists',
        slug: entry.existing.full_slug || entry.story.slug,
        id: entry.existing.id || null,
        uuid: entry.existing.uuid || null,
        editor_url: storyblokEditorUrl(config, entry.existing.id),
        published: Boolean(entry.existing.published_at),
        link_resolution: match.repairable_link_metadata_difference ? 'existing_story_left_unchanged' : 'already_hydrated',
        link_summary: summarizeStoryLinks(entry.existing.content || resolvedContent, storyReferences),
        verification: summarizeStory(entry.existing)
      });
      continue;
    }

    let remote = entry.created;
    let linkResolution = 'not_required';
    if (!sameJson(entry.content, resolvedContent) && entry.created?.id) {
      remote = await updateDraftStoryContent(config, entry.story, entry.target, resolvedContent, entry.created);
      linkResolution = 'story_uuid_hydrated';
    }
    results.push({
      action: 'create_draft_story',
      dry_run: false,
      status: 'created',
      slug: remote?.full_slug || entry.created?.full_slug || entry.story.slug,
      id: remote?.id || entry.created?.id || null,
      uuid: remote?.uuid || entry.created?.uuid || null,
      editor_url: storyblokEditorUrl(config, remote?.id || entry.created?.id),
      published: Boolean(remote?.published_at || entry.created?.published_at),
      folder_results: entry.folder_results,
      link_resolution: linkResolution,
      link_summary: summarizeStoryLinks(resolvedContent, storyReferences),
      verification: remote ? summarizeStory(remote) : entry.created
    });
  }
  return results;
}

export async function createStoryblokAssetFolders(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const folders = plannedAssetFolders(manifest);
  const results = [];
  if (folders.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  if (dryRun) {
    return folders.map((folder) => ({
      action: 'create_asset_folder',
      dry_run: true,
      folder_path: folder.path,
      payload: {
        asset_folder: {
          name: folder.name,
          parent_id: folder.parent_id || 0
        }
      },
      collision_policy: 'reuse_matching_folder_or_create'
    }));
  }

  const existingFolders = await listStoryblokAssetFolders(config);
  const resolved = new Map();
  for (const folder of folders) {
    const parentId = folder.parent_path ? resolved.get(folder.parent_path)?.id : folder.parent_id || 0;
    if (folder.parent_path && !parentId) throw new Error(`parent Storyblok asset folder was not resolved: ${folder.parent_path}`);
    const existing = existingFolders.find((entry) => entry.name === folder.name && Number(entry.parent_id || 0) === Number(parentId || 0));
    if (existing) {
      const summary = summarizeAssetFolder(existing, folder.path);
      resolved.set(folder.path, summary);
      results.push({
        action: 'create_asset_folder',
        dry_run: false,
        status: 'already_exists',
        folder_path: folder.path,
        id: summary.id,
        verification: summary
      });
      continue;
    }

    const payload = {
      asset_folder: {
        name: folder.name,
        parent_id: parentId || 0
      }
    };
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/asset_folders/`, {
      method: 'POST',
      body: payload
    });
    const created = response.asset_folder || response;
    existingFolders.push(created);
    const summary = summarizeAssetFolder(created, folder.path);
    resolved.set(folder.path, summary);
    results.push({
      action: 'create_asset_folder',
      dry_run: false,
      status: 'created',
      folder_path: folder.path,
      id: summary.id,
      verification: summary
    });
  }
  return results;
}

export async function uploadStoryblokAssets(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const assets = ensureArray(manifest.storyblok?.assets_to_create);
  const results = [];
  if (assets.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  const folderIds = dryRun ? new Map() : await resolveAssetFolderIds(manifest, { env });

  for (const asset of assets) {
    const localPath = asset.local_path || asset.file || asset.path;
    if (!localPath) throw new Error('asset entry is missing local_path');
    if (!(await pathExists(localPath))) throw new Error(`asset file does not exist: ${localPath}`);
    const filename = asset.filename || path.basename(localPath);
    const fileStat = await stat(localPath);
    const sourceBuffer = await readFile(localPath);
    const sourceSha256 = sha256(sourceBuffer);
    const assetFolderPath = asset.asset_folder_path || defaultAssetFolderPath(manifest);
    const resolvedFolderId = asset.asset_folder_id || (assetFolderPath ? folderIds.get(assetFolderPath) : null);
    if (!dryRun && assetFolderPath && !resolvedFolderId) {
      throw new Error(`Storyblok asset folder was not resolved for asset ${filename}: ${assetFolderPath}`);
    }
    const signPayload = {
      filename,
      asset_folder_id: resolvedFolderId || undefined,
      size: asset.size || '',
      validate_upload: 1
    };
    if (dryRun) {
      results.push({
        action: 'upload_asset',
        dry_run: true,
        local_path: localPath,
        filename,
        source_ref: asset.source_ref || null,
        asset_folder_path: assetFolderPath || null,
        bytes: fileStat.size,
        source_sha256: sourceSha256,
        sign_payload: {
          ...signPayload,
          asset_folder_path: assetFolderPath || undefined
        }
      });
      continue;
    }

    const existing = dryRun ? null : await findAssetByFilename(config, filename, {
      assetFolderId: resolvedFolderId,
      manifest
    });
    if (existing) {
      assertAssetMatches(existing, { filename, bytes: fileStat.size });
      results.push({
        action: 'upload_asset',
        dry_run: false,
        status: 'already_exists',
        local_path: localPath,
        filename,
        source_ref: asset.source_ref || null,
        asset_folder_path: assetFolderPath || null,
        asset_folder_id: resolvedFolderId || null,
        bytes: fileStat.size,
        source_sha256: sourceSha256,
        id: existing.id || null,
        verification: summarizeAsset(existing)
      });
      continue;
    }

    const signed = await storyblokRequest(config, `/spaces/${config.spaceId}/assets/`, {
      method: 'POST',
      body: signPayload
    });
    await uploadSignedAsset(signed, localPath, filename, config);
    const assetId = signed.id || signed.asset?.id;
    const finished = assetId
      ? await storyblokRequest(config, `/spaces/${config.spaceId}/assets/${assetId}/finish_upload`)
      : signed;
    results.push({
      action: 'upload_asset',
      dry_run: false,
      status: 'created',
      local_path: localPath,
      filename,
      source_ref: asset.source_ref || null,
      asset_folder_path: assetFolderPath || null,
      asset_folder_id: resolvedFolderId || null,
      bytes: fileStat.size,
      source_sha256: sourceSha256,
      id: finished.asset?.id || assetId || null,
      verification: finished.asset ? summarizeAsset(finished.asset) : finished
    });
  }
  return results;
}

export async function createStoryblokPresets(manifest, {
  dryRun = false,
  env = process.env,
  componentResults = null,
  assetResults = null
} = {}) {
  const config = getStoryblokConfig(env);
  const presets = plannedPresets(manifest);
  const results = [];
  if (presets.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  const assetMap = await createStoryAssetMap(manifest, { config, dryRun, assetResults });
  if (dryRun) {
    return presets.map((preset) => ({
      action: 'create_component_preset',
      dry_run: true,
      name: preset.name,
      component_technical_name: preset.component_technical_name,
      collision_policy: 'verify_matching_or_stop',
      payload: {
        preset: {
          name: preset.name,
          component_id: '<resolved during real apply>',
          preset: hydrateStoryAssets(preset.preset, assetMap)
        }
      }
    }));
  }

  const componentIds = await resolveComponentIds(manifest, { env, componentResults });
  const existingPresets = await listStoryblokPresets(config);
  for (const preset of presets) {
    const componentId = componentIds.get(preset.component_technical_name);
    if (!componentId) {
      throw new Error(`Storyblok preset component was not resolved: ${preset.component_technical_name}`);
    }
    const intended = {
      name: preset.name,
      component_id: componentId,
      preset: hydrateStoryAssets(preset.preset, assetMap)
    };
    const existing = existingPresets.find((entry) => presetMatches(entry, intended));
    if (existing) {
      assertPresetMatches(existing, intended);
      results.push({
        action: 'create_component_preset',
        dry_run: false,
        status: 'already_exists',
        name: existing.name || preset.name,
        component_technical_name: preset.component_technical_name,
        id: existing.id || null,
        verification: summarizePreset(existing)
      });
      continue;
    }

    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/presets/`, {
      method: 'POST',
      body: {
        preset: intended
      }
    });
    const created = response.preset || response;
    existingPresets.push(created);
    results.push({
      action: 'create_component_preset',
      dry_run: false,
      status: 'created',
      name: created.name || preset.name,
      component_technical_name: preset.component_technical_name,
      id: created.id || null,
      verification: summarizePreset(created)
    });
  }
  return results;
}

export async function duplicateStoryblokComponents(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const entries = ensureArray(manifest.storyblok?.components_to_duplicate);
  const results = [];
  if (entries.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  let existingComponents = null;
  for (const entry of entries) {
    const sourceName = entry.source_technical_name || entry.source_name || entry.source;
    const targetName = entry.technical_name || entry.target_technical_name || entry.name;
    if (!sourceName || !targetName) {
      throw new Error('Storyblok component duplication entries require source_technical_name and technical_name');
    }
    if (!targetName.startsWith(manifest.storyblok_prefix)) {
      throw new Error(`duplicated Storyblok component is not namespaced: ${targetName}`);
    }

    let sourceComponent = entry.source_schema || null;
    if (!sourceComponent && !dryRun) {
      existingComponents ||= await listStoryblokComponents(config);
      sourceComponent = existingComponents.find((component) => component.name === sourceName);
      if (!sourceComponent) throw new Error(`source Storyblok component not found: ${sourceName}`);
    }
    if (!sourceComponent && dryRun) {
      results.push({
        action: 'duplicate_storyblok_component',
        dry_run: true,
        source_technical_name: sourceName,
        technical_name: targetName,
        note: 'Source schema will be fetched during real execution unless source_schema is supplied in the manifest.'
      });
      continue;
    }

    const duplicated = isolateComponentSchema(sourceComponent, targetName, manifest, entry);
    const payload = { component: duplicated };
    if (dryRun) {
      results.push({
        action: 'duplicate_storyblok_component',
        dry_run: true,
        source_technical_name: sourceName,
        technical_name: targetName,
        source_id: sourceComponent.id || null,
        source_schema_hash: sha256Json(sourceComponent.schema || {}),
        payload
      });
      continue;
    }

    const existingTarget = existingComponents.find((component) => component.name === targetName);
    if (existingTarget) {
      assertComponentMatches(existingTarget, duplicated);
      results.push({
        action: 'duplicate_storyblok_component',
        dry_run: false,
        status: 'already_exists',
        source_technical_name: sourceName,
        technical_name: existingTarget.name,
        source_id: sourceComponent.id || null,
        id: existingTarget.id || null,
        source_schema_hash: sha256Json(sourceComponent.schema || {}),
        runtime_dependency_retained: false,
        verification: summarizeComponent(existingTarget)
      });
      continue;
    }

    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`, {
      method: 'POST',
      body: payload
    });
    existingComponents.push(response.component);
    results.push({
      action: 'duplicate_storyblok_component',
      dry_run: false,
      status: 'created',
      source_technical_name: sourceName,
      technical_name: response.component?.name || targetName,
      source_id: sourceComponent.id || null,
      id: response.component?.id || null,
      source_schema_hash: sha256Json(sourceComponent.schema || {}),
      runtime_dependency_retained: false,
      verification: response.component ? summarizeComponent(response.component) : response
    });
  }

  return results;
}

export async function deleteStoryblokIntegrationResources(manifest, {
  dryRun = false,
  env = process.env,
  confirmIntegrationId,
  confirmRemoteDelete = false
} = {}) {
  if (confirmIntegrationId !== manifest.integration_id) {
    throw new Error('remote Storyblok rollback requires --confirm-integration-id matching the manifest integration_id');
  }
  if (!dryRun && !confirmRemoteDelete) {
    throw new Error('remote Storyblok rollback requires --confirm-remote-delete for real deletion');
  }
  assertRemoteRollbackIsNamespaced(manifest);

  const config = getStoryblokConfig(env);
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  return {
    action: 'storyblok_remote_rollback',
    dry_run: dryRun,
    integration_id: manifest.integration_id,
    policy: 'delete_only_manifest_owned_namespaced_resources',
    stories: await deleteIntegrationDraftStories(config, manifest, { dryRun }),
    story_folders: await deleteIntegrationStoryFolders(config, manifest, { dryRun }),
    assets: await deleteIntegrationAssets(config, manifest, { dryRun }),
    asset_folders: await deleteIntegrationAssetFolders(config, manifest, { dryRun }),
    presets: await deleteIntegrationPresets(config, manifest, { dryRun }),
    components: await deleteIntegrationComponents(config, manifest, { dryRun }),
    internal_tags: await deleteIntegrationInternalTags(config, manifest, { dryRun }),
    component_groups: await deleteIntegrationComponentGroups(config, manifest, { dryRun })
  };
}

export async function inspectStoryblokContentStory({ slug, version = 'draft', env = process.env } = {}) {
  if (!slug) throw new Error('slug is required');
  const config = getStoryblokContentConfig(env);
  const access = {
    content_api_available: Boolean(config.token),
    region: config.region,
    base_url: config.baseUrl,
    variable_names: Object.keys(env).filter((name) => /STORYBLOK|SB_/i.test(name)).sort(),
    note: 'Secret values are intentionally omitted.'
  };
  if (!config.available) {
    return {
      ...access,
      status: 'unavailable',
      reason: 'Set STORYBLOK_PREVIEW_TOKEN, STORYBLOK_PUBLIC_TOKEN, or STORYBLOK_DELIVERY_TOKEN to query the Content API.'
    };
  }
  const story = await storyblokContentRequest(config, `/stories/${encodeStorySlug(slug)}`, {
    token: config.token,
    version
  });
  return {
    ...access,
    status: 'ok',
    story: story.story ? summarizeContentStory(story.story) : story
  };
}

export async function validateStoryblokDraftContent(manifest, { dryRun = false, env = process.env, version = 'draft' } = {}) {
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  const config = getStoryblokContentConfig(env);
  if (dryRun) {
    return {
      action: 'validate_storyblok_content',
      status: 'skipped',
      reason: 'Dry run does not create draft stories.',
      stories: stories.map((story) => ({ slug: story.slug || story.full_slug, status: 'skipped' })),
      summary: emptyContentValidationSummary()
    };
  }
  if (stories.length === 0) {
    return {
      action: 'validate_storyblok_content',
      status: 'skipped',
      reason: 'Manifest does not contain draft stories.',
      stories: [],
      summary: emptyContentValidationSummary()
    };
  }
  if (!config.available) {
    return {
      action: 'validate_storyblok_content',
      status: 'skipped',
      reason: 'Set STORYBLOK_PREVIEW_TOKEN, STORYBLOK_PUBLIC_TOKEN, or STORYBLOK_DELIVERY_TOKEN to validate draft stories through the Content API.',
      stories: stories.map((story) => ({ slug: story.slug || story.full_slug, status: 'skipped' })),
      summary: emptyContentValidationSummary()
    };
  }

  const plannedSlugs = new Set(stories.map((story) => normalizeStoryLinkKey(story.slug || story.full_slug)));
  const results = [];
  for (const story of stories) {
    const slug = story.slug || story.full_slug;
    try {
      const response = await storyblokContentRequest(config, `/stories/${encodeStorySlug(slug)}`, {
        token: config.token,
        version
      }, { retryStatuses: [404] });
      const remoteStory = response.story || {};
      const content = remoteStory.content || {};
      const componentNames = collectComponentNames(content);
      const assetFields = collectAssetFields(content);
      const storyLinks = collectStoryLinks(content).filter((link) => link.linktype === 'story');
      const unresolvedGeneratedLinks = storyLinks.filter((link) => {
        const target = normalizeStoryLinkKey(link.cached_url || link.url);
        return plannedSlugs.has(target) && !link.id;
      });
      const unnamespacedComponents = componentNames.filter((name) => !String(name).startsWith(manifest.storyblok_prefix));
      const missingAssetFilenames = assetFields.filter((asset) => !asset.filename);
      const expectedRoot = story.content?.component || story.component || null;
      const checks = [
        contentCheck('root_component_namespaced', String(content.component || '').startsWith(manifest.storyblok_prefix), content.component || null),
        contentCheck('root_component_matches_manifest', !expectedRoot || content.component === expectedRoot, { expected: expectedRoot, actual: content.component || null }),
        contentCheck('all_components_namespaced', unnamespacedComponents.length === 0, unnamespacedComponents),
        contentCheck('asset_fields_have_filenames', missingAssetFilenames.length === 0, missingAssetFilenames),
        contentCheck('generated_story_links_have_uuid', unresolvedGeneratedLinks.length === 0, unresolvedGeneratedLinks.map((link) => link.cached_url || link.url))
      ];
      results.push({
        slug,
        status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
        story: summarizeContentStory(remoteStory),
        checks,
        components: componentNames.length,
        assets: assetFields.length,
        story_links: storyLinks.length,
        unresolved_generated_story_links: unresolvedGeneratedLinks.map((link) => link.cached_url || link.url)
      });
    } catch (error) {
      results.push({
        slug,
        status: 'failed',
        error: error.message || String(error),
        checks: [
          contentCheck('content_api_fetch', false, error.message || String(error))
        ]
      });
    }
  }

  return {
    action: 'validate_storyblok_content',
    status: results.every((story) => story.status === 'passed') ? 'passed' : 'failed',
    version,
    stories: results,
    summary: summarizeContentValidation(results)
  };
}

export async function reconcileStoryblokManifest(manifest, { env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  if (!config.available) {
    return {
      action: 'storyblok_reconcile',
      status: 'unavailable',
      reason: 'Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID to reconcile a manifest against the Management API.',
      summary: emptyReconcileSummary(),
      resources: []
    };
  }

  const remote = await loadRemoteStoryblokState(config);
  const components = await hydratePlannedComponents(config, manifest, remote.components);
  const stories = await hydratePlannedStories(config, manifest, remote.stories);
  const assetMap = createRemoteStoryAssetMap(manifest, remote.assets, remote.assetFolders);
  const unavailableInternalTags = remote.optionalUnavailable.find((entry) => entry.name === 'internal_tags');
  const resources = [
    ...reconcileComponentGroups(manifest, remote.componentGroups),
    ...reconcileInternalTags(manifest, remote.internalTags, unavailableInternalTags),
    ...reconcileComponents(manifest, components, remote.componentGroups),
    ...reconcileAssetFolders(manifest, remote.assetFolders),
    ...reconcileAssets(manifest, remote.assets, remote.assetFolders),
    ...reconcilePresets(manifest, remote.presets, components, assetMap),
    ...reconcileStories(manifest, stories)
  ];
  const summary = summarizeReconciliation(resources);
  return {
    action: 'storyblok_reconcile',
    status: summary.drifted > 0 || summary.blocked > 0 ? 'failed' : summary.missing > 0 ? 'incomplete' : 'passed',
    summary,
    resources
  };
}

export async function verifyStoryblokManagementState(manifest, { dryRun = false, env = process.env } = {}) {
  if (storyblokRequirements(manifest).operation_count === 0) {
    return {
      action: 'verify_storyblok_management_state',
      status: 'skipped',
      reason: 'Manifest does not contain Storyblok operations.',
      reconcile: null,
      stories: [],
      summary: emptyManagementVerificationSummary()
    };
  }
  if (dryRun) {
    return {
      action: 'verify_storyblok_management_state',
      status: 'skipped',
      reason: 'Dry run does not create remote Storyblok resources.',
      reconcile: null,
      stories: [],
      summary: emptyManagementVerificationSummary()
    };
  }

  const config = getStoryblokConfig(env);
  if (!config.available) {
    return {
      action: 'verify_storyblok_management_state',
      status: 'skipped',
      reason: 'Set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID to verify remote Storyblok resources.',
      reconcile: null,
      stories: [],
      summary: emptyManagementVerificationSummary()
    };
  }

  const reconcile = await reconcileStoryblokManifest(manifest, { env });
  const stories = await verifyManagementStories(manifest, config);
  const storyFailures = stories.filter((story) => story.status === 'failed').length;
  return {
    action: 'verify_storyblok_management_state',
    status: reconcile.status === 'passed' && storyFailures === 0 ? 'passed' : 'failed',
    reconcile,
    stories,
    summary: {
      ...emptyManagementVerificationSummary(),
      resources: reconcile.summary.total,
      matching: reconcile.summary.matching,
      missing: reconcile.summary.missing,
      drifted: reconcile.summary.drifted,
      blocked: reconcile.summary.blocked,
      story_checks: stories.length,
      failed_story_checks: storyFailures,
      unresolved_generated_story_links: stories.reduce((total, story) => total + ensureArray(story.unresolved_generated_story_links).length, 0),
      unresolved_asset_fields: stories.reduce((total, story) => total + ensureArray(story.unresolved_asset_fields).length, 0)
    }
  };
}

export async function collectStoryblokActivityEvidence(manifest = {}, {
  dryRun = false,
  env = process.env,
  since = null,
  limit = 50
} = {}) {
  if (storyblokRequirements(manifest).operation_count === 0) {
    return {
      action: 'storyblok_activity_evidence',
      status: 'skipped',
      reason: 'Manifest does not contain Storyblok operations.',
      activities: [],
      summary: { total: 0, related: 0 }
    };
  }
  if (dryRun) {
    return {
      action: 'storyblok_activity_evidence',
      status: 'skipped',
      reason: 'Dry run does not create remote Storyblok activity.',
      activities: [],
      summary: { total: 0, related: 0 }
    };
  }

  const config = getStoryblokConfig(env);
  if (!config.available) {
    return {
      action: 'storyblok_activity_evidence',
      status: 'skipped',
      reason: 'Storyblok Management API credentials are unavailable.',
      activities: [],
      summary: { total: 0, related: 0 }
    };
  }

  try {
    const maxItems = Math.max(Number(limit) || 50, 1);
    const activities = await listStoryblokActivities(config, { per_page: Math.min(maxItems, 100) }, { maxItems });
    const related = filterIntegrationActivities(activities, manifest, since);
    return {
      action: 'storyblok_activity_evidence',
      status: 'recorded',
      since,
      activities: related.map(summarizeActivity),
      summary: {
        total: activities.length,
        related: related.length
      }
    };
  } catch (error) {
    return {
      action: 'storyblok_activity_evidence',
      status: 'unavailable',
      reason: error.message || String(error),
      activities: [],
      summary: { total: 0, related: 0 }
    };
  }
}

async function storyblokRequest(config, endpoint, { method = 'GET', body } = {}) {
  const serializedBody = body ? JSON.stringify(body) : undefined;
  const retryLimit = Math.max(Number(config.retryLimit) || 0, 0);
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    await throttleStoryblokRequest(config);
    const timeout = createTimeout(config.timeoutMs);
    let response;
    try {
      response = await fetch(`${config.baseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: config.token,
          'Content-Type': 'application/json'
        },
        body: serializedBody,
        signal: timeout.signal
      });
    } catch (error) {
      timeout.clear();
      if (isAbortError(error)) {
        throw new Error(`Storyblok ${method} ${endpoint} timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    }
    timeout.clear();
    const text = await response.text();
    const data = parseJsonOrText(text);
    if (response.ok) return data;

    if (attempt < retryLimit && shouldRetryStoryblokStatus(response.status)) {
      const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'));
      const fallbackDelay = retryDelayMs(config, attempt);
      await sleep(retryAfter ?? fallbackDelay);
      continue;
    }

    throw new Error(`Storyblok ${method} ${endpoint} failed with ${response.status}: ${safeError(data)}`);
  }
}

async function storyblokContentRequest(config, endpoint, params = {}, { retryStatuses = [] } = {}) {
  const search = new URLSearchParams(params);
  const retryLimit = Math.max(Number(config.retryLimit) || 0, 0);
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const timeout = createTimeout(config.timeoutMs);
    let response;
    try {
      response = await fetch(`${config.baseUrl}${endpoint}?${search.toString()}`, {
        headers: {
          Accept: 'application/json'
        },
        signal: timeout.signal
      });
    } catch (error) {
      timeout.clear();
      if (isAbortError(error)) {
        throw new Error(`Storyblok Content API GET ${endpoint} timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    }
    timeout.clear();
    const text = await response.text();
    const data = parseJsonOrText(text);
    if (response.ok) return data;

    if (attempt < retryLimit && shouldRetryStoryblokStatus(response.status, retryStatuses)) {
      const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'));
      const fallbackDelay = retryDelayMs(config, attempt);
      await sleep(retryAfter ?? fallbackDelay);
      continue;
    }

    throw new Error(`Storyblok Content API GET ${endpoint} failed with ${response.status}: ${safeError(data)}`);
  }
}

async function listStoryblokComponents(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/components/`, 'components', params, options);
}

async function getStoryblokComponent(config, componentId) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/${componentId}`);
  return response.component || response;
}

async function listStoryblokComponentGroups(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/component_groups/`, 'component_groups', params, options);
}

async function listStoryblokInternalTags(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/internal_tags/`, 'internal_tags', params, options);
}

async function listStoryblokPresets(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/presets/`, 'presets', params, options);
}

async function listStoryblokAssetFolders(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/asset_folders/`, 'asset_folders', params, options);
}

async function listStoryblokStories(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/stories`, 'stories', params, options);
}

async function getStoryblokStory(config, storyId) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories/${storyId}`);
  return response.story || response;
}

async function listStoryblokAssets(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/assets`, 'assets', params, options);
}

async function listStoryblokWorkflows(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/workflows`, 'workflows', params, options);
}

async function listStoryblokWorkflowStages(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/workflow_stages/`, ['workflow_stages', 'stages'], params, options);
}

async function listStoryblokReleases(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/releases`, 'releases', params, options);
}

async function listStoryblokWebhookEndpoints(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/webhook_endpoints/`, ['webhook_endpoints', 'webhooks'], params, options);
}

async function listStoryblokDatasources(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/datasources/`, 'datasources', params, options);
}

async function listStoryblokDatasourceEntries(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/datasource_entries/`, 'datasource_entries', params, options);
}

async function listStoryblokCollaborators(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/collaborators/`, 'collaborators', params, options);
}

async function listStoryblokSpaceRoles(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/space_roles/`, 'space_roles', params, options);
}

async function listStoryblokActivities(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/activities`, 'activities', params, options);
}

async function listStoryblokTasks(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/tasks/`, 'tasks', params, options);
}

async function listStoryblokTags(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/tags`, 'tags', params, options);
}

async function listStoryblokBranches(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/branches/`, 'branches', params, options);
}

async function listStoryblokApprovals(config, params = {}, options = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/approvals/`, 'approvals', params, options);
}

async function listPaginated(config, endpoint, key, params = {}, { maxItems = 0 } = {}) {
  const perPage = Number(params.per_page || 100);
  const results = [];
  const keys = Array.isArray(key) ? key : [key];
  for (let page = 1; ; page += 1) {
    const response = await storyblokRequest(config, endpointWithQuery(endpoint, {
      ...params,
      per_page: perPage,
      page
    }));
    const entries = Array.isArray(response)
      ? response
      : keys.flatMap((entryKey) => ensureArray(response[entryKey]));
    const remaining = Number(maxItems) > 0 ? Math.max(Number(maxItems) - results.length, 0) : entries.length;
    results.push(...entries.slice(0, remaining));
    if (entries.length < perPage || (Number(maxItems) > 0 && results.length >= Number(maxItems))) break;
  }
  return results;
}

async function inspectStoryblokAuditResources(config, listOptions) {
  const definitions = [
    ['workflows', listStoryblokWorkflows, summarizeWorkflow],
    ['workflow_stages', listStoryblokWorkflowStages, summarizeWorkflowStage],
    ['releases', listStoryblokReleases, summarizeRelease],
    ['webhook_endpoints', listStoryblokWebhookEndpoints, summarizeWebhookEndpoint],
    ['datasources', listStoryblokDatasources, summarizeDatasource],
    ['datasource_entries', listStoryblokDatasourceEntries, summarizeDatasourceEntry],
    ['collaborators', listStoryblokCollaborators, summarizeCollaborator],
    ['space_roles', listStoryblokSpaceRoles, summarizeSpaceRole],
    ['activities', listStoryblokActivities, summarizeActivity],
    ['tasks', listStoryblokTasks, summarizeTask],
    ['tags', listStoryblokTags, summarizeTag],
    ['branches', listStoryblokBranches, summarizeBranch],
    ['approvals', listStoryblokApprovals, summarizeApproval]
  ];
  const collections = {};
  const unavailable = [];
  for (const [name, listFn, summarizeFn] of definitions) {
    const result = await optionalStoryblokCollection(config, name, listFn, summarizeFn, listOptions);
    collections[name] = result;
    if (result.status !== 'ok') unavailable.push({ name, reason: result.reason });
  }
  return {
    action: 'storyblok_audit',
    status: unavailable.length > 0 ? 'partial' : 'ok',
    collections,
    unavailable,
    summary: Object.fromEntries(Object.entries(collections).map(([name, collection]) => [name, collection.count || 0]))
  };
}

async function optionalStoryblokCollection(config, name, listFn, summarizeFn, listOptions) {
  try {
    const items = await listFn(config, {}, listOptions);
    return {
      status: 'ok',
      count: items.length,
      items: items.map(summarizeFn)
    };
  } catch (error) {
    return {
      status: 'unavailable',
      count: 0,
      reason: error.message || String(error),
      items: []
    };
  }
}

async function optionalStoryblokItems(config, name, listFn, params = {}, options = {}) {
  try {
    return {
      name,
      status: 'ok',
      items: await listFn(config, params, options)
    };
  } catch (error) {
    return {
      name,
      status: 'unavailable',
      items: [],
      reason: error.message || String(error)
    };
  }
}

async function loadRemoteStoryblokState(config) {
  const [
    componentGroups,
    internalTagsResult,
    components,
    assetFolders,
    assets,
    presets,
    stories
  ] = await Promise.all([
    listStoryblokComponentGroups(config),
    optionalStoryblokItems(config, 'internal_tags', listStoryblokInternalTags),
    listStoryblokComponents(config),
    listStoryblokAssetFolders(config),
    listStoryblokAssets(config),
    listStoryblokPresets(config),
    listStoryblokStories(config)
  ]);
  return {
    componentGroups,
    internalTags: internalTagsResult.items,
    optionalUnavailable: [
      ...(internalTagsResult.status === 'ok' ? [] : [{ name: 'internal_tags', reason: internalTagsResult.reason }])
    ],
    components,
    assetFolders,
    assets,
    presets,
    stories
  };
}

function reconcileComponentGroups(manifest, componentGroups) {
  const groups = plannedComponentGroups(manifest);
  const resolved = resolvePlannedComponentGroups(componentGroups, groups);
  return groups.map((group) => {
    const existing = resolved.get(group.path);
    return existing
      ? reconcileItem('storyblok_component_group', group.path, 'matching', { id: existing.id, uuid: existing.uuid || null })
      : reconcileItem('storyblok_component_group', group.path, 'missing');
  });
}

function reconcileInternalTags(manifest, internalTags, unavailable = null) {
  return plannedInternalTags(manifest).map((tag) => {
    if (unavailable) {
      return reconcileItem('storyblok_internal_tag', tag.name, 'present_unverified', {
        object_type: tag.object_type,
        optional: true,
        reason: unavailable.reason
      });
    }
    const existing = internalTags.find((entry) => internalTagMatches(entry, tag));
    return existing
      ? reconcileItem('storyblok_internal_tag', tag.name, 'matching', { id: existing.id || null, object_type: tag.object_type })
      : reconcileItem('storyblok_internal_tag', tag.name, 'missing', { object_type: tag.object_type });
  });
}

function reconcileComponents(manifest, components, componentGroups) {
  const groupUuids = resolveComponentGroupUuidMap(manifest, componentGroups);
  const created = ensureArray(manifest.storyblok?.components_to_create).map((component) => {
    const name = component.technical_name || component.name;
    const existing = components.find((entry) => entry.name === name);
    if (!existing) return reconcileItem('storyblok_component', name, 'missing');
    try {
      assertComponentMatches(existing, normalizeComponent(component, {
        componentGroupUuid: component.component_group_uuid ||
          (component.component_group_path ? groupUuids.get(component.component_group_path) : null)
      }));
      return reconcileItem('storyblok_component', name, 'matching', { id: existing.id || null });
    } catch (error) {
      return reconcileItem('storyblok_component', name, 'drifted', { id: existing.id || null, reason: error.message || String(error) });
    }
  });
  const duplicated = ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => {
    const name = component.technical_name || component.name || component.target_technical_name;
    const existing = components.find((entry) => entry.name === name);
    return existing
      ? reconcileItem('storyblok_component', name, component.source_schema ? 'matching' : 'present_unverified', { id: existing.id || null, source: component.source_technical_name || component.source_name || null })
      : reconcileItem('storyblok_component', name, 'missing', { source: component.source_technical_name || component.source_name || null });
  });
  return [...created, ...duplicated];
}

function reconcileAssetFolders(manifest, assetFolders) {
  const folders = plannedAssetFolders(manifest);
  const resolved = resolvePlannedFolders(assetFolders, folders);
  return folders.map((folder) => {
    const existing = resolved.get(folder.path);
    return existing
      ? reconcileItem('storyblok_asset_folder', folder.path, 'matching', { id: existing.id || null })
      : reconcileItem('storyblok_asset_folder', folder.path, 'missing');
  });
}

function reconcileAssets(manifest, assets, assetFolders) {
  const folders = plannedAssetFolders(manifest);
  const resolvedFolders = resolvePlannedFolders(assetFolders, folders);
  return ensureArray(manifest.storyblok?.assets_to_create).map((asset) => {
    const filename = asset.filename || asset.path || asset.local_path;
    const folderPath = asset.asset_folder_path || defaultAssetFolderPath(manifest);
    const folder = folderPath ? resolvedFolders.get(folderPath) : null;
    const existing = assets.find((entry) => isExactStoryblokAssetMatch(entry, filename, {
      assetFolderId: folder?.id || asset.asset_folder_id || null,
      manifest
    }));
    if (!existing) return reconcileItem('storyblok_asset', filename, 'missing', { asset_folder_path: folderPath || null });
    try {
      assertAssetMatches(existing, { filename, bytes: asset.size || null });
      return reconcileItem('storyblok_asset', filename, 'matching', { id: existing.id || null, asset_folder_path: folderPath || null });
    } catch (error) {
      return reconcileItem('storyblok_asset', filename, 'drifted', { id: existing.id || null, reason: error.message || String(error) });
    }
  });
}

function reconcilePresets(manifest, presets, components, assetMap = new Map()) {
  return plannedPresets(manifest).map((preset) => {
    const component = components.find((entry) => entry.name === preset.component_technical_name);
    if (!component) return reconcileItem('storyblok_preset', preset.name, 'blocked', { reason: `component missing: ${preset.component_technical_name}` });
    const intended = {
      name: preset.name,
      component_id: component.id,
      preset: hydrateStoryAssets(preset.preset, assetMap)
    };
    const existing = presets.find((entry) => presetMatches(entry, intended));
    if (!existing) return reconcileItem('storyblok_preset', preset.name, 'missing', { component_technical_name: preset.component_technical_name });
    try {
      assertPresetMatches(existing, intended);
      return reconcileItem('storyblok_preset', preset.name, 'matching', { id: existing.id || null, component_technical_name: preset.component_technical_name });
    } catch (error) {
      return reconcileItem('storyblok_preset', preset.name, 'drifted', { id: existing.id || null, reason: error.message || String(error) });
    }
  });
}

function createRemoteStoryAssetMap(manifest, remoteAssets, assetFolders) {
  const map = new Map();
  const folders = plannedAssetFolders(manifest);
  const resolvedFolders = resolvePlannedFolders(assetFolders, folders);
  for (const asset of ensureArray(manifest.storyblok?.assets_to_create)) {
    const filename = asset.filename || asset.path || asset.local_path;
    const folderPath = asset.asset_folder_path || defaultAssetFolderPath(manifest);
    const folder = folderPath ? resolvedFolders.get(folderPath) : null;
    const existing = remoteAssets.find((entry) => isExactStoryblokAssetMatch(entry, filename, {
      assetFolderId: folder?.id || asset.asset_folder_id || null,
      manifest
    }));
    if (!existing) continue;
    const reference = storyAssetReference(asset, {
      id: existing.id || null,
      filename,
      verification: summarizeAsset(existing)
    }, { dryRun: false });
    for (const key of storyAssetReferenceKeys(asset)) {
      map.set(key, reference);
    }
  }
  return map;
}

function reconcileStories(manifest, stories) {
  return ensureArray(manifest.storyblok?.stories_to_create).map((story) => {
    const slug = story.slug || story.full_slug;
    const existing = stories.find((entry) => entry.full_slug === slug || entry.slug === slug);
    if (!existing) return reconcileItem('storyblok_story', slug, 'missing');
    try {
      assertStoryOwnedForRollback(existing, manifest, slug);
      return reconcileItem('storyblok_story', slug, 'matching', {
        id: existing.id || null,
        uuid: existing.uuid || null,
        published: Boolean(existing.published_at)
      });
    } catch (error) {
      return reconcileItem('storyblok_story', slug, 'blocked', {
        id: existing.id || null,
        reason: error.message || String(error)
      });
    }
  });
}

function resolveComponentGroupUuidMap(manifest, componentGroups) {
  const groups = plannedComponentGroups(manifest);
  const resolved = resolvePlannedComponentGroups(componentGroups, groups);
  return new Map(groups
    .map((group) => [group.path, resolved.get(group.path)?.uuid || null])
    .filter(([, uuid]) => uuid));
}

function reconcileItem(resourceType, resource, status, details = {}) {
  return {
    resource_type: resourceType,
    resource,
    status,
    ...details
  };
}

function summarizeReconciliation(resources) {
  return resources.reduce((summary, resource) => {
    summary.total += 1;
    if (resource.status === 'matching' || resource.status === 'present_unverified') summary.matching += 1;
    else if (resource.status === 'missing') summary.missing += 1;
    else if (resource.status === 'drifted') summary.drifted += 1;
    else if (resource.status === 'blocked') summary.blocked += 1;
    return summary;
  }, emptyReconcileSummary());
}

function emptyReconcileSummary() {
  return {
    total: 0,
    matching: 0,
    missing: 0,
    drifted: 0,
    blocked: 0
  };
}

async function findStoryBySlug(config, slug) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories?by_slugs=${encodeURIComponent(slug)}&per_page=1`);
  const story = ensureArray(response.stories).find((entry) => entry.full_slug === slug || entry.slug === slug) || null;
  if (!story) return null;
  return hydrateStoryDetail(config, story);
}

async function hydratePlannedComponents(config, manifest, components) {
  const names = new Set([
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => component.technical_name || component.name),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => component.technical_name || component.name || component.target_technical_name)
  ].filter(Boolean));
  return Promise.all(ensureArray(components).map(async (component) => {
    if (!names.has(component.name)) return component;
    if (Object.hasOwn(component, 'schema') && Object.hasOwn(component, 'is_root') && Object.hasOwn(component, 'is_nestable')) return component;
    return hydrateComponentDetail(config, component);
  }));
}

async function hydrateComponentDetail(config, component) {
  if (!component?.id) return component;
  const detail = await getStoryblokComponent(config, component.id);
  return { ...component, ...detail };
}

async function hydratePlannedStories(config, manifest, stories) {
  const slugs = new Set(ensureArray(manifest.storyblok?.stories_to_create)
    .map((story) => normalizeStoryLinkKey(story.slug || story.full_slug))
    .filter(Boolean));
  return Promise.all(ensureArray(stories).map(async (story) => {
    const slug = normalizeStoryLinkKey(story.full_slug || story.slug);
    if (!slugs.has(slug)) return story;
    return hydrateStoryDetail(config, story);
  }));
}

async function hydrateStoryDetail(config, story) {
  if (storyHasContent(story) || !story?.id) return story;
  const detail = await getStoryblokStory(config, story.id);
  return { ...story, ...detail };
}

function storyHasContent(story) {
  return Boolean(story && Object.hasOwn(story, 'content') && story.content && typeof story.content === 'object');
}

async function listStoryFolders(config) {
  const stories = await listStoryblokStories(config);
  return stories.filter((story) => story.is_folder);
}

async function resolveStoryTarget(config, story) {
  const planned = plannedStoryTarget(story);
  if (!planned.parent_parts.length) return planned;

  const folders = await listStoryFolders(config);
  const folderResults = [];
  let parentId = 0;
  let currentPath = '';
  for (const part of planned.parent_parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = folders.find((folder) =>
      folder.is_folder &&
      (folder.full_slug === currentPath || (folder.slug === part && Number(folder.parent_id || 0) === Number(parentId || 0)))
    );
    if (existing) {
      parentId = existing.id;
      folderResults.push({
        action: 'create_story_folder',
        status: 'already_exists',
        slug: existing.full_slug || currentPath,
        id: existing.id
      });
      continue;
    }

    const conflicting = await findStoryBySlug(config, currentPath);
    if (conflicting && !conflicting.is_folder) {
      throw new Error(`Storyblok draft folder collision is not a folder: ${currentPath}`);
    }

    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories`, {
      method: 'POST',
      body: {
        story: {
          is_folder: true,
          name: titleFromSlug(part),
          slug: part,
          parent_id: parentId
        }
      }
    });
    const created = response.story || response;
    folders.push(created);
    parentId = created.id;
    folderResults.push({
      action: 'create_story_folder',
      status: 'created',
      slug: created.full_slug || currentPath,
      id: created.id
    });
  }

  return {
    ...planned,
    parent_id: parentId,
    folder_results: folderResults
  };
}

function plannedStoryTarget(story) {
  const parts = String(story.slug || '').split('/').filter(Boolean);
  const slug = parts.at(-1) || String(story.slug || '');
  const parentParts = parts.slice(0, -1);
  return {
    full_slug: parts.length ? parts.join('/') : slug,
    slug,
    parent_slug: parentParts.join('/') || null,
    parent_parts: parentParts,
    parent_id: story.parent_id || 0,
    folder_results: []
  };
}

function plannedStoryFolderSlugs(manifest) {
  const folders = new Set();
  for (const story of ensureArray(manifest.storyblok?.stories_to_create)) {
    const parts = String(story.slug || story.full_slug || '').split('/').filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      const folder = parts.slice(0, index + 1).join('/');
      if (folder === 'integration-preview') continue;
      if (isIntegrationOwnedStorySlug(manifest, folder)) folders.add(folder);
    }
  }
  return [...folders].sort((left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left));
}

function draftStoryPayload(story, target, content) {
  return {
    story: {
      name: story.name || lastSlugSegment(target.full_slug),
      slug: target.slug,
      content,
      is_startpage: Boolean(story.is_startpage),
      parent_id: target.parent_id
    },
    publish: false
  };
}

function storyblokEditorUrl(config, storyId) {
  if (!config?.spaceId || !storyId) return null;
  const baseUrl = STORYBLOK_APP_BASE_URLS[config.region] || STORYBLOK_APP_BASE_URLS.eu;
  return `${baseUrl}/#/me/spaces/${config.spaceId}/stories/0/0/${storyId}`;
}

async function updateDraftStoryContent(config, story, target, content, existing) {
  const id = existing?.id;
  if (!id) throw new Error(`Storyblok draft story update requires an id: ${existing?.full_slug || story.slug}`);
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories/${id}`, {
    method: 'PUT',
    body: draftStoryPayload(story, {
      ...target,
      parent_id: existing.parent_id ?? target.parent_id,
      slug: existing.slug || target.slug,
      full_slug: existing.full_slug || target.full_slug
    }, content)
  });
  return response.story || response;
}

function createStoryReferenceMap(entries) {
  const references = new Map();
  for (const entry of entries) {
    const remote = entry.remote || entry.existing || entry.created;
    const fullSlug = remote?.full_slug || entry.target?.full_slug || entry.story?.slug;
    const reference = {
      uuid: remote?.uuid || null,
      full_slug: fullSlug,
      numeric_id: remote?.id || null
    };
    for (const key of unique([
      fullSlug,
      entry.story?.slug,
      remote?.full_slug,
      remote?.default_full_slug
    ].filter(Boolean))) {
      references.set(normalizeStoryLinkKey(key), reference);
    }
  }
  return references;
}

async function findAssetByFilename(config, filename, { assetFolderId = null, manifest = null } = {}) {
  const assets = await listStoryblokAssets(config, { search: path.basename(filename) });
  return assets.find((asset) => isExactStoryblokAssetMatch(asset, filename, { assetFolderId, manifest })) || null;
}

async function createStoryAssetMap(manifest, { config, dryRun, assetResults = null }) {
  const map = new Map();
  const assets = ensureArray(manifest.storyblok?.assets_to_create);
  if (assets.length === 0) return map;
  const resultsByFilename = new Map(ensureArray(assetResults)
    .filter((result) => result?.filename)
    .map((result) => [result.filename, result]));

  for (const asset of assets) {
    const filename = asset.filename || asset.path || asset.local_path;
    let result = filename ? resultsByFilename.get(filename) : null;
    if (!dryRun && !result && filename) {
      const existing = await findAssetByFilename(config, filename, { manifest });
      if (existing) {
        result = {
          action: 'resolve_asset',
          dry_run: false,
          status: 'already_exists',
          filename,
          id: existing.id || null,
          verification: summarizeAsset(existing)
        };
      }
    }
    if (!dryRun && !result) continue;
    const reference = storyAssetReference(asset, result, { dryRun });
    for (const key of storyAssetReferenceKeys(asset)) {
      map.set(key, reference);
    }
  }
  return map;
}

function hydrateStoryAssets(value, assetMap) {
  if (!value || assetMap.size === 0) return value;
  if (Array.isArray(value)) return value.map((entry) => hydrateStoryAssets(entry, assetMap));
  if (typeof value !== 'object') return value;

  const existingFilename = typeof value.filename === 'string' ? value.filename : null;
  const resolved = existingFilename ? assetMap.get(normalizeStoryAssetKey(existingFilename)) : null;
  if (resolved) {
    return {
      ...value,
      ...resolved,
      alt: value.alt || resolved.alt || '',
      title: value.title || resolved.title || '',
      fieldtype: 'asset'
    };
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hydrateStoryAssets(entry, assetMap)]));
}

function hydrateStoryLinks(value, storyReferences) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => hydrateStoryLinks(entry, storyReferences));
  if (isStoryblokLinkValue(value)) return hydrateStoryLinkValue(value, storyReferences);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hydrateStoryLinks(entry, storyReferences)]));
}

function hydrateStoryLinkValue(link, storyReferences) {
  const next = {
    ...link,
    fieldtype: 'multilink'
  };
  if (next.linktype === 'story') {
    const reference = storyReferences.get(normalizeStoryLinkKey(next.cached_url));
    if (reference?.uuid) next.id = reference.uuid;
    if (reference?.full_slug) next.cached_url = reference.full_slug;
    if (!Object.hasOwn(next, 'url')) next.url = '';
  }
  return next;
}

function isStoryblokLinkValue(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.linktype === 'string' &&
    ('url' in value || 'cached_url' in value || 'id' in value);
}

function normalizeStoryLinkKey(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');
}

function storyAssetReference(asset, result, { dryRun }) {
  const verification = result?.verification || {};
  return {
    id: verification.id || result?.id || asset.id || null,
    filename: verification.filename || (!dryRun ? result?.filename : null) || asset.filename || asset.path || asset.local_path || '',
    alt: asset.alt || verification.alt || '',
    title: verification.title || '',
    fieldtype: 'asset'
  };
}

function storyAssetReferenceKeys(asset) {
  return unique([
    asset.source_ref,
    asset.local_path,
    asset.filename,
    asset.path,
    asset.file,
    normalizeStoryAssetKey(asset.source_ref),
    normalizeStoryAssetKey(asset.local_path),
    normalizeStoryAssetKey(asset.filename),
    normalizeStoryAssetKey(asset.path),
    normalizeStoryAssetKey(asset.file)
  ].filter(Boolean));
}

function normalizeStoryAssetKey(value) {
  if (!value) return '';
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

async function deleteIntegrationDraftStories(config, manifest, { dryRun }) {
  const stories = uniqueBy(ensureArray(manifest.storyblok?.stories_to_create), (story) => story.slug || story.full_slug);
  const results = [];
  for (const story of stories) {
    const slug = story.slug || story.full_slug;
    if (dryRun) {
      results.push({
        action: 'delete_draft_story',
        dry_run: true,
        slug,
        collision_policy: 'delete_only_unpublished_story_with_namespaced_root_component'
      });
      continue;
    }
    const existing = await findStoryBySlug(config, slug);
    if (!existing) {
      results.push({ action: 'delete_draft_story', dry_run: false, status: 'missing', slug });
      continue;
    }
    assertStoryOwnedForRollback(existing, manifest, slug);
    await storyblokRequest(config, `/spaces/${config.spaceId}/stories/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_draft_story',
      dry_run: false,
      status: 'deleted',
      slug,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationStoryFolders(config, manifest, { dryRun }) {
  const folderSlugs = plannedStoryFolderSlugs(manifest);
  if (folderSlugs.length === 0) return [];
  if (dryRun) {
    return folderSlugs.map((slug) => ({
      action: 'delete_story_folder',
      dry_run: true,
      slug,
      collision_policy: 'delete_only_integration_owned_story_folder'
    }));
  }

  const folders = await listStoryFolders(config);
  const results = [];
  for (const slug of folderSlugs) {
    const existing = folders.find((folder) => folder.is_folder && (folder.full_slug === slug || folder.slug === slug));
    if (!existing) {
      results.push({ action: 'delete_story_folder', dry_run: false, status: 'missing', slug });
      continue;
    }
    if (!isIntegrationOwnedStorySlug(manifest, existing.full_slug || existing.slug || slug)) {
      throw new Error(`remote rollback refused for non-integration Storyblok folder slug: ${existing.full_slug || slug}`);
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/stories/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_story_folder',
      dry_run: false,
      status: 'deleted',
      slug: existing.full_slug || slug,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationAssets(config, manifest, { dryRun }) {
  const assets = uniqueBy(ensureArray(manifest.storyblok?.assets_to_create), (asset) => asset.id || asset.filename || asset.local_path);
  const results = [];
  for (const asset of assets) {
    const filename = asset.filename || asset.path || asset.local_path;
    if (dryRun) {
      results.push({
        action: 'delete_asset',
        dry_run: true,
        filename,
        id: asset.id || null,
        collision_policy: 'delete_only_exact_namespaced_asset_match'
      });
      continue;
    }
    const existing = await findRollbackAsset(config, manifest, asset);
    if (!existing) {
      results.push({
        action: 'delete_asset',
        dry_run: false,
        status: 'not_found_or_unverified',
        filename,
        id: asset.id || null
      });
      continue;
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/assets/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_asset',
      dry_run: false,
      status: 'deleted',
      filename,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationAssetFolders(config, manifest, { dryRun }) {
  const folders = plannedAssetFolders(manifest).reverse();
  const results = [];
  if (folders.length === 0) return results;
  if (dryRun) {
    return folders.map((folder) => ({
      action: 'delete_asset_folder',
      dry_run: true,
      folder_path: folder.path,
      collision_policy: 'delete_only_matching_namespaced_folder'
    }));
  }

  const existingFolders = await listStoryblokAssetFolders(config);
  const resolved = resolvePlannedFolders(existingFolders, folders);
  for (const folder of folders) {
    const existing = resolved.get(folder.path);
    if (!existing) {
      results.push({ action: 'delete_asset_folder', dry_run: false, status: 'missing', folder_path: folder.path });
      continue;
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/asset_folders/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_asset_folder',
      dry_run: false,
      status: 'deleted',
      folder_path: folder.path,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationPresets(config, manifest, { dryRun }) {
  const presets = plannedPresets(manifest);
  if (presets.length === 0) return [];
  if (dryRun) {
    return presets.map((preset) => ({
      action: 'delete_component_preset',
      dry_run: true,
      name: preset.name,
      component_technical_name: preset.component_technical_name,
      collision_policy: 'delete_only_namespaced_matching_component_preset'
    }));
  }

  const componentIds = await resolveComponentIds(manifest, { config });
  const existingPresets = await listStoryblokPresets(config);
  const results = [];
  for (const preset of presets) {
    const componentId = componentIds.get(preset.component_technical_name);
    const existing = componentId
      ? existingPresets.find((entry) => presetMatches(entry, { name: preset.name, component_id: componentId }))
      : null;
    if (!existing) {
      results.push({
        action: 'delete_component_preset',
        dry_run: false,
        status: 'missing',
        name: preset.name,
        component_technical_name: preset.component_technical_name
      });
      continue;
    }
    if (!preset.name.startsWith(manifest.storyblok_prefix) || !preset.component_technical_name.startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok preset: ${preset.name}`);
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/presets/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_component_preset',
      dry_run: false,
      status: 'deleted',
      name: preset.name,
      component_technical_name: preset.component_technical_name,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationComponents(config, manifest, { dryRun }) {
  const names = unique([
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => component.technical_name || component.name || component),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => component.technical_name || component.name || component)
  ]);
  if (names.length === 0) return [];
  const results = [];
  if (dryRun) {
    return names.map((name) => ({
      action: 'delete_component',
      dry_run: true,
      technical_name: name,
      collision_policy: 'delete_only_namespaced_component'
    }));
  }

  const existingComponents = await listStoryblokComponents(config);
  for (const name of names) {
    const existing = existingComponents.find((component) => component.name === name);
    if (!existing) {
      results.push({ action: 'delete_component', dry_run: false, status: 'missing', technical_name: name });
      continue;
    }
    if (!String(existing.name || '').startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok component: ${existing.name}`);
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/components/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_component',
      dry_run: false,
      status: 'deleted',
      technical_name: name,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationInternalTags(config, manifest, { dryRun }) {
  const tags = plannedInternalTags(manifest);
  if (tags.length === 0) return [];
  if (dryRun) {
    return tags.map((tag) => ({
      action: 'delete_internal_tag',
      dry_run: true,
      name: tag.name,
      object_type: tag.object_type,
      collision_policy: 'delete_only_namespaced_internal_tag'
    }));
  }

  const existingTagsResult = await optionalStoryblokItems(config, 'internal_tags', listStoryblokInternalTags);
  if (existingTagsResult.status !== 'ok') {
    return tags.map((tag) => ({
      action: 'delete_internal_tag',
      dry_run: false,
      status: 'skipped_optional',
      name: tag.name,
      object_type: tag.object_type,
      reason: 'Storyblok internal tags are unavailable for this space, token, region, or plan.',
      details: existingTagsResult.reason
    }));
  }
  const existingTags = existingTagsResult.items;
  const results = [];
  for (const tag of tags) {
    const existing = existingTags.find((entry) => internalTagMatches(entry, tag));
    if (!existing) {
      results.push({
        action: 'delete_internal_tag',
        dry_run: false,
        status: 'missing',
        name: tag.name,
        object_type: tag.object_type
      });
      continue;
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/internal_tags/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_internal_tag',
      dry_run: false,
      status: 'deleted',
      name: tag.name,
      object_type: tag.object_type,
      id: existing.id
    });
  }
  return results;
}

async function deleteIntegrationComponentGroups(config, manifest, { dryRun }) {
  const groups = plannedComponentGroups(manifest).reverse();
  if (groups.length === 0) return [];
  if (dryRun) {
    return groups.map((group) => ({
      action: 'delete_component_group',
      dry_run: true,
      group_path: group.path,
      collision_policy: 'delete_only_matching_namespaced_component_folder'
    }));
  }

  const existingGroups = await listStoryblokComponentGroups(config);
  const resolved = resolvePlannedComponentGroups(existingGroups, groups);
  const results = [];
  for (const group of groups) {
    const existing = resolved.get(group.path);
    if (!existing) {
      results.push({ action: 'delete_component_group', dry_run: false, status: 'missing', group_path: group.path });
      continue;
    }
    await storyblokRequest(config, `/spaces/${config.spaceId}/component_groups/${existing.id}`, { method: 'DELETE' });
    results.push({
      action: 'delete_component_group',
      dry_run: false,
      status: 'deleted',
      group_path: group.path,
      id: existing.id,
      uuid: existing.uuid || null
    });
  }
  return results;
}

function assertComponentMatches(existing, intended) {
  const existingComponent = existing?.component || existing || {};
  const intendedComponent = intended?.component || intended || {};
  const intendedName = intendedComponent.name || intendedComponent.technical_name;
  const existingName = existingComponent.name || existingComponent.technical_name;
  const mismatches = [];

  if (existingName !== intendedName) {
    mismatches.push(`name expected ${intendedName || 'unknown'} but found ${existingName || 'missing'}`);
  }

  const expectedDisplayName = intendedComponent.display_name || titleFromTechnicalName(intendedName);
  const actualDisplayName = existingComponent.display_name || titleFromTechnicalName(existingName);
  if (actualDisplayName !== expectedDisplayName) {
    mismatches.push(`display_name expected ${expectedDisplayName || 'empty'} but found ${actualDisplayName || 'empty'}`);
  }

  if (Boolean(existingComponent.is_root) !== Boolean(intendedComponent.is_root)) {
    mismatches.push(`is_root expected ${Boolean(intendedComponent.is_root)} but found ${Boolean(existingComponent.is_root)}`);
  }
  if (Boolean(existingComponent.is_nestable) !== Boolean(intendedComponent.is_nestable)) {
    mismatches.push(`is_nestable expected ${Boolean(intendedComponent.is_nestable)} but found ${Boolean(existingComponent.is_nestable)}`);
  }

  const expectedPreviewField = intendedComponent.preview_field || 'headline';
  const actualPreviewField = existingComponent.preview_field || expectedPreviewField;
  if (actualPreviewField !== expectedPreviewField) {
    mismatches.push(`preview_field expected ${expectedPreviewField} but found ${actualPreviewField}`);
  }

  if (intendedComponent.component_group_uuid && existingComponent.component_group_uuid &&
    existingComponent.component_group_uuid !== intendedComponent.component_group_uuid) {
    mismatches.push(`component_group_uuid expected ${intendedComponent.component_group_uuid} but found ${existingComponent.component_group_uuid}`);
  }

  const existingSchema = existingComponent.schema || {};
  for (const [fieldName, intendedField] of Object.entries(intendedComponent.schema || {})) {
    if (!Object.hasOwn(existingSchema, fieldName)) {
      mismatches.push(`schema.${fieldName} is missing`);
      continue;
    }
    const mismatch = findJsonContractMismatch(existingSchema[fieldName], intendedField, `schema.${fieldName}`);
    if (mismatch) mismatches.push(mismatch);
  }

  if (mismatches.length > 0) {
    const details = mismatches.slice(0, 4).join('; ');
    throw new Error(`Storyblok component drift detected for ${intendedName}; ${details}.`);
  }
}

function assertPresetMatches(existing, intended) {
  if (sha256Json(existing.preset || {}) !== sha256Json(intended.preset || {})) {
    throw new Error(`Storyblok preset drift detected for ${intended.name}; existing preset does not match the manifest.`);
  }
}

function assertRemoteRollbackIsNamespaced(manifest) {
  for (const story of ensureArray(manifest.storyblok?.stories_to_create)) {
    const slug = story.slug || story.full_slug;
    if (!isIntegrationOwnedStorySlug(manifest, slug)) {
      throw new Error(`remote rollback refused for non-integration Storyblok story slug: ${slug}`);
    }
  }
  for (const component of [
    ...ensureArray(manifest.storyblok?.components_to_create),
    ...ensureArray(manifest.storyblok?.components_to_duplicate)
  ]) {
    const name = component.technical_name || component.name || component;
    if (!String(name).startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok component: ${name}`);
    }
  }
  for (const asset of ensureArray(manifest.storyblok?.assets_to_create)) {
    const filename = asset.filename || asset.path || asset.local_path;
    if (filename && !String(filename).startsWith(`${manifest.integration_id}/`) && !String(filename).startsWith(`${manifest.storyblok_prefix}`)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok asset: ${filename}`);
    }
  }
  for (const folder of plannedAssetFolders(manifest)) {
    if (!String(folder.path).startsWith(manifest.integration_id) && !String(folder.path).startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok asset folder: ${folder.path}`);
    }
  }
  for (const group of plannedComponentGroups(manifest)) {
    if (!String(group.path).startsWith(manifest.integration_id) && !String(group.path).startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok component folder: ${group.path}`);
    }
  }
  for (const tag of plannedInternalTags(manifest)) {
    if (!String(tag.name).startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok internal tag: ${tag.name}`);
    }
  }
  for (const preset of plannedPresets(manifest)) {
    if (!String(preset.name).startsWith(manifest.storyblok_prefix) || !String(preset.component_technical_name).startsWith(manifest.storyblok_prefix)) {
      throw new Error(`remote rollback refused for unnamespaced Storyblok preset: ${preset.name}`);
    }
  }
}

function assertStoryOwnedForRollback(existing, manifest, plannedSlug) {
  if (existing.published_at) {
    throw new Error(`remote rollback refused to delete published Storyblok story: ${existing.full_slug || plannedSlug}`);
  }
  const rootComponent = existing.content?.component;
  if (!String(rootComponent || '').startsWith(manifest.storyblok_prefix)) {
    throw new Error(`remote rollback refused for Storyblok story without namespaced root component: ${existing.full_slug || plannedSlug}`);
  }
  if (!isIntegrationOwnedStorySlug(manifest, existing.full_slug || existing.slug || plannedSlug)) {
    throw new Error(`remote rollback refused for non-integration Storyblok story slug: ${existing.full_slug || plannedSlug}`);
  }
}

async function findRollbackAsset(config, manifest, asset) {
  if (asset.id) return { id: asset.id };
  const filename = asset.filename || asset.path || asset.local_path;
  if (!filename) return null;
  return findAssetByFilename(config, filename, { manifest });
}

function isExactStoryblokAssetMatch(asset, plannedFilename, { assetFolderId = null, manifest = null } = {}) {
  const values = [asset.filename, asset.short_filename, asset.name].filter(Boolean).map(String);
  const normalizedPlanned = normalizeStoryAssetKey(plannedFilename);
  const basename = path.basename(normalizedPlanned);
  const assetFolderMatches = assetFolderId &&
    Number(asset.asset_folder_id || asset.folder_id || asset.asset_folder?.id || 0) === Number(assetFolderId);
  if (assetFolderMatches && values.some((value) => path.basename(normalizeStoryAssetKey(value)) === basename)) return true;
  return values.some((value) => {
    const normalizedValue = normalizeStoryAssetKey(value);
    if (normalizedValue === normalizedPlanned || normalizedValue.endsWith(`/${normalizedPlanned}`)) return true;
    return manifest &&
      normalizedValue.includes(`/${manifest.integration_id}/`) &&
      normalizedPlanned.startsWith(`${manifest.integration_id}/`) &&
      normalizedValue.endsWith(`/${normalizedPlanned}`);
  });
}

function resolvePlannedFolders(existingFolders, folders) {
  const ascending = [...folders].reverse();
  const resolved = new Map();
  for (const folder of ascending) {
    const parentId = folder.parent_path ? resolved.get(folder.parent_path)?.id : folder.parent_id || 0;
    const existing = existingFolders.find((entry) => entry.name === folder.name && Number(entry.parent_id || 0) === Number(parentId || 0));
    if (existing) resolved.set(folder.path, existing);
  }
  return resolved;
}

function resolvePlannedComponentGroups(existingGroups, groups) {
  const ascending = [...groups].reverse();
  const resolved = new Map();
  for (const group of ascending) {
    const parent = group.parent_path ? resolved.get(group.parent_path) : rootComponentGroupParent(group);
    const existing = existingGroups.find((entry) => componentGroupMatches(entry, group.name, parent));
    if (existing) resolved.set(group.path, existing);
  }
  return resolved;
}

function assertStoryMatches(existing, intended) {
  if (existing.published_at) {
    throw new Error(`Storyblok story collision is published and cannot be reused safely: ${existing.full_slug || intended.slug}`);
  }
  const exact = sameJson(existing.content || {}, intended.content || {});
  if (exact) return { exact: true, metadata_only_difference: false };
  if (sha256Json(comparableStoryContent(existing.content || {})) !== sha256Json(comparableStoryContent(intended.content || {}))) {
    throw new Error(`Storyblok draft story drift detected for ${intended.slug}; existing story does not match the manifest.`);
  }
  return {
    exact: false,
    metadata_only_difference: true,
    repairable_link_metadata_difference: hasRepairableStoryLinkMetadataDifference(existing.content || {}, intended.content || {})
  };
}

function sameJson(left, right) {
  return sha256Json(left || {}) === sha256Json(right || {});
}

function comparableStoryContent(value) {
  if (Array.isArray(value)) return value.map(comparableStoryContent);
  if (!value || typeof value !== 'object') return value;
  if (isStoryblokLinkValue(value)) {
    const comparable = { ...value };
    delete comparable.fieldtype;
    if (comparable.linktype === 'story') {
      delete comparable.id;
      delete comparable.url;
    }
    return comparable;
  }
  if (isStoryblokAssetValue(value)) return comparableStoryAsset(value);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isStoryblokContentMetadataKey(key))
    .map(([key, entry]) => [key, comparableStoryContent(entry)]));
}

function hasRepairableStoryLinkMetadataDifference(existingContent, intendedContent) {
  const existingLinks = collectStoryLinks(existingContent).filter((link) => link.linktype === 'story');
  const intendedLinks = collectStoryLinks(intendedContent).filter((link) => link.linktype === 'story');
  if (existingLinks.length !== intendedLinks.length) return false;
  return intendedLinks.some((intendedLink, index) => {
    const existingLink = existingLinks[index];
    if (!existingLink || normalizeStoryLinkKey(existingLink.cached_url || existingLink.url) !== normalizeStoryLinkKey(intendedLink.cached_url || intendedLink.url)) {
      return false;
    }
    return Boolean(intendedLink.id && existingLink.id !== intendedLink.id) ||
      (intendedLink.fieldtype && existingLink.fieldtype !== intendedLink.fieldtype) ||
      (Object.hasOwn(intendedLink, 'url') && !Object.hasOwn(existingLink, 'url'));
  });
}

function isStoryblokAssetValue(value) {
  return value &&
    typeof value === 'object' &&
    (value.fieldtype === 'asset' || ('filename' in value && ('id' in value || 'alt' in value || 'title' in value)));
}

function comparableStoryAsset(value) {
  const id = value.id ? String(value.id) : null;
  const comparable = {
    alt: value.alt || '',
    title: value.title || ''
  };
  if (id) {
    comparable.id = id;
  } else {
    comparable.filename = normalizeStoryAssetKey(value.filename || '');
  }
  return comparable;
}

function isStoryblokContentMetadataKey(key) {
  return key === '_editable';
}

function canRepairDraftStoryLinkMetadata(existing, manifest, plannedSlug) {
  if (!manifest.integration_id || !manifest.storyblok_prefix) return false;
  if (existing.published_at) return false;
  if (!String(existing.content?.component || '').startsWith(manifest.storyblok_prefix)) return false;
  return isIntegrationOwnedStorySlug(manifest, existing.full_slug || existing.slug || plannedSlug);
}

function assertAssetMatches(existing, intended) {
  const existingBytes = existing.content_length || existing.size || existing.file_size;
  if (existingBytes && intended.bytes && Number(existingBytes) !== Number(intended.bytes)) {
    throw new Error(`Storyblok asset drift detected for ${intended.filename}; existing asset size differs.`);
  }
}

function isolateComponentSchema(sourceComponent, targetName, manifest, entry) {
  const schema = JSON.parse(JSON.stringify(sourceComponent.schema || {}));
  const nestedMap = entry.nested_component_map || {};
  for (const field of Object.values(schema)) {
    if (Array.isArray(field.component_whitelist)) {
      field.component_whitelist = field.component_whitelist.map((name) => {
        if (nestedMap[name]) return nestedMap[name];
        if (String(name).startsWith(manifest.storyblok_prefix)) return name;
        return `${manifest.storyblok_prefix}${name}`;
      });
    }
  }
  return {
    name: targetName,
    display_name: entry.display_name || titleFromTechnicalName(targetName),
    is_root: entry.component_type === 'content_type' || (entry.is_root ?? Boolean(sourceComponent.is_root)),
    is_nestable: entry.component_type === 'nestable' || (entry.is_nestable ?? Boolean(sourceComponent.is_nestable)),
    schema,
    preview_field: entry.preview_field || sourceComponent.preview_field || 'headline',
    component_group_id: entry.component_group_id,
    component_group_uuid: entry.component_group_uuid
  };
}

function sha256Json(value) {
  return sha256(stableJson(value));
}

async function uploadSignedAsset(signedResponse, localPath, filename, config = {}) {
  const postUrl = signedResponse.post_url || signedResponse.upload_url;
  const fields = signedResponse.fields || {};
  if (!postUrl) throw new Error('Storyblok signed asset response did not include post_url');
  const buffer = await readFile(localPath);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([buffer]), filename);
  const timeout = createTimeout(config.timeoutMs);
  let response;
  try {
    response = await fetch(postUrl, { method: 'POST', body: form, signal: timeout.signal });
  } catch (error) {
    timeout.clear();
    if (isAbortError(error)) {
      throw new Error(`asset upload timed out after ${config.timeoutMs}ms`);
    }
    throw error;
  }
  timeout.clear();
  if (!response.ok) {
    throw new Error(`asset upload failed with ${response.status}`);
  }
}

function normalizeComponent(component, { componentGroupUuid = null } = {}) {
  const name = component.name || component.technical_name;
  const normalized = {
    name,
    display_name: component.display_name || titleFromTechnicalName(name),
    is_root: component.component_type === 'content_type' || component.is_root === true,
    is_nestable: component.component_type === 'nestable' || component.is_nestable === true,
    schema: component.schema || defaultSchemaFor(component),
    preview_field: component.preview_field || 'headline',
    component_group_id: component.component_group_id
  };
  if (componentGroupUuid || component.component_group_uuid) normalized.component_group_uuid = componentGroupUuid || component.component_group_uuid;
  return normalized;
}

function defaultSchemaFor(component) {
  const isRoot = component.component_type === 'content_type' || component.is_root === true;
  if (isRoot) {
    return {
      body: {
        type: 'bloks',
        restrict_components: true,
        component_whitelist: ensureArray(component.allowed_children),
        description: 'Integration-owned content blocks.'
      }
    };
  }
  return {
    headline: {
      type: 'text',
      translatable: true,
      description: 'Section headline.'
    },
    body: {
      type: 'textarea',
      translatable: true,
      description: 'Section body copy.'
    }
  };
}

function findJsonContractMismatch(existing, intended, pathName) {
  if (intended === undefined) return null;
  const normalizedExisting = existing === undefined ? implicitStoryblokValue(intended) : existing;

  if (Array.isArray(intended)) {
    if (!Array.isArray(normalizedExisting)) return `${pathName} expected an array`;
    if (intended.every(isPrimitiveContractValue)) {
      const existingValues = normalizedExisting.map(normalizePrimitiveContractValue).sort();
      const intendedValues = intended.map(normalizePrimitiveContractValue).sort();
      if (!sameJson(existingValues, intendedValues)) return `${pathName} expected ${stableJson(intendedValues)} but found ${stableJson(existingValues)}`;
      return null;
    }
    if (normalizedExisting.length !== intended.length) {
      return `${pathName} expected ${intended.length} item(s) but found ${normalizedExisting.length}`;
    }
    for (let index = 0; index < intended.length; index += 1) {
      const mismatch = findJsonContractMismatch(normalizedExisting[index], intended[index], `${pathName}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }

  if (intended && typeof intended === 'object') {
    if (!normalizedExisting || typeof normalizedExisting !== 'object' || Array.isArray(normalizedExisting)) {
      return `${pathName} expected an object`;
    }
    for (const [key, value] of Object.entries(intended)) {
      const existingValue = Object.hasOwn(normalizedExisting, key)
        ? normalizedExisting[key]
        : implicitStoryblokFieldValue(key, value);
      const mismatch = findJsonContractMismatch(existingValue, value, `${pathName}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }

  if (!primitiveContractValuesMatch(normalizedExisting, intended)) {
    return `${pathName} expected ${stableJson(intended)} but found ${stableJson(normalizedExisting)}`;
  }
  return null;
}

function implicitStoryblokValue(intended) {
  if (intended === false) return false;
  if (intended === '') return '';
  if (intended === null) return null;
  if (Array.isArray(intended) && intended.length === 0) return [];
  return undefined;
}

function implicitStoryblokFieldValue(key, intended) {
  if (intended === false && [
    'required',
    'translatable',
    'tooltip',
    'restrict_components',
    'use_uuid',
    'exclude_empty_option'
  ].includes(key)) return false;
  if (intended === '' && [
    'default_value',
    'description',
    'display_name',
    'datasource_slug',
    'external_datasource',
    'folder_slug',
    'source'
  ].includes(key)) return '';
  if (Array.isArray(intended) && intended.length === 0) return [];
  return undefined;
}

function isPrimitiveContractValue(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function normalizePrimitiveContractValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(Number(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function primitiveContractValuesMatch(existing, intended) {
  if (intended === null) return existing === null || existing === undefined || existing === '';
  if (typeof intended === 'number') return Number(existing) === intended;
  if (typeof intended === 'boolean') {
    if (typeof existing === 'string') return existing.toLowerCase() === String(intended);
    return Boolean(existing) === intended;
  }
  if (typeof intended === 'string') return String(existing ?? '') === intended;
  return sameJson(existing, intended);
}

function storyblokRequirements(manifest) {
  const componentCount = ensureArray(manifest.storyblok?.components_to_create).length +
    ensureArray(manifest.storyblok?.components_to_duplicate).length;
  const componentGroupCount = plannedComponentGroups(manifest).length;
  const internalTagCount = plannedInternalTags(manifest).length;
  const assetFolderCount = plannedAssetFolders(manifest).length;
  const assetCount = ensureArray(manifest.storyblok?.assets_to_create).length;
  const presetCount = plannedPresets(manifest).length;
  const storyCount = ensureArray(manifest.storyblok?.stories_to_create).length;
  return {
    component_groups: componentGroupCount > 0,
    internal_tags: internalTagCount > 0,
    components: componentCount > 0,
    asset_folders: assetFolderCount > 0,
    assets: assetCount > 0,
    presets: presetCount > 0,
    stories: storyCount > 0,
    operation_count: componentGroupCount + internalTagCount + componentCount + assetFolderCount + assetCount + presetCount + storyCount,
    counts: {
      component_groups: componentGroupCount,
      internal_tags: internalTagCount,
      components: componentCount,
      asset_folders: assetFolderCount,
      assets: assetCount,
      presets: presetCount,
      stories: storyCount
    }
  };
}

function preflightCheck(name, passed, message, { required = true, optional = false, details = null } = {}) {
  return {
    name,
    status: passed ? 'passed' : required ? 'failed' : 'warning',
    required,
    optional,
    message,
    details
  };
}

function storyblokPermissionMatrix(requirements, checks, { dryRun = false } = {}) {
  const checksByName = new Map(ensureArray(checks).map((check) => [check.name, check]));
  const definitions = [
    ['component_groups', 'component_groups_read', 'component_group_create', false],
    ['internal_tags', 'internal_tags_read', 'internal_tag_create', true],
    ['components', 'components_read', 'component_create', false],
    ['asset_folders', 'asset_folders_read', 'asset_folder_create', false],
    ['assets', 'assets_read', 'asset_upload', false],
    ['presets', 'presets_read', 'component_preset_create', false],
    ['stories', 'stories_read', 'draft_story_create', false]
  ];
  return Object.fromEntries(definitions.map(([requirement, readCheckName, createName, optional]) => {
    const planned = Boolean(requirements[requirement]);
    const readCheck = checksByName.get(readCheckName);
    const credentialsReady = Boolean(checksByName.get('management_token')?.status === 'passed' && checksByName.get('space_id')?.status === 'passed');
    return [requirement, {
      planned,
      read: planned
        ? readCheck?.status || (dryRun ? 'not_checked_in_dry_run' : 'not_checked')
        : 'not_required',
      additive_create: planned
        ? dryRun
          ? 'not_checked_in_dry_run'
          : optional && readCheck && readCheck.status !== 'passed'
            ? 'optional_skipped_when_unavailable'
          : credentialsReady && readCheck?.status === 'passed'
            ? `${createName}_verified_during_create_call`
            : 'blocked_until_read_access_passes'
        : 'not_required'
    }];
  }));
}

async function endpointPreflight(config, name, endpoint, options = {}) {
  try {
    await storyblokRequest(config, endpoint);
    return preflightCheck(name, true, `${name.replaceAll('_', ' ')} endpoint is readable.`, options);
  } catch (error) {
    return preflightCheck(name, false, `${name.replaceAll('_', ' ')} endpoint is not readable.`, {
      ...options,
      details: error.message || String(error)
    });
  }
}

function contentCheck(name, passed, details = null) {
  return {
    name,
    status: passed ? 'passed' : 'failed',
    details
  };
}

function emptyContentValidationSummary() {
  return {
    stories: 0,
    passed: 0,
    failed: 0,
    components: 0,
    assets: 0,
    story_links: 0,
    unresolved_generated_story_links: 0
  };
}

function summarizeContentValidation(results) {
  return results.reduce((summary, result) => ({
    stories: summary.stories + 1,
    passed: summary.passed + (result.status === 'passed' ? 1 : 0),
    failed: summary.failed + (result.status === 'failed' ? 1 : 0),
    components: summary.components + Number(result.components || 0),
    assets: summary.assets + Number(result.assets || 0),
    story_links: summary.story_links + Number(result.story_links || 0),
    unresolved_generated_story_links: summary.unresolved_generated_story_links + ensureArray(result.unresolved_generated_story_links).length
  }), emptyContentValidationSummary());
}

async function verifyManagementStories(manifest, config) {
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  const plannedSlugs = new Set(stories.map((story) => normalizeStoryLinkKey(story.slug || story.full_slug)));
  const results = [];
  for (const story of stories) {
    const slug = story.slug || story.full_slug;
    try {
      const existing = await findStoryBySlug(config, slug);
      if (!existing) {
        results.push({
          slug,
          status: 'failed',
          checks: [
            contentCheck('management_story_exists', false, slug)
          ],
          unresolved_generated_story_links: [],
          unresolved_asset_fields: []
        });
        continue;
      }

      const content = existing.content || {};
      const componentNames = collectComponentNames(content);
      const unnamespacedComponents = componentNames.filter((name) => !String(name).startsWith(manifest.storyblok_prefix));
      const storyLinks = collectStoryLinks(content).filter((link) => link.linktype === 'story');
      const unresolvedGeneratedLinks = storyLinks.filter((link) => {
        const target = normalizeStoryLinkKey(link.cached_url || link.url);
        return plannedSlugs.has(target) && !link.id;
      });
      const generatedLinksOutsidePlan = storyLinks.filter((link) => {
        const target = normalizeStoryLinkKey(link.cached_url || link.url);
        return target.startsWith(`${manifest.integration_id}/`) && !plannedSlugs.has(target);
      });
      const assetFields = collectAssetFields(content);
      const unresolvedAssetFields = assetFields.filter((asset) => {
        const filename = String(asset.filename || '');
        return !asset.id || !filename || filename.startsWith('.') || filename.startsWith('/') || filename.includes('/templates/');
      });
      const checks = [
        contentCheck('management_story_exists', true, existing.full_slug || slug),
        contentCheck('story_is_unpublished_draft', !existing.published_at, existing.published_at || null),
        contentCheck('root_component_namespaced', String(content.component || '').startsWith(manifest.storyblok_prefix), content.component || null),
        contentCheck('all_components_namespaced', unnamespacedComponents.length === 0, unnamespacedComponents),
        contentCheck('generated_story_links_have_uuid', unresolvedGeneratedLinks.length === 0, unresolvedGeneratedLinks.map((link) => link.cached_url || link.url)),
        contentCheck('generated_story_links_target_planned_routes', generatedLinksOutsidePlan.length === 0, generatedLinksOutsidePlan.map((link) => link.cached_url || link.url)),
        contentCheck('asset_fields_are_uploaded_storyblok_assets', unresolvedAssetFields.length === 0, unresolvedAssetFields.map((asset) => asset.filename || asset.id || 'asset_field'))
      ];
      results.push({
        slug,
        status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
        story: summarizeStory(existing),
        checks,
        components: componentNames.length,
        story_links: storyLinks.length,
        asset_fields: assetFields.length,
        unresolved_generated_story_links: unresolvedGeneratedLinks.map((link) => link.cached_url || link.url),
        generated_links_outside_plan: generatedLinksOutsidePlan.map((link) => link.cached_url || link.url),
        unresolved_asset_fields: unresolvedAssetFields.map((asset) => asset.filename || asset.id || 'asset_field')
      });
    } catch (error) {
      results.push({
        slug,
        status: 'failed',
        error: error.message || String(error),
        checks: [
          contentCheck('management_story_fetch', false, error.message || String(error))
        ],
        unresolved_generated_story_links: [],
        unresolved_asset_fields: []
      });
    }
  }
  return results;
}

function emptyManagementVerificationSummary() {
  return {
    resources: 0,
    matching: 0,
    missing: 0,
    drifted: 0,
    blocked: 0,
    story_checks: 0,
    failed_story_checks: 0,
    unresolved_generated_story_links: 0,
    unresolved_asset_fields: 0
  };
}

function summarizeStoryLinks(content, storyReferences = new Map()) {
  const links = collectStoryLinks(content);
  const storyLinks = links.filter((link) => link.linktype === 'story');
  const unresolvedTargets = [];
  let resolvedStoryLinks = 0;
  for (const link of storyLinks) {
    const target = normalizeStoryLinkKey(link.cached_url || link.url);
    const reference = storyReferences.get(target);
    if (link.id || reference?.uuid) {
      resolvedStoryLinks += 1;
    } else if (target) {
      unresolvedTargets.push(target);
    }
  }
  return {
    total_links: links.length,
    story_links: storyLinks.length,
    url_links: links.filter((link) => link.linktype === 'url').length,
    resolved_story_links: resolvedStoryLinks,
    unresolved_story_links: unresolvedTargets.length,
    unresolved_story_link_targets: unique(unresolvedTargets).slice(0, 20)
  };
}

function collectComponentNames(value, names = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectComponentNames(entry, names);
    return names;
  }
  if (!value || typeof value !== 'object') return names;
  if (typeof value.component === 'string') names.push(value.component);
  for (const entry of Object.values(value)) collectComponentNames(entry, names);
  return unique(names);
}

function collectAssetFields(value, assets = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectAssetFields(entry, assets);
    return assets;
  }
  if (!value || typeof value !== 'object') return assets;
  if (value.fieldtype === 'asset' || ('filename' in value && ('id' in value || 'alt' in value || 'title' in value))) {
    assets.push(value);
  }
  for (const entry of Object.values(value)) collectAssetFields(entry, assets);
  return assets;
}

function collectStoryLinks(value, links = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectStoryLinks(entry, links);
    return links;
  }
  if (!value || typeof value !== 'object') return links;
  if (isStoryblokLinkValue(value)) links.push(value);
  for (const entry of Object.values(value)) collectStoryLinks(entry, links);
  return links;
}

function summarizeStoryblokReadiness({
  space,
  components,
  stories,
  assets,
  assetFolders,
  componentGroups,
  internalTags,
  presets,
  audit
}) {
  const auditCollections = audit?.collections || {};
  const unavailable = ensureArray(audit?.unavailable);
  const webhookCount = auditCollections.webhook_endpoints?.count || 0;
  const workflowCount = auditCollections.workflows?.count || 0;
  const releaseCount = auditCollections.releases?.count || 0;
  return {
    space_id: space?.id || null,
    core_counts: {
      component_groups: componentGroups.length,
      components: components.length,
      stories: stories.length,
      asset_folders: assetFolders.length,
      assets: assets.length,
      internal_tags: internalTags.length,
      presets: presets.length
    },
    governance: audit
      ? {
        workflows: workflowCount,
        releases: releaseCount,
        collaborators: auditCollections.collaborators?.count || 0,
        space_roles: auditCollections.space_roles?.count || 0,
        tasks: auditCollections.tasks?.count || 0,
        approvals: auditCollections.approvals?.count || 0
      }
      : null,
    automation: audit
      ? {
        webhook_endpoints: webhookCount,
        webhook_impact_review_recommended: webhookCount > 0
      }
      : null,
    warnings: [
      ...(webhookCount > 0 ? [`${webhookCount} webhook endpoint(s) may react to imported draft resources.`] : []),
      ...(workflowCount === 0 && audit ? ['No workflows were visible to the Management API; imported drafts may not enter an editorial review workflow automatically.'] : []),
      ...(unavailable.length > 0 ? [`${unavailable.length} optional Storyblok audit collection(s) were unavailable for this token or plan.`] : [])
    ]
  };
}

function summarizeSpace(space) {
  return {
    id: space.id,
    name: space.name,
    domain: space.domain,
    version: space.version
  };
}

function summarizeComponent(component) {
  return {
    technical_name: component.name,
    display_name: component.display_name,
    id: component.id,
    component_group_uuid: component.component_group_uuid || null,
    type: component.is_root ? 'content_type' : 'nestable',
    fields: Object.keys(component.schema || {}),
    allowed_children: Object.values(component.schema || {})
      .filter((field) => field.type === 'bloks')
      .flatMap((field) => ensureArray(field.component_whitelist))
  };
}

function summarizeComponentGroup(group, groupPath = null) {
  return {
    id: group.id,
    uuid: group.uuid || null,
    name: group.name,
    parent_id: group.parent_id || 0,
    parent_uuid: group.parent_uuid || null,
    group_path: groupPath
  };
}

function summarizeStory(story) {
  return {
    name: story.name,
    id: story.id,
    slug: story.full_slug || story.slug,
    root_component: story.content?.component || null,
    status: story.published_at ? 'published' : 'draft'
  };
}

function summarizeAsset(asset) {
  return {
    id: asset.id,
    filename: asset.filename || asset.short_filename,
    title: asset.title || null,
    alt: asset.alt || null
  };
}

function summarizeAssetFolder(folder, folderPath = null) {
  return {
    id: folder.id,
    uuid: folder.uuid || null,
    name: folder.name,
    parent_id: folder.parent_id || 0,
    folder_path: folderPath
  };
}

function summarizeInternalTag(tag) {
  return {
    id: tag.id,
    name: tag.name,
    object_type: tag.object_type || tag.object || tag.type || null
  };
}

function summarizePreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    component_id: preset.component_id || preset.component?.id || null,
    preset_hash: sha256Json(preset.preset || {})
  };
}

function summarizeWorkflow(workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    stages: ensureArray(workflow.stages || workflow.workflow_stages).length
  };
}

function summarizeWorkflowStage(stage) {
  return {
    id: stage.id,
    name: stage.name,
    workflow_id: stage.workflow_id || null,
    position: stage.position ?? null
  };
}

function summarizeRelease(release) {
  return {
    id: release.id,
    name: release.name,
    released_at: release.released_at || release.release_at || null,
    status: release.status || null
  };
}

function summarizeWebhookEndpoint(webhook) {
  return {
    id: webhook.id,
    name: webhook.name || webhook.description || null,
    endpoint: redactUrl(webhook.endpoint || webhook.url || ''),
    actions: ensureArray(webhook.actions || webhook.events)
  };
}

function summarizeDatasource(datasource) {
  return {
    id: datasource.id,
    name: datasource.name,
    slug: datasource.slug || datasource.datasource_slug || null,
    dimensions: ensureArray(datasource.dimensions).length
  };
}

function summarizeDatasourceEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    value: entry.value,
    datasource_id: entry.datasource_id || null,
    dimension_value: entry.dimension_value || null
  };
}

function summarizeCollaborator(collaborator) {
  return {
    id: collaborator.id,
    userid: collaborator.userid || collaborator.user_id || null,
    role: collaborator.role || collaborator.user_role || null,
    permissions_count: ensureArray(collaborator.permissions).length
  };
}

function summarizeSpaceRole(role) {
  return {
    id: role.id,
    name: role.name,
    permissions_count: ensureArray(role.permissions).length
  };
}

function summarizeActivity(activity) {
  return {
    id: activity.id,
    action: activity.action || activity.event || activity.type || null,
    resource: activity.item_type || activity.resource_type || activity.object_type || null,
    item_id: activity.item_id || activity.object_id || null,
    created_at: activity.created_at || activity.timestamp || null,
    user_id: activity.user_id || activity.author_id || null
  };
}

function summarizeTask(task) {
  return {
    id: task.id,
    name: task.name || task.description || null,
    status: task.status || null,
    story_id: task.story_id || null,
    assignee_id: task.assignee_id || task.user_id || null
  };
}

function summarizeTag(tag) {
  return {
    id: tag.id,
    name: tag.name || tag,
    taggings_count: tag.taggings_count || tag.count || null
  };
}

function summarizeBranch(branch) {
  return {
    id: branch.id,
    name: branch.name,
    source_id: branch.source_id || null,
    deployed: branch.deployed ?? null
  };
}

function summarizeApproval(approval) {
  return {
    id: approval.id,
    status: approval.status || null,
    story_id: approval.story_id || null,
    workflow_stage_id: approval.workflow_stage_id || null
  };
}

function filterIntegrationActivities(activities, manifest, since) {
  const sinceTime = since ? Date.parse(since) : null;
  const terms = unique([
    manifest?.integration_id,
    manifest?.storyblok_prefix,
    ...ensureArray(manifest?.storyblok?.stories_to_create).map((story) => story.slug || story.full_slug),
    ...ensureArray(manifest?.storyblok?.components_to_create).map((component) => component.technical_name || component.name),
    ...ensureArray(manifest?.storyblok?.assets_to_create).map((asset) => asset.filename || asset.path)
  ].filter(Boolean).map(String));
  return ensureArray(activities).filter((activity) => {
    const timestamp = Date.parse(activity.created_at || activity.timestamp || '');
    if (Number.isFinite(sinceTime) && Number.isFinite(timestamp) && timestamp < sinceTime) return false;
    if (terms.length === 0) return true;
    const text = JSON.stringify(activity);
    return terms.some((term) => text.includes(term));
  });
}

function summarizeContentStory(story) {
  return {
    name: story.name,
    id: story.id,
    uuid: story.uuid,
    slug: story.full_slug || story.slug,
    root_component: story.content?.component || null,
    content_hash: sha256Json(story.content || {}),
    published_at: story.published_at || null
  };
}

function titleFromTechnicalName(name) {
  return String(name)
    .replace(/^hts_/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function titleFromSlug(slug) {
  return String(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function lastSlugSegment(slug) {
  return String(slug).split('/').filter(Boolean).at(-1) || 'Integration Preview';
}

async function resolveAssetFolderIds(manifest, { env = process.env } = {}) {
  const folders = await createStoryblokAssetFolders(manifest, { env });
  return new Map(folders.filter((folder) => folder.id).map((folder) => [folder.folder_path, folder.id]));
}

async function resolveComponentGroupUuids(manifest, { env = process.env, componentGroupResults = null } = {}) {
  const results = componentGroupResults || await createStoryblokComponentGroups(manifest, { env });
  return new Map(results
    .filter((group) => group.group_path && (group.uuid || group.verification?.uuid))
    .map((group) => [group.group_path, group.uuid || group.verification.uuid]));
}

async function resolveComponentIds(manifest, { env = process.env, componentResults = null, config = null } = {}) {
  const resultMap = new Map(ensureArray(componentResults)
    .filter((result) => result?.technical_name && result?.id)
    .map((result) => [result.technical_name, result.id]));
  const missing = plannedPresets(manifest)
    .map((preset) => preset.component_technical_name)
    .filter((name) => name && !resultMap.has(name));
  if (missing.length === 0) return resultMap;

  const resolvedConfig = config || getStoryblokConfig(env);
  const components = await listStoryblokComponents(resolvedConfig);
  for (const component of components) {
    if (component.name && component.id && missing.includes(component.name)) {
      resultMap.set(component.name, component.id);
    }
  }
  return resultMap;
}

function plannedComponentGroups(manifest) {
  const explicit = ensureArray(manifest.storyblok?.component_groups_to_create);
  const fromComponents = ensureArray(manifest.storyblok?.components_to_create)
    .map((component) => component.component_group_path || component.component_group)
    .filter(Boolean)
    .map((groupPath) => ({ path: groupPath }));
  const planned = [];
  const seen = new Set();
  for (const entry of [...explicit, ...fromComponents]) {
    for (const group of expandComponentGroup(entry)) {
      if (seen.has(group.path)) continue;
      seen.add(group.path);
      planned.push(group);
    }
  }
  return planned.sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
}

function expandComponentGroup(entry) {
  const groupPath = String(entry.path || entry.name || entry.component_group_path || entry || '').replace(/^\/+|\/+$/g, '');
  if (!groupPath) return [];
  const parts = groupPath.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    path: parts.slice(0, index + 1).join('/'),
    name: index === parts.length - 1 && entry.name ? entry.name : part,
    parent_path: index > 0 ? parts.slice(0, index).join('/') : null,
    parent_id: index === 0 ? entry.parent_id || 0 : undefined,
    parent_uuid: index === 0 ? entry.parent_uuid || null : undefined
  }));
}

function rootComponentGroupParent(group) {
  return {
    id: group.parent_id || 0,
    uuid: group.parent_uuid || null
  };
}

function componentGroupPayload(group, parent) {
  const payload = {
    name: group.name
  };
  const parentUuid = parent?.uuid || group.parent_uuid;
  const parentId = parent?.id || group.parent_id;
  if (parentUuid) payload.parent_uuid = parentUuid;
  else if (parentId) payload.parent_id = parentId;
  return payload;
}

function componentGroupMatches(entry, name, parent) {
  if (entry.name !== name) return false;
  const parentUuid = parent?.uuid || null;
  const parentId = Number(parent?.id || 0);
  if (parentUuid) return entry.parent_uuid === parentUuid;
  return Number(entry.parent_id || 0) === parentId;
}

function plannedInternalTags(manifest) {
  const seen = new Set();
  const tags = [];
  for (const entry of ensureArray(manifest.storyblok?.internal_tags_to_create)) {
    const tag = normalizeInternalTag(entry);
    const key = `${tag.object_type}:${tag.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function normalizeInternalTag(entry) {
  return {
    name: String(entry.name || entry.tag || entry || ''),
    object_type: String(entry.object_type || entry.object || entry.type || 'component')
  };
}

function internalTagMatches(entry, tag) {
  return entry.name === tag.name && String(entry.object_type || entry.object || entry.type || 'component') === tag.object_type;
}

function plannedPresets(manifest) {
  const seen = new Set();
  const presets = [];
  for (const entry of ensureArray(manifest.storyblok?.presets_to_create)) {
    const componentTechnicalName = entry.component_technical_name || entry.component || entry.technical_name;
    const name = String(entry.name || `${componentTechnicalName}_default`);
    const preset = entry.preset || entry.content || entry.default_values || {};
    const key = `${componentTechnicalName}:${name}`;
    if (!componentTechnicalName || seen.has(key)) continue;
    seen.add(key);
    presets.push({
      name,
      component_technical_name: String(componentTechnicalName),
      preset
    });
  }
  return presets;
}

function presetMatches(entry, intended) {
  return String(entry.name || '') === intended.name &&
    Number(entry.component_id || entry.component?.id || 0) === Number(intended.component_id || 0);
}

function plannedAssetFolders(manifest) {
  const explicit = ensureArray(manifest.storyblok?.asset_folders_to_create);
  const fromAssets = ensureArray(manifest.storyblok?.assets_to_create)
    .map((asset) => asset.asset_folder_path || asset.asset_folder)
    .filter(Boolean)
    .map((folderPath) => ({ path: folderPath }));
  const planned = [];
  const seen = new Set();
  for (const entry of [...explicit, ...fromAssets]) {
    for (const folder of expandAssetFolder(entry, manifest)) {
      if (seen.has(folder.path)) continue;
      seen.add(folder.path);
      planned.push(folder);
    }
  }
  return planned.sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
}

function expandAssetFolder(entry, manifest) {
  const folderPath = String(entry.path || entry.name || entry || defaultAssetFolderPath(manifest) || '').replace(/^\/+|\/+$/g, '');
  if (!folderPath) return [];
  const parts = folderPath.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    path: parts.slice(0, index + 1).join('/'),
    name: index === parts.length - 1 && entry.name ? entry.name : part,
    parent_path: index > 0 ? parts.slice(0, index).join('/') : null,
    parent_id: index === 0 ? entry.parent_id || 0 : undefined
  }));
}

function defaultAssetFolderPath(manifest) {
  const first = ensureArray(manifest.storyblok?.asset_folders_to_create)[0];
  return first?.path || first?.name || null;
}

function isIntegrationOwnedStorySlug(manifest, slug) {
  const value = String(slug || '');
  return value === manifest.integration_id ||
    value.endsWith(`/${manifest.integration_id}`) ||
    value.includes(`/${manifest.integration_id}/`) ||
    value.startsWith(`${manifest.integration_id}/`);
}

function safeError(data) {
  if (typeof data === 'string') return data;
  return data.message || data.error || JSON.stringify(data);
}

function redactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|key|auth|signature/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return String(value).replace(/(token|secret|password|key)=([^&\s]+)/gi, '$1=[REDACTED]');
  }
}

function shouldRetryStoryblokStatus(status, extraStatuses = []) {
  return Number(status) === 429 ||
    Number(status) === 500 ||
    Number(status) === 502 ||
    Number(status) === 503 ||
    Number(status) === 504 ||
    extraStatuses.map(Number).includes(Number(status));
}

function retryDelayMs(config, attempt) {
  const configuredBase = Number(config.retryBaseMs);
  const configuredMax = Number(config.retryMaxMs);
  const base = Number.isFinite(configuredBase) ? Math.max(configuredBase, 0) : DEFAULT_STORYBLOK_RETRY_BASE_MS;
  const max = Number.isFinite(configuredMax) ? Math.max(configuredMax, base) : DEFAULT_STORYBLOK_RETRY_MAX_MS;
  return Math.min(base * 2 ** attempt, max);
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  return null;
}

function parseJsonOrText(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function integerEnv(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function endpointWithQuery(endpoint, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  if (!search.toString()) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${search.toString()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

async function throttleStoryblokRequest(config) {
  const interval = Math.max(Number(config.requestIntervalMs) || 0, 0);
  if (interval === 0) return;
  const key = `${config.baseUrl}:${config.spaceId || 'content'}`;
  const previous = requestQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  requestQueues.set(key, previous.then(() => current));
  await previous;
  const last = lastRequestTimes.get(key) || 0;
  const wait = interval - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestTimes.set(key, Date.now());
  release();
}

function createTimeout(timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return {
      signal: undefined,
      clear: () => {}
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function encodeStorySlug(slug) {
  return String(slug).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function uniqueBy(values, keyFn) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
