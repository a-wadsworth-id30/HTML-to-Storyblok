import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDoctorReport } from '../src/doctor.js';

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
