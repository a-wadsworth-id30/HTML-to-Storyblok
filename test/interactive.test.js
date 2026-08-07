import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { main } from '../src/cli.js';
import { loadConfig, parseSettingAssignment, saveConfig, updateConfigValue, updateProfileValue } from '../src/config.js';
import { discoverRepositories, discoverTemplates } from '../src/discovery.js';
import { createDashboardModel, runInteractiveApp, runSettings } from '../src/interactive.js';
import { createDefaultManifest } from '../src/policy.js';
import { pathExists } from '../src/utils.js';

test('configuration is persisted without secret-like keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hts-config-'));
  const configPath = path.join(root, 'config.json');

  let config = await loadConfig({ configPath });
  assert.equal(config.templates_folder, 'templates');

  config = updateConfigValue(config, 'templates_folder', 'source-templates');
  config = updateConfigValue(config, 'verbose_logging', 'yes');
  config = updateProfileValue(config, 'Client Site', 'default_repository', '../client-site');
  config = updateProfileValue(config, 'Client Site', 'storyblok_region', 'us');
  config = updateProfileValue(config, 'Client Site', 'storyblok_space_id', '12345');
  config = updateConfigValue(config, 'active_profile', 'client-site');
  await saveConfig({ ...config, secret_token: 'do-not-store' }, { configPath });

  const persisted = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(persisted.templates_folder, 'source-templates');
  assert.equal(persisted.verbose_logging, true);
  assert.equal(persisted.active_profile, 'client-site');
  assert.equal(persisted.project_profiles['client-site'].default_repository, '../client-site');
  assert.equal(persisted.project_profiles['client-site'].storyblok_region, 'us');
  assert.equal(persisted.project_profiles['client-site'].storyblok_space_id, '12345');
  assert.equal(Object.hasOwn(persisted, 'secret_token'), false);
  assert.deepEqual(parseSettingAssignment('storyblok_region=us'), { key: 'storyblok_region', value: 'us' });

  const applied = await loadConfig({ configPath });
  assert.equal(applied.default_repository, '../client-site');
  assert.equal(applied.storyblok_region, 'us');
  assert.equal(applied.storyblok_space_id, '12345');
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

test('interactive create flow prompts for session-only Storyblok credentials', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  const output = new CaptureOutput({ isTTY: true });
  const calls = mockStoryblokFetch();
  try {
    const result = await runInteractiveApp({
      args: {
        config: path.join(root, 'config.json'),
        work_dir: workDir
      },
      input: { isTTY: true },
      output,
      cwd: root,
      answers: [
        'create',
        path.join(root, 'templates/acme-homepage'),
        path.join(root, 'client-site'),
        'management-token',
        '12345',
        'preview-token',
        'acme-homepage-v1',
        'no',
        'exit'
      ]
    });

    assert.equal(result.status, 'dry_run_complete');
    assert.ok(calls.some((call) => call.url.includes('/spaces/12345/components/')));
    const storyblokAccess = await readFile(path.join(workDir, 'storyblok-access.json'), 'utf8');
    assert.match(storyblokAccess, /STORYBLOK_MANAGEMENT_TOKEN/);
    assert.doesNotMatch(storyblokAccess, /management-token|preview-token/);
    assert.doesNotMatch(output.text(), /management-token|preview-token/);
  } finally {
    restoreFetch();
  }
});

test('interactive Storyblok-only flow continues when optional remote inspection fails', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  const output = new CaptureOutput({ isTTY: true });
  mockFailingStoryblokFetch();
  try {
    const result = await runInteractiveApp({
      args: {
        config: path.join(root, 'config.json'),
        work_dir: workDir
      },
      input: { isTTY: true },
      output,
      cwd: root,
      answers: [
        'storyblok-only',
        path.join(root, 'templates/acme-homepage'),
        'management-token',
        '294359959203001',
        '',
        'acme-homepage-storyblok-v1',
        'no',
        'exit'
      ]
    });

    assert.equal(result.status, 'dry_run_complete');
    assert.equal(result.validation.valid, true);
    const storyblokAccess = await readFile(path.join(workDir, 'storyblok-access.json'), 'utf8');
    assert.match(storyblokAccess, /inspection_failed/);
    assert.doesNotMatch(storyblokAccess, /management-token/);
    assert.match(output.text(), /Storyblok remote inspection failed/);
    assert.doesNotMatch(output.text(), /management-token/);
  } finally {
    restoreFetch();
  }
});

