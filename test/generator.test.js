import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/TemplatePage.astro'));
  assert.ok(result.files.includes('src/integrations/acme-homepage-v1/template-html.js'));
  assert.deepEqual(result.assets, ['src/integrations/acme-homepage-v1/assets/hero.svg']);
});
