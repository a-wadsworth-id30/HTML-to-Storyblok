import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    'src/integrations/acme-homepage-v1/generated-file-hashes.json',
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
  assert.match(astro, /import \{ renderTemplateHtml \} from '\.\/template-html\.js'/);
  assert.match(astro, /set:html=\{htsHtml\}/);

  const htmlModule = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template-html.js'), 'utf8');
  assert.match(htmlModule, /hts-acme-homepage-v1-site-header/);

  const adapterPlan = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/adapter-plan.json'), 'utf8'));
  assert.equal(adapterPlan.framework, 'astro');
  assert.equal(adapterPlan.host_routes_modified, false);
  assert.equal(adapterPlan.entrypoints.root_preview, 'src/integrations/acme-homepage-v1/TemplatePage.astro');
});

test('generate reuses matching generated files during resume', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-resume-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const result = await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  assert.ok(result.reusable_files.includes('src/integrations/acme-homepage-v1/template.html'));
  assert.ok(result.reusable_assets.includes('src/integrations/acme-homepage-v1/assets/hero.svg'));
  assert.deepEqual(result.drifted_collisions, []);
});

test('generate refuses drifted generated files during resume', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-resume-drift-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await generateIntegration(manifest, {
    repoPath,
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  await writeFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/template.html'), 'changed generated file\n');

  await assert.rejects(
    () => generateIntegration(manifest, {
      repoPath,
      templatePath: 'test/fixtures/basic-template',
      framework: 'static'
    }),
    /refusing to overwrite drifted generated files/
  );
});

test('generate renders Storyblok fields through the shared HTML module', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-react-repo-'));
  const templatePath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-react-template-'));
  await writeFile(path.join(templatePath, 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  await writeFile(path.join(templatePath, 'index.html'), `<!doctype html>
<html>
  <body>
    <main>
      <label for="email">Email</label>
      <h1 data-hts-field="headline">Original headline</h1>
      <p data-hts-field="intro_copy">Original intro.</p>
      <input id="email" class="field" style="background-color: red; --gap: 1rem;" required readonly autofocus maxlength="30" data-hts-field="lead_email">
      <input type="checkbox" data-hts-field="accept_updates">
      <select data-hts-field="preferred_package"><option>Starter</option><option>Scale</option></select>
      <a href="#email" aria-controls="email">Jump</a>
      <a href="/old" data-hts-field="primary_cta">Start</a>
      <img src="./hero.svg" alt="Hero" data-hts-field="hero_image">
      <p>Do not rewrite text that mentions ./hero.svg outside an attribute.</p>
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
    'src/integrations/react-template-v1/generated-file-hashes.json',
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
  assert.match(jsx, /dangerouslySetInnerHTML=\{\{ __html: renderTemplateHtml\(blok\) \}\}/);
  assert.match(jsx, /import \{ renderTemplateHtml \} from '\.\/template-html\.js'/);

  const { renderTemplateHtml } = await import(pathToFileURL(path.join(repoPath, 'src/integrations/react-template-v1/template-html.js')).href);
  const rendered = renderTemplateHtml({
    headline: 'Live Storyblok headline',
    body: [{
      component: 'hts_react_template_v1_hero',
      intro_copy: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live rich text intro.' }] }]
      },
      hero_image: {
        fieldtype: 'asset',
        filename: 'https://a.storyblok.com/f/123/live-hero.svg',
        alt: 'Live hero alt'
      },
      primary_cta: {
        linktype: 'story',
        cached_url: 'demo/contact'
      },
      lead_email: 'hello@example.com',
      accept_updates: true,
      preferred_package: 'Scale'
    }]
  });

  assert.match(rendered, /id="hts-react-template-v1-email"/);
  assert.match(rendered, /for="hts-react-template-v1-email"/);
  assert.match(rendered, /href="#hts-react-template-v1-email"/);
  assert.match(rendered, /aria-controls="hts-react-template-v1-email"/);
  assert.match(rendered, /class="hts-react-template-v1-field"/);
  assert.match(rendered, /style="background-color: red; --gap: 1rem;"/);
  assert.match(rendered, /required readonly autofocus maxlength="30"/);
  assert.match(rendered, /value="hello@example.com"/);
  assert.match(rendered, /type="checkbox"[^>]*checked/);
  assert.match(rendered, /<option selected>Scale<\/option>/);
  assert.match(rendered, /<h1 data-hts-field="headline">Live Storyblok headline<\/h1>/);
  assert.match(rendered, /<p data-hts-field="intro_copy">Live rich text intro\.<\/p>/);
  assert.match(rendered, /<a href="\/demo\/contact" data-hts-field="primary_cta">Start<\/a>/);
  assert.match(rendered, /<img src="https:\/\/a\.storyblok\.com\/f\/123\/live-hero\.svg" alt="Live hero alt" data-hts-field="hero_image">/);
  assert.match(rendered, /Do not rewrite text that mentions \.\/hero\.svg outside an attribute/);
  assert.match(rendered, /fill-rule="evenodd" stroke-width="2"/);
  assert.match(rendered, /<my-widget class="hts-react-template-v1-widget" custom-attr="demo" data-mode="compact"><\/my-widget>/);
  assert.doesNotMatch(jsx, /onclick/);
  assert.doesNotMatch(rendered, /onclick/);
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
  assert.deepEqual(result.route_previews.map((route) => route.suggested_site_path), ['/', '/about', '/contact', '/gallery', '/services']);
  assert.equal(result.route_previews[0].preview_file, 'src/integrations/acme-campaign-v1/routes/home/template.html');
  assert.equal(result.route_previews[0].route_proposal_file, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js');
  assert.equal(result.route_previews[0].seo.title, 'HTML-to-Storyblok Integration Agent');

  const routeManifest = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/routes/manifest.json'), 'utf8'));
  assert.deepEqual(routeManifest.routes.map((route) => route.slug), ['home', 'about', 'contact', 'gallery', 'services']);
  assert.equal(routeManifest.routes[0].path, '/');
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
  assert.equal(adapterPlan.routes[0].seo.title, 'HTML-to-Storyblok Integration Agent');
  assert.equal(adapterPlan.routes[0].seo.description, 'A five-route sample template for testing HTML-to-Storyblok imports.');
  assert.equal(adapterPlan.route_proposals.host_routes_modified, false);

  const proposalManifest = JSON.parse(await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/route-proposals/manifest.json'), 'utf8'));
  assert.equal(proposalManifest.additive_only, true);
  assert.equal(proposalManifest.routes[0].proposal_file, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js');
  assert.equal(proposalManifest.routes[0].seo.title, 'HTML-to-Storyblok Integration Agent');

  const homeProposal = await readFile(path.join(repoPath, 'src/integrations/acme-campaign-v1/route-proposals/home/route.js'), 'utf8');
  assert.match(homeProposal, /renderHtsRouteProposal/);
  assert.match(homeProposal, /'\.\.\/\.\.\/routes\/home\/template-html\.js'/);
  assert.match(homeProposal, /"description": "A five-route sample template for testing HTML-to-Storyblok imports\."/);

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

test('generate honors the planned framework when runtime framework is auto', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-auto-framework-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'auto-next-v1',
    templatePath: 'templates/acme-campaign',
    framework: 'auto',
    repoPath: 'demo-sites/next'
  });

  const result = await generateIntegration(manifest, {
    repoPath,
    templatePath: 'templates/acme-campaign',
    framework: 'auto'
  });

  assert.equal(result.framework, 'next');
  assert.ok(result.files.includes('src/integrations/auto-next-v1/TemplatePage.jsx'));
  assert.ok(result.files.includes('src/integrations/auto-next-v1/route-proposals/home/page.jsx'));
  assert.equal(result.files.includes('src/integrations/auto-next-v1/template.html'), false);
});
