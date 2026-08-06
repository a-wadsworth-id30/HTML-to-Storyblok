import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { envValue, ensureArray, pathExists, sha256 } from './utils.js';

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

  const [space, components, stories, assets] = await Promise.all([
    storyblokRequest(config, `/spaces/${config.spaceId}`),
    storyblokRequest(config, `/spaces/${config.spaceId}/components/`),
    storyblokRequest(config, `/spaces/${config.spaceId}/stories?per_page=100`),
    storyblokRequest(config, `/spaces/${config.spaceId}/assets?per_page=100`)
  ]);

  return {
    ...access,
    status: 'ok',
    space: space.space ? summarizeSpace(space.space) : space,
    components: ensureArray(components.components).map(summarizeComponent),
    stories: ensureArray(stories.stories).map(summarizeStory),
    assets: ensureArray(assets.assets).map(summarizeAsset)
  };
}

export async function createStoryblokComponents(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const components = ensureArray(manifest.storyblok?.components_to_create);
  const results = [];
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

export async function createDraftStories(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  const results = [];
  if (!config.available && !dryRun) {
    throw new Error('Storyblok credentials unavailable; set STORYBLOK_MANAGEMENT_TOKEN and STORYBLOK_SPACE_ID');
  }

  for (const story of stories) {
    const content = story.content || {
      component: story.component,
      body: ensureArray(story.body)
    };
    const payload = {
      story: {
        name: story.name || lastSlugSegment(story.slug),
        slug: story.slug,
        content,
        is_startpage: Boolean(story.is_startpage),
        parent_id: story.parent_id || 0
      },
      publish: false
    };
    if (dryRun) {
      results.push({
        action: 'create_draft_story',
        dry_run: true,
        slug: story.slug,
        collision_policy: 'verify_matching_draft_or_stop',
        payload
      });
      continue;
    }
    const existing = await findStoryBySlug(config, story.slug);
    if (existing) {
      assertStoryMatches(existing, payload.story);
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
      verification: response.story ? summarizeStory(response.story) : response
    });
  }
  return results;
}

export async function createStoryblokAssetFolders(manifest, { dryRun = false, env = process.env } = {}) {
  const config = getStoryblokConfig(env);
  const folders = plannedAssetFolders(manifest);
  const results = [];
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
        asset_folder_path: assetFolderPath || null,
        bytes: fileStat.size,
        sign_payload: {
          ...signPayload,
          asset_folder_path: assetFolderPath || undefined
        }
      });
      continue;
    }

    const existing = dryRun ? null : await findAssetByFilename(config, filename);
    if (existing) {
      assertAssetMatches(existing, { filename, bytes: fileStat.size });
      results.push({
        action: 'upload_asset',
        dry_run: false,
        status: 'already_exists',
        local_path: localPath,
        filename,
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
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: config.token,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Storyblok ${method} ${endpoint} failed with ${response.status}: ${safeError(data)}`);
  }
  return data;
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
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`);
  return ensureArray(response.components);
}

async function listStoryblokAssetFolders(config) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/asset_folders/`);
  return ensureArray(response.asset_folders);
}

async function findStoryBySlug(config, slug) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories?by_slugs=${encodeURIComponent(slug)}&per_page=1`);
  return ensureArray(response.stories).find((story) => story.full_slug === slug || story.slug === slug) || null;
}

async function findAssetByFilename(config, filename) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/assets?search=${encodeURIComponent(path.basename(filename))}&per_page=100`);
  return ensureArray(response.assets).find((asset) =>
    asset.filename === filename ||
    asset.short_filename === filename ||
    asset.filename?.endsWith(`/${filename}`) ||
    asset.filename?.endsWith(`/${path.basename(filename)}`)
  ) || null;
}

function assertComponentMatches(existing, intended) {
  const existingComparable = comparableComponent(existing);
  const intendedComparable = comparableComponent(intended);
  if (sha256Json(existingComparable) !== sha256Json(intendedComparable)) {
    throw new Error(`Storyblok component drift detected for ${intended.name}; existing component does not match the manifest.`);
  }
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

function safeError(data) {
  if (typeof data === 'string') return data;
  return data.message || data.error || JSON.stringify(data);
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
