import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDoctorReport, normalizeDoctorTarget } from '../src/doctor.js';

test('createDoctorReport warns when Netlify CLI is unavailable for log snapshots', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hts-doctor-'));
  const report = await createDoctorReport({
    cwd,
    env: {},
    execFileImpl: (command, _args, callback) => {
      if (command === 'netlify') {
        callback(Object.assign(new Error('not found'), { code: 'ENOENT' }));
        return;
      }
      callback(null, command === 'node' ? 'v20.11.0\n' : '1.0.0\n', '');
    }
  });

  const netlifyCli = report.checks.find((check) => check.name === 'Netlify CLI');

  assert.equal(netlifyCli.status, 'warning');
  assert.equal(netlifyCli.detail, 'Not available');
  assert.match(netlifyCli.fix, /netlify-cli/);
});

test('storyblok-only doctor checks only the Storyblok import prerequisites', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hts-doctor-storyblok-'));
  const commands = [];
  const report = await createDoctorReport({
    cwd,
    env: {},
    target: 'storyblok-only',
    execFileImpl: (command, _args, callback) => {
      commands.push(command);
      callback(null, command === 'node' ? 'v20.11.0\n' : '1.0.0\n', '');
    }
  });

  const checkNames = report.checks.map((check) => check.name);

  assert.equal(report.target, 'storyblok-only');
  assert.equal(report.status, 'failed');
  assert.deepEqual(commands, ['node', 'npm']);
  assert.ok(checkNames.includes('Storyblok Management API'));
  assert.ok(checkNames.includes('Storyblok Content API'));
  assert.equal(checkNames.includes('Netlify credentials'), false);
  assert.equal(checkNames.includes('GitHub credentials'), false);
  assert.equal(checkNames.includes('GitLab credentials'), false);
  assert.equal(checkNames.includes('Repository health'), false);
  assert.equal(report.checks.find((check) => check.name === 'Storyblok Management API').status, 'failed');
  assert.equal(report.checks.find((check) => check.name === 'Storyblok Content API').status, 'warning');
});

test('netlify-preview doctor focuses on deploy preview readiness', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hts-doctor-netlify-'));
  const report = await createDoctorReport({
    cwd,
    env: {},
    target: 'netlify-preview',
    execFileImpl: (command, _args, callback) => {
      callback(null, command === 'node' ? 'v20.11.0\n' : '1.0.0\n', '');
    }
  });

  const checkNames = report.checks.map((check) => check.name);

  assert.equal(report.target, 'netlify-preview');
  assert.ok(checkNames.includes('Netlify CLI'));
  assert.ok(checkNames.includes('Netlify credentials'));
  assert.ok(checkNames.includes('Repository health'));
  assert.equal(checkNames.includes('Storyblok Management API'), false);
  assert.equal(checkNames.includes('Storyblok Content API'), false);
  assert.equal(report.checks.find((check) => check.name === 'Netlify credentials').status, 'failed');
});

test('doctor target aliases normalize to supported workflow profiles', () => {
  assert.equal(normalizeDoctorTarget('storyblok'), 'storyblok-only');
  assert.equal(normalizeDoctorTarget('repo'), 'repo-only');
  assert.equal(normalizeDoctorTarget('netlify'), 'netlify-preview');
  assert.equal(normalizeDoctorTarget('full'), 'full-import');
  assert.equal(normalizeDoctorTarget('unsupported'), 'all');
});
