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
    },
    ...buildRouteProposalFiles(plan)
  ];
}

export function plannedRepositoryAdapterFilePaths(manifest) {
  const framework = normalizeFramework(manifest.template?.framework || 'static');
  const files = [
    `${manifest.repository_namespace}/adapter-plan.json`,
    `${manifest.repository_namespace}/INTEGRATION_GUIDE.md`
  ];
  if (manifest.template?.source_path) {
    const slugs = storyRouteSlugs(manifest, ensureArray(manifest.storyblok?.stories_to_create));
    files.push(
      `${manifest.repository_namespace}/route-proposals/manifest.json`,
      `${manifest.repository_namespace}/route-proposals/README.md`,
      ...slugs.map((slug) => routeProposalPath(manifest.repository_namespace, slug, framework))
    );
  }
  return files;
}

export function buildRepositoryAdapterPlan(manifest, { conversion = null, framework = 'static' } = {}) {
  const normalizedFramework = normalizeFramework(conversion?.framework || framework || manifest.template?.framework || 'static');
  const hasPreview = Boolean(conversion);
  const hasRoutePreviews = Boolean(conversion?.files?.some((file) => file.path === `${manifest.repository_namespace}/routes/manifest.json`));
  const routes = adapterRoutes(manifest, conversion, normalizedFramework, { hasRoutePreviews });
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
    route_proposals: routeProposalSummary(manifest, routes, normalizedFramework, { hasPreview: hasRoutePreviews }),
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

function adapterRoutes(manifest, conversion, framework, { hasRoutePreviews = false } = {}) {
  const routeMap = new Map(ensureArray(conversion?.routes).map((route) => [route.slug, route]));
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
      route_proposal_file: hasRoutePreviews ? routeProposalPath(manifest.repository_namespace, slug, framework) : null,
      suggested_host_files: suggestedHostFiles(slug, framework),
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

function routeProposalPath(namespace, slug, framework) {
  if (framework === 'astro') return `${namespace}/route-proposals/${slug}/page.astro`;
  if (framework === 'react' || framework === 'next') return `${namespace}/route-proposals/${slug}/page.jsx`;
  if (framework === 'vue' || framework === 'nuxt') return `${namespace}/route-proposals/${slug}/Page.vue`;
  return `${namespace}/route-proposals/${slug}/route.js`;
}

function routeProposalSummary(manifest, routes, framework, { hasPreview }) {
  const namespace = manifest.repository_namespace;
  if (!hasPreview) {
    return {
      generated: false,
      reason: 'No template preview files were generated for this manifest.',
      host_routes_modified: false
    };
  }
  return {
    generated: true,
    manifest_file: `${namespace}/route-proposals/manifest.json`,
    readme_file: `${namespace}/route-proposals/README.md`,
    host_routes_modified: false,
    routes: routes.map((route) => ({
      slug: route.slug,
      suggested_site_path: route.suggested_site_path,
      storyblok_slug: route.storyblok_slug,
      proposal_file: route.route_proposal_file,
      preview_file: route.preview_file,
      suggested_host_files: suggestedHostFiles(route.slug, framework),
      registration_policy: route.registration_policy
    }))
  };
}

function buildRouteProposalFiles(plan) {
  if (!plan.route_proposals?.generated) return [];
  return [
    {
      path: plan.route_proposals.manifest_file,
      json: true,
      content: {
        action: 'repository_route_proposals',
        integration_id: plan.integration_id,
        storyblok_prefix: plan.storyblok_prefix,
        repository_namespace: plan.repository_namespace,
        framework: plan.framework,
        additive_only: true,
        host_routes_modified: false,
        routes: plan.route_proposals.routes
      }
    },
    {
      path: plan.route_proposals.readme_file,
      content: renderRouteProposalReadme(plan)
    },
    ...plan.routes
      .filter((route) => route.route_proposal_file)
      .map((route) => ({
        path: route.route_proposal_file,
        content: renderRouteProposalFile(plan, route)
      }))
  ];
}

function renderRouteProposalReadme(plan) {
  return `# ${plan.integration_id} Route Proposals

Generated by HTML-to-Storyblok.

These files are not registered with the host router. They are isolated wrappers around generated route previews so a developer can wire an imported route from a reviewed host route without reaching into raw template files.

- Policy: additive-only
- Host routes modified: no
- Host registries modified: no
- Manifest: \`${plan.route_proposals.manifest_file}\`

## Proposed Routes

${plan.route_proposals.routes.map((route) => `- \`${route.suggested_site_path}\` -> \`${route.storyblok_slug}\` -> \`${route.proposal_file}\``).join('\n')}

Run repository install, lint, typecheck, build, and browser smoke checks before copying any proposal into a host route.
`;
}

function renderRouteProposalFile(plan, route) {
  if (plan.framework === 'astro') return renderAstroRouteProposal(plan, route);
  if (plan.framework === 'react' || plan.framework === 'next') return renderReactRouteProposal(plan, route);
  if (plan.framework === 'vue' || plan.framework === 'nuxt') return renderVueRouteProposal(plan, route);
  return renderStaticRouteProposal(plan, route);
}

function renderStaticRouteProposal(plan, route) {
  const importPath = proposalImportPath(route.slug, 'routes', route.slug, 'template-html.js');
  return `import { renderTemplateHtml } from '${importPath}';

export const htsRouteProposal = Object.freeze(${JSON.stringify(routeProposalMetadata(plan, route), null, 2)});

export function renderHtsRouteProposal({ story = null, blok = null } = {}) {
  return renderTemplateHtml(blok || story?.content || {});
}
`;
}

function renderAstroRouteProposal(plan, route) {
  const importPath = proposalImportPath(route.slug, 'routes', route.slug, 'TemplatePage.astro');
  return `---
import RoutePreview from '${importPath}';

const htsRouteProposal = Object.freeze(${JSON.stringify(routeProposalMetadata(plan, route), null, 2)});
const { story = null, blok = story?.content || {} } = Astro.props;
---

<RoutePreview blok={blok} data-route-proposal={htsRouteProposal.route_slug} />
`;
}

function renderReactRouteProposal(plan, route) {
  const importPath = proposalImportPath(route.slug, 'routes', route.slug, 'TemplatePage.jsx');
  const previewComponent = `HtsTemplatePage${pascalCase(route.slug)}`;
  const proposalComponent = `HtsRouteProposal${pascalCase(route.slug)}`;
  return `import { ${previewComponent} } from '${importPath}';

export const htsRouteProposal = Object.freeze(${JSON.stringify(routeProposalMetadata(plan, route), null, 2)});

export function ${proposalComponent}({ story = null, blok = null }) {
  return <${previewComponent} blok={blok || story?.content || {}} />;
}

export default ${proposalComponent};
`;
}

function renderVueRouteProposal(plan, route) {
  const importPath = proposalImportPath(route.slug, 'routes', route.slug, 'TemplatePage.vue');
  return `<script>
export const htsRouteProposal = Object.freeze(${JSON.stringify(routeProposalMetadata(plan, route), null, 2)});
</script>

<script setup>
import { computed } from 'vue';
import RoutePreview from '${importPath}';

const props = defineProps({
  story: {
    type: Object,
    default: null
  },
  blok: {
    type: Object,
    default: null
  }
});

const resolvedBlok = computed(() => props.blok || props.story?.content || {});
</script>

<template>
  <RoutePreview :blok="resolvedBlok" />
</template>
`;
}

function routeProposalMetadata(plan, route) {
  return {
    integration_id: plan.integration_id,
    storyblok_prefix: plan.storyblok_prefix,
    route_slug: route.slug,
    suggested_site_path: route.suggested_site_path,
    storyblok_slug: route.storyblok_slug,
    preview_file: route.preview_file,
    registration_policy: route.registration_policy,
    host_routes_modified: false
  };
}

function proposalImportPath(slug, ...targetParts) {
  const depth = String(slug || 'home').split('/').filter(Boolean).length + 1;
  return `${'../'.repeat(depth)}${targetParts.join('/')}`.replace(/\/{2,}/g, '/');
}

function suggestedHostFiles(slug, framework) {
  const route = slug === 'home' ? 'index' : slug;
  if (framework === 'astro') return [`src/pages/${route}.astro`];
  if (framework === 'next') return [`src/app/${slug === 'home' ? '' : `${slug}/`}page.jsx`.replace(/\/{2,}/g, '/')];
  if (framework === 'nuxt') return [`pages/${route}.vue`];
  if (framework === 'vue' || framework === 'react') return ['review the host router configuration'];
  return [`${route}.html`];
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
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

${plan.route_proposals?.generated ? `## Route Proposal Wrappers

Route proposal wrappers are generated under \`${plan.repository_namespace}/route-proposals/\`. They are review-only adapters that import the generated route previews and accept either \`story\` or \`blok\` props. The CLI has not copied them into host route folders.

${plan.route_proposals.routes.map((route) => `- \`${route.proposal_file}\` for \`${route.suggested_site_path}\` (${route.suggested_host_files.join(', ')})`).join('\n')}
` : ''}

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
