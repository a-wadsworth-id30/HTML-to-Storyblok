import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
await access(path.join(cwd, packageJson.demoEntry || 'package.json'));
await validateGeneratedIntegrations(cwd, packageJson);
console.log(`demo build check passed: ${packageJson.name}`);

async function validateGeneratedIntegrations(root, packageJson) {
  const integrationsRoot = path.join(root, 'src/integrations');
  let entries = [];
  try {
    entries = await readdir(integrationsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const integrationRoot = path.join(integrationsRoot, entry.name);
    const expected = expectedPreviewFile(packageJson);
    await access(path.join(integrationRoot, expected));
    await access(path.join(integrationRoot, 'adapter-plan.json'));
    await access(path.join(integrationRoot, 'INTEGRATION_GUIDE.md'));
    await access(path.join(integrationRoot, 'routes/manifest.json'));
    const routeManifest = JSON.parse(await readFile(path.join(integrationRoot, 'routes/manifest.json'), 'utf8'));
    const adapterPlan = JSON.parse(await readFile(path.join(integrationRoot, 'adapter-plan.json'), 'utf8'));
    if (adapterPlan.host_routes_modified !== false || adapterPlan.host_registries_modified !== false) {
      throw new Error(`adapter plan must remain additive-only for ${entry.name}`);
    }
    for (const route of routeManifest.routes || []) {
      const preview = route.files?.preview;
      if (!preview) throw new Error(`route preview missing from manifest for ${route.slug}`);
      await access(path.join(root, preview));
      const adapterRoute = (adapterPlan.routes || []).find((item) => item.slug === route.slug);
      if (!adapterRoute || adapterRoute.preview_file !== preview) {
        throw new Error(`adapter route mapping missing or mismatched for ${route.slug}`);
      }
    }
    const content = await readFile(path.join(integrationRoot, expected), 'utf8');
    if (expected.endsWith('.jsx') && !/export function HtsTemplatePage/.test(content)) {
      throw new Error(`generated React/Next preview is not a component: ${expected}`);
    }
    if (expected.endsWith('.vue') && !/<template>/.test(content)) {
      throw new Error(`generated Vue/Nuxt preview is not a component: ${expected}`);
    }
    if (expected.endsWith('.astro') && !/Astro\.props/.test(content)) {
      throw new Error(`generated Astro preview is not a component: ${expected}`);
    }
  }
}

function expectedPreviewFile(packageJson) {
  const dependencies = packageJson.dependencies || {};
  if (dependencies.astro) return 'TemplatePage.astro';
  if (dependencies.next || dependencies.react) return 'TemplatePage.jsx';
  if (dependencies.nuxt || dependencies.vue) return 'TemplatePage.vue';
  return 'template.html';
}
