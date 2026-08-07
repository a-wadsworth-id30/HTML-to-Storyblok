import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dependencies = {
  ...(packageJson.dependencies || {}),
  ...(packageJson.devDependencies || {})
};
const dependencyNames = Object.keys(dependencies);

if (dependencyNames.length === 0) {
  console.log('security audit passed: root package has no external dependencies');
  process.exit(0);
}

if (!(await exists(path.join(root, 'package-lock.json')))) {
  console.error('security audit failed: root package declares dependencies but package-lock.json is missing');
  process.exit(1);
}

console.log(`security audit ready: ${dependencyNames.length} root dependencies are locked; run npm audit before release`);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