test('interactive create flow can skip repository for a Storyblok-only test', async () => {
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
      '__storyblok_only__',
      'acme-homepage-storyblok-v1',
      'no'
    ]
  });

  assert.equal(result.action, 'storyblok_only_integration');
  assert.equal(result.status, 'dry_run_complete');
  assert.equal(result.manifest.storyblok_prefix, 'hts_acme_homepage_storyblok_v1_');
  assert.equal(result.validation.valid, true);
  assert.equal(await pathExists(path.join(workDir, 'repository-inspection.json')), false);
  assert.equal(await pathExists(path.join(workDir, 'storyblok-apply-result.json')), true);
  assert.match(output.text(), /Storyblok Plan Summary/);
  assert.match(output.text(), /Repository\s+Skipped for this test/);
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

test('interactive resume can edit generated Storyblok story links', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const manifest = editableManifest();
  await writeFile(path.join(workDir, 'integration-manifest.json'), JSON.stringify(manifest, null, 2));

  const output = new CaptureOutput({ isTTY: true });
  await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir
    },
    input: new TestInput(),
    output,
    cwd: root,
    answers: [
      'resume',
      'link-mapping',
      '0',
      'acme-homepage-v1/about',
      'done',
      'exit'
    ]
  });

  const updated = JSON.parse(await readFile(path.join(workDir, 'integration-manifest.json'), 'utf8'));
  const link = updated.storyblok.stories_to_create[0].content.body[0].cta_link;
  assert.equal(link.linktype, 'story');
  assert.equal(link.cached_url, 'acme-homepage-v1/about');
  assert.equal(link.url, '');
  assert.match(output.text(), /Story Link Mapping/);
});

test('interactive resume can edit generated Storyblok field mapping', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const manifest = editableManifest();
  await writeFile(path.join(workDir, 'integration-manifest.json'), JSON.stringify(manifest, null, 2));

  const output = new CaptureOutput({ isTTY: true });
  await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir
    },
    input: new TestInput(),
    output,
    cwd: root,
    answers: [
      'resume',
      'field-mapping',
      '0',
      'textarea',
      'Hero Headline',
      'done',
      'exit'
    ]
  });

  const updated = JSON.parse(await readFile(path.join(workDir, 'integration-manifest.json'), 'utf8'));
  const field = updated.storyblok.components_to_create[0].schema.headline;
  assert.equal(field.type, 'textarea');
  assert.equal(field.display_name, 'Hero Headline');
  assert.match(output.text(), /Field Mapping/);
});

test('interactive app returns to the home screen after a completed action', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  const output = new CaptureOutput({ isTTY: true });
  const input = new TestInput();
  const result = await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir
    },
    input,
    output,
    cwd: root,
    answers: [
      'template',
      path.join(root, 'templates/acme-homepage'),
      'home',
      'exit'
    ]
  });

  const headers = output.text().match(/HTML -> Storyblok/g) || [];
  assert.equal(result.action, 'exit');
  assert.equal(input.paused, true);
  assert.equal(headers.length >= 2, true);
  assert.match(output.text(), /\$\$\$\$\$\$\$\$\$\$\$/);
  assert.match(output.text(), /Copyright 2026 ID30\. Developer: Adam Wadsworth - a\.wadsworth@id30\.com/);
  assert.match(output.text(), /Legal Notice: This software is the proprietary property of iD30\./);
  assert.match(output.text(), /Next/);
});

test('interactive action failure shows recovery options before returning home', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  const output = new CaptureOutput({ isTTY: true });
  const result = await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir
    },
    input: new TestInput(),
    output,
    cwd: root,
    answers: [
      'template',
      '__browse__',
      path.join(root, 'missing-template'),
      'home',
      'home',
      'exit'
    ]
  });

  assert.equal(result.action, 'exit');
  assert.match(output.text(), /Action Failed/);
  assert.match(output.text(), /Recovery/);
});

test('interactive completed Storyblok apply can validate and return to the home screen', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-storyblok-v1',
    storyblokPrefix: 'hts_acme_homepage_storyblok_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-storyblok-v1'
  });
  await writeFile(path.join(workDir, 'integration-manifest.json'), JSON.stringify(manifest, null, 2));

  const output = new CaptureOutput({ isTTY: true });
  const input = new TestInput();
  const result = await runInteractiveApp({
    args: {
      config: path.join(root, 'config.json'),
      work_dir: workDir
    },
    input,
    output,
    cwd: root,
    answers: [
      'resume',
      'storyblok-apply',
      'management-token',
      '12345',
      'eu',
      '',
      'validate',
      'home',
      'exit'
    ]
  });

  const text = output.text();
  const headers = text.match(/HTML -> Storyblok/g) || [];
  assert.equal(result.action, 'exit');
  assert.equal(input.paused, true);
  assert.equal(headers.length >= 2, true);
  assert.match(text, /Storyblok Integration Complete/);
  assert.match(text, /Success/);
  assert.match(text, /Plan Validation\s+Passed/);
  assert.match(text, /Local Validation/);
  assert.match(text, /Repository output was skipped/);
  assert.match(text, /Next/);
});

