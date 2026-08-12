import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateIntegration } from '../src/generator.js';
import { createIntegrationPlan } from '../src/planner.js';
import { wireRepositoryRoutes } from '../src/route-handoff.js';
import { preflightRepositoryIntegration, validateIntegration } from '../src/validator.js';

const DEMO_ROOT = path.join(process.cwd(), 'demo-sites');
const DEFAULT_SITES = ['static', 'astro', 'next', 'nuxt', 'vue', 'react'];
const args = parseArgs(process.argv.slice(2));
const selectedSites = args.site ? String(args.site).split(',').map((item) => item.trim()).filter(Boolean) : DEFAULT_SITES;
const install = Boolean(args.install);
const smoke = Boolean(args.smoke);
const requireFramework = Boolean(args.require_framework || args.requireFramework);
const generatedIntegration = Boolean(args.generated_integration || args.generatedIntegration || args.generated);
const listOnly = Boolean(args.list);

const summaries = [];

for (const site of selectedSites) {
  const sitePath = path.join(DEMO_ROOT, site);
  const packageJson = await readPackageJson(sitePath);
  if (listOnly) {
    summaries.push({
      site,
      framework_build: Boolean(packageJson.scripts?.['build:framework']),
      generated_integration_compile: Boolean(packageJson.scripts?.['build:framework'] && site !== 'static'),
      preview: Boolean(packageJson.scripts?.['preview:framework']),
      preview_url: packageJson.demoPreviewUrl || null
    });
    continue;
  }

  const generated = generatedIntegration && site !== 'static'
    ? await prepareGeneratedIntegration(site, sitePath, packageJson)
    : null;

  try {
    await runStep(site, sitePath, 'npm run build', ['npm', 'run', 'build']);

    if (!packageJson.scripts?.['build:framework']) {
      summaries.push({ site, status: 'lightweight_only', framework: 'unavailable', generated_integration: generated?.status || 'not_requested' });
      continue;
    }

    if (install) {
      await runStep(site, sitePath, 'npm install', ['npm', 'install']);
    }

    if (!(await pathExists(path.join(sitePath, 'node_modules')))) {
      const summary = {
        site,
        status: requireFramework ? 'failed' : 'skipped',
        framework: 'skipped_missing_node_modules',
        generated_integration: generated?.status || 'not_requested',
        reason: 'Run with --install to install framework dependencies before the full build.'
      };
      summaries.push(summary);
      if (requireFramework) {
        throw new Error(`${site}: node_modules missing; run with --install or omit --require-framework`);
      }
      continue;
    }

    await runStep(site, sitePath, 'npm run build:framework', ['npm', 'run', 'build:framework'], frameworkEnv(site));

    let smokeResult = 'not_requested';
    if (smoke && packageJson.scripts?.['preview:framework'] && packageJson.demoPreviewUrl) {
      smokeResult = await smokePreview(site, sitePath, packageJson.demoPreviewUrl);
    }

    summaries.push({
      site,
      status: 'passed',
      framework: 'built',
      generated_integration: generated?.status || 'not_requested',
      generated_host_file: generated?.host_file || null,
      smoke: smokeResult
    });
  } finally {
    if (generated && !args.keep_generated) {
      await cleanupGeneratedIntegration(sitePath, generated);
    }
  }
}

