import path from 'node:path';
import { ensureArray } from './utils.js';

export function buildRepositoryAdapterFiles(manifest, { conversion = null, framework = 'static' } = {}) {
  const plan = buildRepositoryAdapterPlan(manifest, { conversion, framework });
  return [
    {
      path: `${manifest.repository_namespace}/adapter-plan.json`,
      json: true,
      content: plan
    },
    {
      path: `${manifest.repository_namespace}/INTEGRATION_GUIDE.md`,
      content: renderRepositoryIntegrationGuide(plan)
    }
  ];
}

export function plannedRepositoryAdapterFilePaths(manifest) {
  return [
    `${manifest.repository_namespace}/adapter-plan.json`,
    `${manifest.repository_namespace}/INTEGRATION_GUIDE.md`
  ];
}

export function buildRepositoryAdapterPlan(manifest, { conversion = null, framework = 'static' } = {}) {
  const normalizedFramework = normalizeFramework(conversion?.framework || framework || manifest.template?.framework || 'static');
  const routes = adapterRoutes(manifest, conversion, normalizedFramework);
  const hasPreview = Boolean(conversion);
  return {
    action: 'repository_adapter_plan',
    integration_id: manifest.integration_id,
    storyblok_prefix: manifest.storyblok_prefix,
    repository_namespace: manifest.repository_namespace,
    framework: normalizedFramework,
    additive_only: true,
    host_routes_modified: false,
    host_registries_modified: false,
    root_component: rootComponent(manifest),
    entrypoints: frameworkEntrypoints(manifest, normalizedFramework, { hasPreview }),
    routes,
    validation: {
      required_before_route_wiring: [
        'html-to-storyblok validate',
        'host repository install',
        'host repository lint',
        'host repository typecheck when available',
        'host repository build',
        'browser smoke test for every imported route'
      ],
      note: 'Generated adapters are isolated. Wire them into host routes only after review.'
    }
  };
}

function adapterRoutes(manifest, conversion, framework) {
  const routeMap = new Map(ensureArray(conversion?.routes).map((route) => [route.slug, route]));
  const hasRoutePreviews = routeMap.size > 0;
  const stories = ensureArray(manifest.storyblok?.stories_to_create);
  const slugs = routeMap.size > 0
    ? [...routeMap.keys()]
    : storyRouteSlugs(manifest, stories);

  return slugs.map((slug) => {
    const route = routeMap.get(slug) || {};
    const story = stories.find((entry) => storyMatchesRoute(manifest, entry, slug));
    return {
      slug,
      suggested_site_path: slug === 'home' ? '/' : `/${slug}`,
      storyblok_slug: story?.slug || story?.full_slug || `${manifest.integration_id}/${slug}`,
      source_page: route.source_page || story?.source_page || null,
      preview_file: hasRoutePreviews ? routePreviewPath(manifest.repository_namespace, slug, framework) : null,
      template_html_module: hasRoutePreviews ? `${manifest.repository_namespace}/routes/${slug}/template-html.js` : null,
      registration_policy: 'manual_review_required'
    };
  });
}

function storyRouteSlugs(manifest, stories) {
  const prefix = `${manifest.integration_id}/`;
  const slugs = stories
    .map((story) => story.slug || story.full_slug)
    .filter((slug) => String(slug || '').startsWith(prefix))
    .map((slug) => String(slug).slice(prefix.length) || 'home');
  return slugs.length > 0 ? slugs : ['home'];
}

function storyMatchesRoute(manifest, story, routeSlug) {
  const slug = story?.slug || story?.full_slug || '';
  return slug === `${manifest.integration_id}/${routeSlug}` || slug.endsWith(`/${routeSlug}`);
}

function frameworkEntrypoints(manifest, framework, { hasPreview = true } = {}) {
  const namespace = manifest.repository_namespace;
  if (!hasPreview) {
    return {
      root_preview: null,
      storyblok_renderer: `${namespace}/components.js`,
      import_example: null
    };
  }
  if (framework === 'astro') {
    return {
      root_preview: `${namespace}/TemplatePage.astro`,
      storyblok_renderer: `${namespace}/components.js`,
      import_example: `import TemplatePage from './${namespace}/TemplatePage.astro';`
    };
  }
  if (framework === 'react' || framework === 'next') {
    return {
      root_preview: `${namespace}/TemplatePage.jsx`,
      storyblok_renderer: `${namespace}/components.js`,
      import_example: `import { HtsTemplatePage } from './${namespace}/TemplatePage.jsx';`
    };
  }
  if (framework === 'vue' || framework === 'nuxt') {
    return {
      root_preview: `${namespace}/TemplatePage.vue`,
      storyblok_renderer: `${namespace}/components.js`,
      import_example: `import HtsTemplatePage from './${namespace}/TemplatePage.vue';`
    };
  }
  return {
    root_preview: `${namespace}/template.html`,
    storyblok_renderer: `${namespace}/components.js`,
    import_example: `import { renderTemplateHtml } from './${namespace}/template-html.js';`
  };
}

