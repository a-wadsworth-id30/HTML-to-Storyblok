import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateIntegration } from '../src/generator.js';
import { inspectRepository } from '../src/inspectors.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createRollbackPreview } from '../src/rollback.js';
import { preflightRepositoryIntegration, runRepositoryScript, validateIntegration } from '../src/validator.js';

const DEMO_CASES = [
  {
    name: 'static',
    framework: 'static',
    detected: 'Uncertain',
    guardFile: 'index.html',
    previewFile: 'template.html'
  },
  {
    name: 'astro',
    framework: 'astro',
    detected: 'Astro',
    guardFile: 'src/pages/index.astro',
    previewFile: 'TemplatePage.astro'
  },
  {
    name: 'next',
    framework: 'next',
    detected: 'Next.js',
    guardFile: 'src/app/page.jsx',
    previewFile: 'TemplatePage.jsx'
  },
  {
    name: 'nuxt',
    framework: 'nuxt',
    detected: 'Nuxt',
    guardFile: 'pages/index.vue',
    previewFile: 'TemplatePage.vue'
  },
  {
    name: 'vue',
    framework: 'vue',
    detected: 'Vite',
    guardFile: 'src/App.vue',
    previewFile: 'TemplatePage.vue'
  },
  {
    name: 'react',
    framework: 'react',
    detected: 'Vite',
    guardFile: 'src/App.jsx',
    previewFile: 'TemplatePage.jsx'
  }
];

test('demo site matrix accepts isolated repository integration without changing existing app files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-demo-sites-'));
  await cp('demo-sites', path.join(root, 'demo-sites'), { recursive: true });

  for (const demo of DEMO_CASES) {
    const repoPath = path.join(root, 'demo-sites', demo.name);
    const guardPath = path.join(repoPath, demo.guardFile);
    const before = await readFile(guardPath, 'utf8');
    const integrationId = `demo-${demo.name}-import-v1`;
    const manifest = await createIntegrationPlan({
      integrationId,
      templatePath: 'templates/acme-campaign',
      repoPath,
      framework: demo.framework
    });

    const inspection = await inspectRepository(repoPath);
    assert.equal(inspection.framework.name, demo.detected, demo.name);

    const preflight = await preflightRepositoryIntegration(manifest, { repoPath });
    assert.equal(preflight.status, 'passed', demo.name);

    const generated = await generateIntegration(manifest, {
      repoPath,
      templatePath: 'templates/acme-campaign',
      framework: demo.framework
    });
    assert.ok(generated.files.includes(`src/integrations/${integrationId}/${demo.previewFile}`), demo.name);
    assert.ok(generated.files.includes(`src/integrations/${integrationId}/routes/about/${demo.previewFile}`), demo.name);

    const validation = await validateIntegration(manifest, { repoPath });
    assert.equal(validation.status, 'passed', demo.name);

    const build = await runRepositoryScript({ repoPath, script: 'build' });
    assert.equal(build.status, 'passed', demo.name);

    const rollbackPreview = createRollbackPreview(manifest, { repoPath });
    assert.ok(rollbackPreview.repository_files_to_remove.every((entry) => entry.owned_by_integration), demo.name);

    const after = await readFile(guardPath, 'utf8');
    assert.equal(after, before, demo.name);

    const secondPreflight = await preflightRepositoryIntegration(manifest, { repoPath });
    assert.equal(secondPreflight.status, 'failed', demo.name);
    assert.ok(secondPreflight.collisions.some((target) => target.startsWith(`src/integrations/${integrationId}/`)), demo.name);
  }
});

