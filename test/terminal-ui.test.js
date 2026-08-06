import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createTerminal, selectOption } from '../src/terminal-ui.js';

test('selectOption resumes interactive stdin before waiting for menu input', async () => {
  const input = new PassThrough();
  const output = new CaptureOutput({ isTTY: true });
  input.isTTY = true;
  input.isRaw = false;
  input.resumed = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  const originalResume = input.resume.bind(input);
  input.resume = () => {
    input.resumed = true;
    return originalResume();
  };

  const terminal = createTerminal({ input, output });
  const selection = selectOption(terminal, {
    message: 'Next',
    choices: [
      { label: 'Return to Main Menu', value: 'home' },
      { label: 'Exit', value: 'exit' }
    ]
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.resumed, true);
  input.emit('keypress', '\r', { name: 'return' });

  assert.equal(await selection, 'home');
  assert.equal(input.isRaw, false);
  assert.match(output.text(), /Return to Main Menu/);
});

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
