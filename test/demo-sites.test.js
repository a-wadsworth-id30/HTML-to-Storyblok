import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateIntegration } from '../src/generator.js';
import { inspectRepository } from '../src/inspectors.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createRollbackPreview } from '../src/rollback.js';
import { preflightRepositoryIntegration, runRepositoryScript, validateIntegration } from '../src/validator.js';

const execFileAsync = promisify(execFile);

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
    detected: 'Vue',
    guardFile: 'src/App.vue',
    previewFile: 'TemplatePage.vue'
  },
  {
    name: 'react',
    framework: 'react',
    detected: 'React',
    guardFile: 'src/App.jsx',
    previewFile: 'TemplatePage.jsx'
  }
];

test('demo site matrix accepts isolated repository integration without changing existing app files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-demo-sites-'));
  await cp('demo-sites', path.join(root, 'demo-sites'), {
    recursive: true,
    filter: (source) => !isGeneratedDemoArtifact(source)
  });

  for (const demo of DEMO_CASES) {
    const repoPath = path.join(root, 'demo-sites', demo.name);
    await initializeGitRepo(repoPath);
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
    const homeRoute = await readFile(path.join(repoPath, `src/integrations/${integrationId}/routes/home/${demo.previewFile}`), 'utf8');
    assert.match(homeRoute, /\.\.\/\.\.\/assets\/assets\/logo\.svg/, demo.name);

    const validation = await validateIntegration(manifest, { repoPath });
    assert.equal(validation.status, 'passed', demo.name);

    const build = await runRepositoryScript({ repoPath, script: 'build' });
    assert.equal(build.status, 'passed', demo.name);

    const rollbackPreview = createRollbackPreview(manifest, { repoPath });
    assert.ok(rollbackPreview.repository_files_to_remove.every((entry) => entry.owned_by_integration), demo.name);

    const after = await readFile(guardPath, 'utf8');
    assert.equal(after, before, demo.name);

    await writeFile(guardPath, `${before}\n<!-- unrelated local edit -->\n`);
    const dirtyValidation = await validateIntegration(manifest, { repoPath });
    assert.equal(dirtyValidation.status, 'failed', demo.name);
    assert.ok(dirtyValidation.checks.some((check) => check.name === 'git_status' && check.status === 'failed'), demo.name);
    await writeFile(guardPath, before);

    const secondPreflight = await preflightRepositoryIntegration(manifest, { repoPath });
    assert.equal(secondPreflight.status, 'passed', demo.name);
    assert.ok(secondPreflight.reusable_targets.some((target) => target.startsWith(`src/integrations/${integrationId}/`)), demo.name);

    const generatedTemplate = path.join(repoPath, `src/integrations/${integrationId}/template-html.js`);
    const generatedTemplateBefore = await readFile(generatedTemplate, 'utf8');
    await writeFile(generatedTemplate, `${generatedTemplateBefore}\n<!-- generated drift -->\n`);
    const driftedPreflight = await preflightRepositoryIntegration(manifest, { repoPath });
    assert.equal(driftedPreflight.status, 'failed', demo.name);
    assert.ok(driftedPreflight.blocking_collisions.includes(`src/integrations/${integrationId}/template-html.js`), demo.name);
  }
});

function isGeneratedDemoArtifact(source) {
  return ['node_modules', 'dist', '.astro', '.next', '.nuxt', '.output', 'package-lock.json'].includes(path.basename(source));
}

async function initializeGitRepo(repoPath) {
  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['add', '.'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', 'Initial demo site'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'HTML-to-Storyblok Tests',
      GIT_AUTHOR_EMAIL: 'tests@example.com',
      GIT_COMMITTER_NAME: 'HTML-to-Storyblok Tests',
      GIT_COMMITTER_EMAIL: 'tests@example.com'
    }
  });
}
