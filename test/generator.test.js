import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { createDefaultManifest } from '../src/policy.js';
import { plannedTemplateFilePaths } from '../src/template-converter.js';

test('generate converts template HTML into isolated framework files', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-generator-'));
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create.push({ technical_name: 'hts_acme_v1_template_page' });
  manifest.repository.files_to_create.push(
    'src/integrations/acme-homepage-v1/integration-manifest.json',
    'src/integrations/acme-homepage-v1/index.js',
    'src/integrations/acme-homepage-v1/components.js',
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
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/template-html.js'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/behaviour/acme-homepage-v1.js'));
  assert.deepEqual(result.assets, ['src/integrations/acme-homepage-v1/assets/hero.svg']);

  const css = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/styles/template.css'), 'utf8');
  assert.match(css, /\.hts-acme-homepage-v1-root \.hts-acme-homepage-v1-site-header/);
  assert.doesNotMatch(css, /\.site-header\s*{/);

  const astro = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/TemplatePage.astro'), 'utf8');
  assert.match(astro, /import '\.\/behaviour\/acme-homepage-v1\.js'/);
  assert.match(astro, /class="hts-acme-homepage-v1-site-header"/);
});
