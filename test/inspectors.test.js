import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectRepository, inspectTemplate } from '../src/inspectors.js';

test('inspectTemplate produces page, CSS, script, asset, and accessibility inventories', async () => {
  const result = await inspectTemplate('test/fixtures/basic-template');

  assert.deepEqual(result.pages, ['index.html']);
  assert.equal(result.page_inventory[0].title, 'Basic Template');
  assert.equal(result.page_inventory[0].landmarks.header, 1);
  assert.equal(result.page_inventory[0].tag_counts.header, 1);
  assert.equal(result.page_inventory[0].headings[0].text, 'Template headline');
  assert.equal(result.page_inventory[0].text_blocks[0].text, 'Template headline');
  assert.ok(result.page_inventory[0].classes.includes('site-header'));
  assert.ok(result.page_inventory[0].ids.includes('top'));
  assert.deepEqual(result.shared_sections, ['header']);
  assert.ok(result.css_inventory.some((entry) => entry.class_selectors.includes('site-header')));
  assert.ok(result.third_party_integrations.includes('https://example.com/tracker.js'));
  assert.deepEqual(result.missing_assets, []);
  assert.ok(result.asset_inventory.some((asset) => asset.file === 'hero.svg'));
});

test('inspectRepository detects framework, package manager, Storyblok, commands, and Netlify contract', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-inspect-repo-'));
  await mkdir(path.join(repoPath, 'src/storyblok'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'client-site',
    packageManager: 'pnpm@9.1.0',
    scripts: {
      dev: 'astro dev',
      build: 'astro build',
      lint: 'eslint .',
      test: 'vitest'
    },
    dependencies: {
      astro: '^4.0.0',
      '@storyblok/astro': '^5.0.0'
    }
  }, null, 2));
  await writeFile(path.join(repoPath, 'pnpm-lock.yaml'), '');
  await writeFile(path.join(repoPath, 'astro.config.mjs'), 'import netlify from "@astrojs/netlify";\n');
  await writeFile(path.join(repoPath, 'src/storyblok/components.js'), 'export const components = { StoryblokComponent: true };\n');
  await writeFile(path.join(repoPath, 'netlify.toml'), '[build]\ncommand = "pnpm build"\npublish = "dist"\n[context.deploy-preview.environment]\nSTORYBLOK_PREVIEW_TOKEN = "placeholder"\n');

  const result = await inspectRepository(repoPath);

  assert.equal(result.framework.name, 'Astro');
  assert.equal(result.package_manager, 'pnpm');
  assert.equal(result.package_manager_version, '9.1.0');
  assert.equal(result.commands.build, 'astro build');
  assert.ok(result.storyblok_sdk.some((pkg) => pkg.name === '@storyblok/astro'));
  assert.ok(result.storyblok.component_registry_candidates.includes('src/storyblok/components.js'));
  assert.equal(result.netlify.publish, 'dist');
  assert.ok(result.netlify.environment_variables.includes('STORYBLOK_PREVIEW_TOKEN'));
});
