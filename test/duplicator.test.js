import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { duplicateFrontendComponents } from '../src/duplicator.js';
import { createDefaultManifest } from '../src/policy.js';

test('frontend duplication creates an isolated copy in namespace', async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'hts-duplicate-'));
  await mkdir(path.join(repoPath, 'src/components'), { recursive: true });
  await mkdir(path.join(repoPath, 'src/integrations/acme-homepage-v1/components'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/components/Button.js'), 'export function Button(){ return `<button class="button primary">Go</button>`; }\n');

  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.repository.components_to_duplicate.push({
    source_path: 'src/components/Button.js',
    target_path: 'src/integrations/acme-homepage-v1/components/HtsButton.js',
    export_name: 'Button',
    new_export_name: 'HtsButton'
  });

  const result = await duplicateFrontendComponents(manifest, { repoPath });
  const duplicated = await readFile(path.join(repoPath, 'src/integrations/acme-homepage-v1/components/HtsButton.js'), 'utf8');

  assert.equal(result[0].runtime_dependency_retained, false);
  assert.match(duplicated, /HtsButton/);
  assert.match(duplicated, /hts-acme-homepage-v1-button/);
});