function rootComponent(manifest) {
  const contentType = ensureArray(manifest.storyblok?.components_to_create)
    .find((component) => component.component_type === 'content_type');
  return contentType?.technical_name || contentType?.name || `${manifest.storyblok_prefix}template_page`;
}

function routePreviewPath(namespace, slug, framework) {
  if (framework === 'astro') return `${namespace}/routes/${slug}/TemplatePage.astro`;
  if (framework === 'react' || framework === 'next') return `${namespace}/routes/${slug}/TemplatePage.jsx`;
  if (framework === 'vue' || framework === 'nuxt') return `${namespace}/routes/${slug}/TemplatePage.vue`;
  return `${namespace}/routes/${slug}/template.html`;
}

function renderRepositoryIntegrationGuide(plan) {
  return `# ${plan.integration_id} Repository Integration Guide

Generated by HTML-to-Storyblok.

## Safety

- Integration namespace: \`${plan.repository_namespace}\`
- Storyblok prefix: \`${plan.storyblok_prefix}\`
- Host routes modified: ${plan.host_routes_modified ? 'yes' : 'no'}
- Host registries modified: ${plan.host_registries_modified ? 'yes' : 'no'}
- Policy: additive-only

The files in this folder are ready for review. The CLI has not registered routes, edited component registries, changed dependencies, or altered existing application files.

## Entry Points

- Root preview: ${plan.entrypoints.root_preview ? `\`${plan.entrypoints.root_preview}\`` : 'Not generated'}
- Storyblok renderer: \`${plan.entrypoints.storyblok_renderer}\`
- Root Storyblok component: \`${plan.root_component}\`

${frameworkGuide(plan)}

## Imported Routes

${plan.routes.map((route) => `- \`${route.suggested_site_path}\` -> Storyblok \`${route.storyblok_slug}\`${route.preview_file ? ` -> preview \`${route.preview_file}\`` : ''}`).join('\n')}

## Required Checks Before Wiring

${plan.validation.required_before_route_wiring.map((item) => `- ${item}`).join('\n')}
`;
}

function frameworkGuide(plan) {
  if (!plan.entrypoints.root_preview) {
    return `## Repository Wiring

No template preview component was generated because this manifest was created without a template source. Use \`${plan.entrypoints.storyblok_renderer}\` only after you add a reviewed host renderer for \`${plan.root_component}\`.
`;
  }
  if (plan.framework === 'astro') {
    return `## Astro Wiring

Import the generated preview component into a reviewed Astro page or Storyblok renderer:

\`\`\`astro
---
import TemplatePage from './${plan.repository_namespace}/TemplatePage.astro';
---

<TemplatePage blok={story.content} />
\`\`\`
`;
  }
  if (plan.framework === 'react' || plan.framework === 'next') {
    return `## ${plan.framework === 'next' ? 'Next.js' : 'React'} Wiring

Import the generated preview component into a reviewed route or Storyblok renderer:

\`\`\`jsx
import { HtsTemplatePage } from './${plan.repository_namespace}/TemplatePage.jsx';

export default function ImportedTemplatePage({ story }) {
  return <HtsTemplatePage blok={story.content} />;
}
\`\`\`
`;
  }
  if (plan.framework === 'vue' || plan.framework === 'nuxt') {
    return `## ${plan.framework === 'nuxt' ? 'Nuxt' : 'Vue'} Wiring

Import the generated preview component into a reviewed page or Storyblok renderer:

\`\`\`vue
<script setup>
import HtsTemplatePage from './${plan.repository_namespace}/TemplatePage.vue';
</script>

<template>
  <HtsTemplatePage :blok="story.content" />
</template>
\`\`\`
`;
  }
  return `## Static Wiring

Use the generated HTML module from reviewed host code:

\`\`\`js
import { renderTemplateHtml } from './${plan.repository_namespace}/template-html.js';

const html = renderTemplateHtml(story.content);
\`\`\`
`;
}

function normalizeFramework(framework) {
  const value = String(framework || '').toLowerCase();
  if (value.includes('astro')) return 'astro';
  if (value.includes('next')) return 'next';
  if (value.includes('nuxt')) return 'nuxt';
  if (value.includes('vue')) return 'vue';
  if (value.includes('react')) return 'react';
  return 'static';
}
