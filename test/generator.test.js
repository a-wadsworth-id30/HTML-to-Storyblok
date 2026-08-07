import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createDefaultManifest } from '../src/policy.js';
import { plannedRepositoryAdapterFilePaths } from '../src/repository-adapter.js';
import { plannedTemplateFilePaths } from '../src/template-converter.js';

test('generate converts template HTML into isolated framework files', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-'));
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push({ technical_name: 'hts_acme_homepage_v1_template_page' });
  manifest.repository.files_to_create.push(
    'src/integrations/acme-homepage-v1/integration-manifest.json',
    'src/integrations/acme-homepage-v1/index.js',
    'src/integrations/acme-homepage-v1/components.js',
    ...plannedRepositoryAdapterFilePaths(manifest),
    'src/integrations/acme-homepage-v1/README.md',
    'src/integrations/acme-homepage-v1/styles/acme-homepage-v1.css',
    ...plannedTemplateFilePaths(manifest, 'astro')
  );

  const result = await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'astro'
  });

  assert.equal(result.framework, 'astro');
  assert.equal(result.removed_scripts, 1);
  assert.equal(result.removed_inline_handlers, 1);
  assert.deepEqual(result.excluded_external_scripts, ['https://example.com/tracker.js']);
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/TemplatePage.astro'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/adapter-plan.json'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/INTEGRATION_GUIDE.md'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/template-html.js'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/behaviour/acme-homepage-v1.js'));
  assert.deepEqual(result.assets, ['src/integrations/acme-homepage-v1/assets/hero.svg']);

  const css = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/styles/template.css'), 'utf8');
  assert.match(css, /\.hts-acme-homepage-v1-root \.hts-acme-homepage-v1-site-header/);
  assert.doesNotMatch(css, /\.site-header\s*{/);

  const astro = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/TemplatePage.astro'), 'utf8');
  assert.match(astro, /import '\.\/behaviour\/acme-homepage-v1\.js'/);
  assert.match(astro, /class="hts-acme-homepage-v1-site-header"/);

  const adapterPlan = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/adapter-plan.json'), 'utf8'));
  assert.equal(adapterPlan.framework, 'astro');
  assert.equal(adapterPlan.host_routes_modified, false);
  assert.equal(adapterPlan.entrypoints.root_preview, 'src/integrations/acme-homepage-v1/TemplatePage.astro');
});