test('storyblok-apply command runs the remote-only workflow without a repository', async () => {
  const root = await createFixtureWorkspace();
  const workDir = path.join(root, 'work');

  await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'plan',
      '--integration-id',
      'acme-homepage-storyblok-cli-v1',
      '--template',
      path.join(root, 'templates/acme-homepage'),
      '--framework',
      'static',
      '--work-dir',
      workDir,
      '--no-interactive'
    ]);
  });

  const output = await captureStdout(async () => {
    await main([
      'node',
      'html-to-storyblok',
      'storyblok-apply',
      '--manifest',
      path.join(workDir, 'integration-manifest.json'),
      '--dry-run',
      '--work-dir',
      workDir,
      '--no-interactive'
    ]);
  });

  const result = JSON.parse(await readFile(path.join(workDir, 'storyblok-apply-result.json'), 'utf8'));
  assert.equal(result.action, 'apply_storyblok_only');
  assert.equal(result.repository_skipped, true);
  assert.equal(result.dry_run, true);
  assert.match(output, /apply_storyblok_only/);
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
  assert.match(output, /Copyright 2026 ID30\. Developer: Adam Wadsworth - a\.wadsworth@id30\.com/);
  assert.match(output, /Legal Notice: This software is the proprietary property of iD30\./);
  assert.match(output, /html-to-storyblok dashboard/);
});

test('completion command prints shell completions', async () => {
  const output = await captureStdout(async () => {
    await main(['node', 'html-to-storyblok', 'completion', '--shell', 'fish', '--no-interactive']);
  });
  assert.match(output, /complete -c html-to-storyblok/);
  assert.match(output, /storyblok-apply/);
  assert.match(output, /validate-storyblok/);
  assert.match(output, /sb-apply/);
  assert.match(output, /examples/);
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

function editableManifest() {
  const manifest = createDefaultManifest({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    repositoryNamespace: 'src/integrations/acme-homepage-v1'
  });
  manifest.storyblok.components_to_create = [
    {
      technical_name: 'hts_acme_homepage_v1_hero',
      component_type: 'nestable',
      schema: {
        headline: {
          type: 'text'
        }
      }
    },
    {
      technical_name: 'hts_acme_homepage_v1_template_page',
      component_type: 'content_type',
      schema: {
        body: {
          type: 'bloks',
          restrict_components: true,
          component_whitelist: ['hts_acme_homepage_v1_hero']
        }
      }
    }
  ];
  manifest.storyblok.stories_to_create = [
    {
      slug: 'acme-homepage-v1/home',
      content: {
        component: 'hts_acme_homepage_v1_template_page',
        body: [
          {
            component: 'hts_acme_homepage_v1_hero',
            headline: 'Home',
            cta_link: {
              linktype: 'story',
              cached_url: 'legacy/contact'
            }
          }
        ]
      }
    },
    {
      slug: 'acme-homepage-v1/about',
      content: {
        component: 'hts_acme_homepage_v1_template_page',
        body: []
      }
    }
  ];
  return manifest;
}

class CaptureOutput extends Writable {
  constructor({ isTTY = false } = {}) {
    super();
    this.isTTY = isTTY;
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

class TestInput {
  constructor() {
    this.isTTY = true;
    this.isRaw = false;
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

let originalFetch;

function mockStoryblokFetch() {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    let body = {};
    if (String(url).endsWith('/spaces/12345')) {
      body = { space: { id: 12345, name: 'Test Space', domain: 'example.test' } };
    } else if (String(url).endsWith('/spaces/12345/components/')) {
      body = { components: [] };
    } else if (String(url).includes('/spaces/12345/stories?')) {
      body = { stories: [] };
    } else if (String(url).includes('/spaces/12345/assets?')) {
      body = { assets: [] };
    } else {
      throw new Error(`unexpected Storyblok request: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body)
    };
  };
  return calls;
}

function mockFailingStoryblokFetch() {
  originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: 'Unauthorized' })
  });
}

function restoreFetch() {
  global.fetch = originalFetch;
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