console.log(JSON.stringify({
  action: 'test_demo_sites_full',
  install,
  smoke,
  sites: summaries
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replaceAll('-', '_');
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      parsed[key] = argv[index + 1];
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

async function readPackageJson(sitePath) {
  return JSON.parse(await readFile(path.join(sitePath, 'package.json'), 'utf8'));
}

async function prepareGeneratedIntegration(site, sitePath, packageJson) {
  if (!packageJson.scripts?.['build:framework']) {
    return { status: 'skipped_no_framework_build' };
  }
  const integrationId = `demo-${site}-generated-compile-v1`;
  let manifest = null;
  let host = null;
  try {
    manifest = await createIntegrationPlan({
      integrationId,
      templatePath: 'templates/acme-campaign',
      repoPath: sitePath,
      framework: site
    });
    const preflight = await preflightRepositoryIntegration(manifest, { repoPath: sitePath });
    if (preflight.status === 'failed') {
      throw new Error(`${site}: generated integration preflight failed: ${preflight.checks.filter((check) => check.status === 'failed').map((check) => check.message).join('; ')}`);
    }
    await generateIntegration(manifest, {
      repoPath: sitePath,
      templatePath: 'templates/acme-campaign',
      framework: site
    });
    const validation = await validateIntegration(manifest, { repoPath: sitePath });
    if (validation.status === 'failed') {
      throw new Error(`${site}: generated integration validation failed: ${validation.checks.filter((check) => check.status === 'failed').map((check) => check.message).join('; ')}`);
    }
    host = await writeGeneratedHostRoute(site, sitePath, integrationId, manifest);
    return {
      status: 'wired_for_framework_compile',
      integration_id: integrationId,
      namespace: manifest.repository_namespace,
      host_file: host.path,
      host_original: host.original
    };
  } catch (error) {
    await cleanupGeneratedIntegration(sitePath, {
      namespace: manifest?.repository_namespace,
      host_file: host?.path,
      host_original: host?.original
    });
    throw error;
  }
}

async function writeGeneratedHostRoute(site, sitePath, integrationId, manifest) {
  if (['astro', 'next', 'nuxt'].includes(site)) {
    const result = await wireRepositoryRoutes(manifest, {
      repoPath: sitePath,
      route: 'about'
    });
    if (result.status !== 'passed') {
      throw new Error(`${site}: route handoff failed: ${result.reason || JSON.stringify(result.summary)}`);
    }
    const route = result.routes.find((entry) => entry.status === 'created');
    return {
      path: route.host_route_file,
      original: null
    };
  }

  const host = generatedHostRoute(site, integrationId);
  const fullPath = path.join(sitePath, host.path);
  const original = await readOptional(fullPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, host.content);
  return {
    path: host.path,
    original
  };
}

function generatedHostRoute(site, integrationId) {
  if (site === 'astro') {
    return {
      path: 'src/pages/__hts-generated-smoke.astro',
      content: `---
import ImportedRoute from '../integrations/${integrationId}/route-proposals/home/page.astro';
const story = { content: { headline: 'Generated integration compile smoke' } };
---

<ImportedRoute story={story} />
`
    };
  }
  if (site === 'next') {
    return {
      path: 'src/app/__hts-generated-smoke/page.jsx',
      content: `import ImportedRoute from '../../integrations/${integrationId}/route-proposals/home/page.jsx';

export default function GeneratedIntegrationSmokePage() {
  return <ImportedRoute story={{ content: { headline: 'Generated integration compile smoke' } }} />;
}
`
    };
  }
  if (site === 'nuxt') {
    return {
      path: 'pages/__hts-generated-smoke.vue',
      content: `<script setup>
import ImportedRoute from '../src/integrations/${integrationId}/route-proposals/home/Page.vue';

const story = { content: { headline: 'Generated integration compile smoke' } };
</script>

<template>
  <ImportedRoute :story="story" />
</template>
`
    };
  }
  if (site === 'vue') {
    return {
      path: 'src/App.vue',
      content: `<script setup>
import ImportedRoute from './integrations/${integrationId}/route-proposals/home/Page.vue';

const story = { content: { headline: 'Generated integration compile smoke' } };
</script>

<template>
  <ImportedRoute :story="story" />
</template>
`
    };
  }
  if (site === 'react') {
    return {
      path: 'src/App.jsx',
      content: `import ImportedRoute from './integrations/${integrationId}/route-proposals/home/page.jsx';

export function App() {
  return <ImportedRoute story={{ content: { headline: 'Generated integration compile smoke' } }} />;
}
`
    };
  }
  throw new Error(`${site}: generated integration compile is not supported for this demo site`);
}

async function cleanupGeneratedIntegration(sitePath, generated) {
  if (generated.host_file) {
    const hostPath = path.join(sitePath, generated.host_file);
    if (generated.host_original === null) {
      await rm(hostPath, { force: true });
    } else {
      await writeFile(hostPath, generated.host_original);
    }
  }
  if (generated.namespace) {
    await rm(path.join(sitePath, generated.namespace), { recursive: true, force: true });
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function runStep(site, cwd, label, command, extraEnv = {}) {
  process.stdout.write(`[${site}] ${label}\n`);
  await run(command, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      CI: 'true'
    }
  });
}

function run(command, { cwd, env = process.env, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: 'inherit'
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command.join(' ')} failed with ${signal || code}`));
      }
    });
  });
}

async function smokePreview(site, cwd, url) {
  process.stdout.write(`[${site}] npm run preview:framework\n`);
  let output = '';
  const child = spawn('npm', ['run', 'preview:framework'], {
    cwd,
    env: {
      ...process.env,
      ...frameworkEnv(site),
      CI: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (output.length > 20000) output = output.slice(-20000);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
    if (output.length > 20000) output = output.slice(-20000);
  });

  try {
    await waitForUrl(url, 60000);
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok || !/<html|<!doctype html/i.test(text)) {
      throw new Error(`${site}: preview smoke failed for ${url}`);
    }
    return 'passed';
  } catch (error) {
    throw new Error(`${error.message}\nPreview output:\n${output.trim() || '(no preview output captured)'}`);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`preview server did not become ready at ${url}: ${lastError?.message || 'timeout'}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve();
    }
  });
}

function frameworkEnv(site) {
  if (site === 'next') return { NEXT_TELEMETRY_DISABLED: '1' };
  if (site === 'nuxt') {
    return {
      NUXT_TELEMETRY_DISABLED: '1',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '4403',
      HOST: '127.0.0.1',
      PORT: '4403'
    };
  }
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
