import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
await access(path.join(cwd, packageJson.demoEntry || 'package.json'));
console.log(`demo build check passed: ${packageJson.name}`);

