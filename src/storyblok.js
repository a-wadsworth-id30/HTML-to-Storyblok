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

const DEFAULT_STORYBLOK_RETRY_LIMIT = 6;
const DEFAULT_STORYBLOK_RETRY_BASE_MS = 1000;
const DEFAULT_STORYBLOK_RETRY_MAX_MS = 8000;

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
    available: Boolean(token)
  };
}

export async function inspectStoryblokSpace({ env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const access = {
    management_api_available: Boolean(config.token),
    space_id_available: Boolean(config.spaceId),
    region: config.region,
    base_url: config.baseUrl,
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
  const components = await listStoryblokComponents(config);
  const stories = await listStoryblokStories(config);
  const assets = await listStoryblokAssets(config);

  return {
    ...access,
    status: 'ok',
    space: space.space ? summarizeSpace(space.space) : space,
    components: components.map(summarizeComponent),
    stories: stories.map(summarizeStory),
    assets: assets.map(summarizeAsset)
  };
}

export async function createStoryblokComponents(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const components = ensureArray(manifest.storyblok?.components_to_create);
  const results = [];
  if (components.length === 0) return results;
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  let existingComponents = null;
  for (const component of components) {
    const payload = { component: normalizeComponent(component) };
    if (dryRun) {
      results.push({
        action: 'create_component',
        dry_run: true,
        technical_name: payload.component.name,
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
  for (const story of stories) {
    const content = hydrateStoryAssets(story.content || {
      component: story.component,
      body: ensureArray(story.body)
    }, assetMap);
    if (dryRun) {
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
        payload
      });
      continue;
    }
    const existing = await findStoryBySlug(config, story.slug);
    if (existing) {
      assertStoryMatches(existing, { slug: story.slug, content });
      results.push({
        action: 'create_draft_story',
        dry_run: false,
        status: 'already_exists',
        slug: existing.full_slug || story.slug,
        id: existing.id || null,
        published: Boolean(existing.published_at),
        verification: summarizeStory(existing)
      });
      continue;
    }
    const target = await resolveStoryTarget(config, story);
    const payload = draftStoryPayload(story, target, content);
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories`, {
      method: 'POST',
      body: payload
    });
    results.push({
      action: 'create_draft_story',
      dry_run: false,
      status: 'created',
      slug: response.story?.full_slug || story.slug,
      id: response.story?.id || null,
      published: Boolean(response.story?.published_at),
      folder_results: target.folder_results,
      verification: response.story ? summarizeStory(response.story) : response
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
        id: existing.id || null,
        verification: summarizeAsset(existing)
      });
      continue;
    }

    const signed = await storyblokRequest(config, `/spaces/${config.spaceId}/assets/`, {
      method: 'POST',
      body: signPayload
    });
    await uploadSignedAsset(signed, localPath, filename);
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
      id: finished.asset?.id || assetId || null,
      verification: finished.asset ? summarizeAsset(finished.asset) : finished
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
    components: await deleteIntegrationComponents(config, manifest, { dryRun })
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

async function storyblokRequest(config, endpoint, { method = 'GET', body } = {}) {
  const serializedBody = body ? JSON.stringify(body) : undefined;
  const retryLimit = Math.max(Number(config.retryLimit) || 0, 0);
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: config.token,
        'Content-Type': 'application/json'
      },
      body: serializedBody
    });
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

async function storyblokContentRequest(config, endpoint, params = {}) {
  const search = new URLSearchParams(params);
  const response = await fetch(`${config.baseUrl}${endpoint}?${search.toString()}`, {
    headers: {
      Accept: 'application/json'
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Storyblok Content API GET ${endpoint} failed with ${response.status}: ${safeError(data)}`);
  }
  return data;
}

async function listStoryblokComponents(config) {
  return listPaginated(config, `/spaces/${config.spaceId}/components/`, 'components');
}

async function listStoryblokAssetFolders(config) {
  return listPaginated(config, `/spaces/${config.spaceId}/asset_folders/`, 'asset_folders');
}

async function listStoryblokStories(config, params = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/stories`, 'stories', params);
}

async function listStoryblokAssets(config, params = {}) {
  return listPaginated(config, `/spaces/${config.spaceId}/assets`, 'assets', params);
}

async function listPaginated(config, endpoint, key, params = {}) {
  const perPage = Number(params.per_page || 100);
  const results = [];
  for (let page = 1; ; page += 1) {
    const response = await storyblokRequest(config, endpointWithQuery(endpoint, {
      ...params,
      per_page: perPage,
      page
    }));
    const entries = ensureArray(response[key]);
    results.push(...entries);
    if (entries.length < perPage) break;
  }
  return results;
}

async function findStoryBySlug(config, slug) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories?by_slugs=${encodeURIComponent(slug)}&per_page=1`);
  return ensureArray(response.stories).find((story) => story.full_slug === slug || story.slug === slug) || null;
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
  const integrationRoot = `integration-preview/${manifest.integration_id}`;
  for (const story of ensureArray(manifest.storyblok?.stories_to_create)) {
    const parts = String(story.slug || story.full_slug || '').split('/').filter(Boolean);
    for (let index = 1; index < parts.length - 1; index += 1) {
      const folder = parts.slice(0, index + 1).join('/');
      if (folder === 'integration-preview') continue;
      if (folder === integrationRoot || folder.startsWith(`${integrationRoot}/`)) folders.add(folder);
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

async function deleteIntegrationComponents(config, manifest, { dryRun }) {
  const names = unique([
    ...ensureArray(manifest.storyblok?.components_to_create).map((component) => component.technical_name || component.name || component),
    ...ensureArray(manifest.storyblok?.components_to_duplicate).map((component) => component.technical_name || component.name || component)
  ]);
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

function assertComponentMatches(existing, intended) {
  const existingComparable = comparableComponent(existing);
  const intendedComparable = comparableComponent(intended);
  if (sha256Json(existingComparable) !== sha256Json(intendedComparable)) {
    throw new Error(`Storyblok component drift detected for ${intended.name}; existing component does not match the manifest.`);
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

function assertStoryMatches(existing, intended) {
  if (existing.published_at) {
    throw new Error(`Storyblok story collision is published and cannot be reused safely: ${existing.full_slug || intended.slug}`);
  }
  if (sha256Json(existing.content || {}) !== sha256Json(intended.content || {})) {
    throw new Error(`Storyblok draft story drift detected for ${intended.slug}; existing story does not match the manifest.`);
  }
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
    component_group_id: entry.component_group_id
  };
}

function sha256Json(value) {
  return sha256(stableJson(value));
}

async function uploadSignedAsset(signedResponse, localPath, filename) {
  const postUrl = signedResponse.post_url || signedResponse.upload_url;
  const fields = signedResponse.fields || {};
  if (!postUrl) throw new Error('Storyblok signed asset response did not include post_url');
  const buffer = await readFile(localPath);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([buffer]), filename);
  const response = await fetch(postUrl, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`asset upload failed with ${response.status}`);
  }
}

function normalizeComponent(component) {
  const name = component.name || component.technical_name;
  return {
    name,
    display_name: component.display_name || titleFromTechnicalName(name),
    is_root: component.component_type === 'content_type' || component.is_root === true,
    is_nestable: component.component_type === 'nestable' || component.is_nestable === true,
    schema: component.schema || defaultSchemaFor(component),
    preview_field: component.preview_field || 'headline',
    component_group_id: component.component_group_id
  };
}

function comparableComponent(component) {
  return {
    name: component.name || component.technical_name,
    display_name: component.display_name || titleFromTechnicalName(component.name || component.technical_name),
    is_root: Boolean(component.is_root),
    is_nestable: Boolean(component.is_nestable),
    schema: component.schema || {},
    preview_field: component.preview_field || 'headline'
  };
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
    type: component.is_root ? 'content_type' : 'nestable',
    fields: Object.keys(component.schema || {}),
    allowed_children: Object.values(component.schema || {})
      .filter((field) => field.type === 'bloks')
      .flatMap((field) => ensureArray(field.component_whitelist))
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

function shouldRetryStoryblokStatus(status) {
  return Number(status) === 429 || Number(status) === 500 || Number(status) === 502 || Number(status) === 503 || Number(status) === 504;
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
