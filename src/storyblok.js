import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { envValue, ensureArray, pathExists } from './utils.js';

const REGION_BASE_URLS = {
  eu: 'https://mapi.storyblok.com/v1',
  us: 'https://api-us.storyblok.com/v1',
  ca: 'https://api-ca.storyblok.com/v1',
  ap: 'https://api-ap.storyblok.com/v1',
  cn: 'https://app.storyblokchina.cn/v1'
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

  for (const component of components) {
    const payload = { component: normalizeComponent(component) };
    if (dryRun) {
      results.push({ action: 'create_component', dry_run: true, technical_name: payload.component.name, payload });
      continue;
    }
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`, {
      method: 'POST',
      body: payload
    });
    results.push({
      action: 'create_component',
      dry_run: false,
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
      results.push({ action: 'create_draft_story', dry_run: true, slug: story.slug, payload });
      continue;
    }
    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/stories`, {
      method: 'POST',
      body: payload
    });
    results.push({
      action: 'create_draft_story',
      dry_run: false,
      slug: response.story?.full_slug || story.slug,
      id: response.story?.id || null,
      published: Boolean(response.story?.published_at),
      verification: response.story ? summarizeStory(response.story) : response
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

  for (const asset of assets) {
    const localPath = asset.local_path || asset.file || asset.path;
    if (!localPath) throw new Error('asset entry is missing local_path');
    if (!(await pathExists(localPath))) throw new Error(`asset file does not exist: ${localPath}`);
    const filename = asset.filename || path.basename(localPath);
    const fileStat = await stat(localPath);
    const signPayload = {
      filename,
      asset_folder_id: asset.asset_folder_id || undefined,
      size: asset.size || '',
      validate_upload: 1
    };
    if (dryRun) {
      results.push({
        action: 'upload_asset',
        dry_run: true,
        local_path: localPath,
        filename,
        bytes: fileStat.size,
        sign_payload: signPayload
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
      local_path: localPath,
      filename,
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

    const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`, {
      method: 'POST',
      body: payload
    });
    results.push({
      action: 'duplicate_storyblok_component',
      dry_run: false,
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

async function listStoryblokComponents(config) {
  const response = await storyblokRequest(config, `/spaces/${config.spaceId}/components/`);
  return ensureArray(response.components);
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
  const text = JSON.stringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
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

function titleFromTechnicalName(name) {
  return String(name)
    .replace(/^hts_/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function lastSlugSegment(slug) {
  return String(slug).split('/').filter(Boolean).at(-1) || 'Integration Preview';
}

function safeError(data) {
  if (typeof data === 'string') return data;
  return data.message || data.error || JSON.stringify(data);
}
