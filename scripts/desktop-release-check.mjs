import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const requiredFiles = [
  'bin/html-to-storyblok.js',
  'desktop/main.js',
  'desktop/preload.cjs',
  'desktop/renderer/index.html',
  'desktop/renderer/app.js',
  'desktop/renderer/styles.css',
  'id30-logo.svg'
];

const requiredScripts = [
  'desktop',
  'desktop:dry-run',
  'desktop:release-check',
  'desktop:pack',
  'desktop:dist'
];

const requiredBuildFiles = [
  'bin/**/*',
  'desktop/**/*',
  'src/**/*',
  'templates/**/*',
  'id30-logo.svg',
  'package.json'
];

const issues = [];

for (const file of requiredFiles) {
  try {
    await access(path.join(root, file));
  } catch {
    issues.push(`missing release file: ${file}`);
  }
}

for (const script of requiredScripts) {
  if (!packageJson.scripts?.[script]) issues.push(`missing package script: ${script}`);
}

if (packageJson.main !== 'desktop/main.js') {
  issues.push('package main must point to desktop/main.js for packaged Electron launches');
}

if (!packageJson.devDependencies?.electron) {
  issues.push('missing devDependency: electron');
}

if (!packageJson.devDependencies?.['electron-builder']) {
  issues.push('missing devDependency: electron-builder');
}

if (packageJson.license !== 'UNLICENSED') {
  issues.push('desktop application must remain UNLICENSED/proprietary');
}

const build = packageJson.build || {};
if (build.appId !== 'com.id30.html-to-storyblok') issues.push('build.appId must be com.id30.html-to-storyblok');
if (build.productName !== 'HTML-to-Storyblok') issues.push('build.productName must be HTML-to-Storyblok');
if (build.asar !== false) {
  issues.push('build.asar must remain false until packaged child CLI execution is verified with an asar archive');
}

for (const filePattern of requiredBuildFiles) {
  if (!build.files?.includes(filePattern)) issues.push(`build.files must include ${filePattern}`);
}

const serializedBuild = JSON.stringify(build);
for (const forbidden of ['STORYBLOK_MANAGEMENT_TOKEN', 'STORYBLOK_PREVIEW_TOKEN', 'NETLIFY_AUTH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN']) {
  if (serializedBuild.includes(forbidden)) issues.push(`build config must not include secret env key ${forbidden}`);
}

const result = {
  action: 'desktop_release_check',
  status: issues.length ? 'failed' : 'passed',
  product_name: build.productName || null,
  app_id: build.appId || null,
  output_directory: build.directories?.output || null,
  scripts: requiredScripts,
  files: requiredFiles,
  warnings: [
    'Installer signing and notarization are intentionally not automated until ID30 release certificates are configured.',
    'build.asar is disabled so the packaged app can spawn the bundled CLI from normal filesystem paths.'
  ],
  issues
};

console.log(JSON.stringify(result, null, 2));

if (issues.length) process.exitCode = 1;
