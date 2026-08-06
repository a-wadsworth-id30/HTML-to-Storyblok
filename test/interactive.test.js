import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { main } from '../src/cli.js';
import { loadConfig, parseSettingAssignment, saveConfig, updateConfigValue } from '../src/config.js';
import { discoverRepositories, discoverTemplates } from '../src/discovery.js';
import { createDashboardModel, runInteractiveApp, runSettings } from '../src/interactive.js';
import { pathExists } from '../src/utils.js';

test('configuration is persisted without secret-like keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-config-'));
  const configPath = path.join(root, 'config.json');

  let config = await loadConfig({ configPath });
  assert.equal(config.templates_folder, 'templates');

  config = updateConfigValue(config, 'templates_folder', 'source-templates');
  config = updateConfigValue(config, 'verbose_logging', 'yes');
  await saveConfig({ ...config, secret_token: 'do-not-store' }, { configPath });

  const persisted = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(persisted.templates_folder, 'source-templates');
  assert.equal(persisted.verbose_logging, true);
  assert.equal(Object.hasOwn(persisted, 'secret_token'), false);
  assert.deepEqual(parseSettingAssignment('storyblok_region=us'), { key: 'storyblok_region', value: 'us' });
});

test('template and repository discovery find nearby integration inputs', async () => {
  const root = await createFixtureWorkspace();

  const templates = await discoverTemplates({ templatesFolder: 'templates', cwd: root });
  assert.deepEqual(templates.map((template) => template.name), ['acme-homepage']);

  const repositories = await discoverRepositories({ cwd: path.join(root, 'client-site') });
  assert.ok(repositories.some((repository) => repository.path === path.join(root, 'client-site')));
});

test('interactive create flow produces a validated dry-run integration and report', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  const output = new CaptureOutput();
  const result = await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir,
      no_interactive: true
    },
    output,
    cwd: root,
    answers: [
      'create',
      path.join(root, 'templates/acme-homepage'),
      path.join(root, 'client-site'),
      'acme-homepage-v1',
      'no'
    ]
  });

  assert.equal(result.status, 'dry_run_complete');
  assert.equal(result.manifest.storyblok_prefix, 'hts_acme_homepage_v1_');
  assert.equal(result.validation.valid, true);
  assert.equal(await pathExists(path.join(workDir, 'integration-manifest.json')), true);
  assert.equal(await pathExists(path.join(workDir, 'report.md')), true);
  assert.match(output.text(), /Plan Summary/);
  assert.match(output.text(), /Dry run complete/);
});

test('interactive resume can open the report viewer for an existing integration', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  await runInteractiveApp({
    args: { config: path.join(root, 'config.json'), work_dir: workDir, no_interactive: true },
    output: new CaptureOutput(),
    cwd: root,
    answers: [
      'create',
      path.join(root, 'templates/acme-homepage'),
      path.join(root, 'client-site'),
      'acme-homepage-v1',
      'no'
    ]
  });

  const output = new CaptureOutput();
  const result = await runInteractiveApp({
    args: { config: path.join(root, 'config.json'), work_dir: workDir, no_interactive: true },
    output,
    cwd: root,
    answers: ['resume', 'report']
  });

  assert.equal(result.markdown_report, path.join(workDir, 'report.md'));
  assert.match(output.text(), /Previous integration detected/);
  assert.match(output.text(), /View Latest Report/);
});

test('dashboard model summarizes the latest integration state', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  await runInteractiveApp({
    args: { config: path.join(root, 'config.json'), work_dir: workDir, no_interactive: true },
    output: new CaptureOutput(),
    cwd: root,
    answers: [
      'create',
      path.join(root, 'templates/acme-homepage'),
      path.join(root, 'client-site'),
      'acme-homepage-v1',
      'no'
    ]
  });

  const model = await createDashboardModel({
    workDir,
    cwd: root,
    config: { default_repository: 'client-site', preferred_framework: 'auto' }
  });

  assert.equal(model.framework, 'Astro');
  assert.equal(model.last_integration, 'acme-homepage-v1');
  assert.equal(model.validation, 'Passed');
  assert.equal(model.pending_draft_stories, 1);
  assert.equal(model.generated_components > 0, true);
});

test('settings command updates local defaults non-interactively', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-settings-'));
  const configPath = path.join(root, 'config.json');
  const output = new CaptureOutput();

  const config = await runSettings({
    args: {
      config: configPath,
      no_interactive: true,
      set: 'color_mode=never'
    },
    output
  });

  assert.equal(config.color_mode, 'never');
  assert.match(output.text(), /Color Mode/);
});

test('no-command non-interactive CLI path prints help without launching the wizard', async () => {
  const output = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', '--no-interactive']);
  });
  assert.match(output, /html-to-storyblok dashboard/);
});

async function createFixtureWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-interactive-'));
  const templatePath = path.join(root, 'templates/acme-homepage');
  const repoPath = path.join(root, 'client-site');
  await mkdir(templatePath, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(templatePath, 'index.html'), `<!doctype html>
<html>
  <head>
    <title>Acme Homepage</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <main>
      <section class="hero"><h1>Acme</h1><p>Useful landing page.</p></section>
    </main>
  </body>
</html>
`);
  await writeFile(path.join(templatePath, 'style.css'), '.hero { color: #123456; }\n');
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'client-site',
    dependencies: {
      astro: '^5.0.0',
      '@storyblok/astro': '^6.0.0',
      tailwindcss: '^4.0.0'
    },
    devDependencies: {
      typescript: '^5.0.0'
    },
    scripts: {
      build: 'astro build'
    }
  }, null, 2));
  await writeFile(path.join(repoPath, 'netlify.toml'), '[build]\ncommand = "npm run build"\npublish = "dist"\n');
  await writeFile(path.join(repoPath, 'src.ts'), 'export const value: string = "ok";\n');
  return root;
}

class CaptureOutput extends Writable {
  constructor() {
    super();
    this.isTTY = false;
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk).toString('utf8'));
    callback();
  }

  text() {
    return this.chunks.join('');
  }
}

async function captureStdout(callback) {
  const originalLog = console.log;
  let output = '';
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return output.trim();
}