test('generate converts complex HTML attributes into React-safe JSX', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-react-repo-'));
  const templatePath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-react-template-'));
  await writeFile(path.join(templatePath, 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  await writeFile(path.join(templatePath, 'index.html'), `<!doctype html>
<html>
  <body>
    <main>
      <label for="email">Email</label>
      <input id="email" class="field" style="background-color: red; --gap: 1rem;" required readonly autofocus maxlength="30">
      <a href="#email" aria-controls="email">Jump</a>
      <img src="./hero.svg" alt="Hero">
      <svg viewBox="0 0 10 10"><path fill-rule="evenodd" stroke-width="2"></path></svg>
      <my-widget class="widget" custom-attr="demo" data-mode="compact" onclick=alert(1)></my-widget>
    </main>
  </body>
</html>
`);

  const manifest = createDefaultManifest({
    integrationId: 'react-template-v1',
    storyblokPrefix: 'hts_react_template_v1_',
    repositoryNamespace: 'src/integrations/react-template-v1'
  });
  manifest.storyblok.components_to_create.push({ technical_name: 'hts_react_template_v1_template_page' });
  manifest.repository.files_to_create.push(
    'src/integrations/react-template-v1/integration-manifest.json',
    'src/integrations/react-template-v1/index.js',
    'src/integrations/react-template-v1/components.js',
    ...plannedRepositoryAdapterFilePaths(manifest),
    'src/integrations/react-template-v1/README.md',
    'src/integrations/react-template-v1/styles/react-template-v1.css',
    ...plannedTemplateFilePaths(manifest, 'react')
  );

  const result = await generateIntegration(manifest, {
    repoPath,
    templatePath,
    framework: 'react'
  });

  assert.equal(result.framework, 'react');
  assert.equal(result.removed_inline_handlers, 1);

  const jsx = await readFile(path.join(repoPath, 'src/integrations/react-template-v1/TemplatePage.jsx'), 'utf8');
  assert.match(jsx, /htmlFor="hts-react-template-v1-email"/);
  assert.match(jsx, /id="hts-react-template-v1-email"/);
  assert.match(jsx, /href="#hts-react-template-v1-email"/);
  assert.match(jsx, /aria-controls="hts-react-template-v1-email"/);
  assert.match(jsx, /className="hts-react-template-v1-field"/);
  assert.match(jsx, /style=\{\{ backgroundColor: "red", "--gap": "1rem" \}\}/);
  assert.match(jsx, /required readOnly autoFocus maxLength="30"/);
  assert.match(jsx, /<img src="\.\/assets\/hero\.svg" alt="Hero" \/>/);
  assert.match(jsx, /fillRule="evenodd" strokeWidth="2"/);
  assert.match(jsx, /<my-widget class="hts-react-template-v1-widget" custom-attr="demo" data-mode="compact">/);
  assert.doesNotMatch(jsx, /onclick/);
});

test('generate writes isolated route previews for every template page without touching app routes', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-routes-repo-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-campaign-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });

  const result = await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework: 'static'
  });

  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/manifest.json'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/home/template.html'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/about/template.html'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/services/template.html'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/gallery/template.html'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/routes/contact/template.html'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/route-proposals/manifest.json'));
  assert.ok(result.files.includes('src/integrations/acme-campaign-v1/route-proposals/home/route.js'));

  const routeManifest = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/routes/manifest.json'), 'utf8'));
  assert.deepEqual(routeManifest.routes.map((route) => route.slug), ['home', 'about', 'contact', 'gallery', 'services']);
  assert.equal(routeManifest.note.includes('not registered with the host application router'), true);

  const about = await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/routes/about/template.html'), 'utf8');
  assert.match(about, /data-route="about"/);
  assert.match(about, /src="\.\.\/\.\.\/assets\/assets\/hero\.svg"/);
  assert.doesNotMatch(about, /data-hts-field="about_headline" data-hts-field="headline"/);

  const adapterPlan = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/adapter-plan.json'), 'utf8'));
  assert.equal(adapterPlan.framework, 'static');
  assert.deepEqual(adapterPlan.routes.map((route) => route.suggested_site_path), ['/', '/about', '/contact', '/gallery', '/services']);
  assert.equal(adapterPlan.routes[0].storyblok_slug, 'acme-campaign-v1/home');
  assert.equal(adapterPlan.routes[0].route_proposal_file, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js');
  assert.equal(adapterPlan.route_proposals.host_routes_modified, false);

  const proposalManifest = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/route-proposals/manifest.json'), 'utf8'));
  assert.equal(proposalManifest.additive_only, true);
  assert.equal(proposalManifest.routes[0].proposal_file, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js');

  const homeProposal = await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js'), 'utf8');
  assert.match(homeProposal, /renderHtsRouteProposal/);
  assert.match(homeProposal, /'\.\.\/\.\.\/routes\/home\/template-html\.js'/);

  const guide = await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/INTEGRATION_GUIDE.md'), 'utf8');
  assert.match(guide, /Host routes modified: no/);
  assert.match(guide, /Imported Routes/);
  assert.match(guide, /Route Proposal Wrappers/);
});

test('generate writes schema-only adapter without preview paths', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-schema-only-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'schema-only-v1'
  });

  const result = await generateIntegration(manifest, { repoPath });

  assert.ok(result.files.includes('src/integrations/schema-only-v1/adapter-plan.json'));
  const adapterPlan = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/schema-only-v1/adapter-plan.json'), 'utf8'));
  assert.equal(adapterPlan.entrypoints.root_preview, null);
  assert.equal(adapterPlan.routes[0].preview_file, null);
  assert.equal(adapterPlan.routes[0].storyblok_slug, 'schema-only-v1/home');

  const guide = await readFile(path.join(repoPath, 'src/integrations/schema-only-v1/INTEGRATION_GUIDE.md'), 'utf8');
  assert.match(guide, /No template preview component was generated/);
});
