import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createTerminal, selectOption } from '../src/terminal-ui.js';

test('terminal exposes the ID30 blue truecolor style', () => {
  const output = new CaptureOutput({ isTTY: true });
  const terminal = createTerminal({ output, colorMode: 'always' });

  terminal.line(terminal.style('id30Blue', 'ID30'));

  assert.match(output.text(), /\u001b\[38;2;0;122;255mID30\u001b\[0m/);
});

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

test('progress output owns long-running task rendering after first progress event', async () => {
  const output = new CaptureOutput({ isTTY: true });
  const terminal = createTerminal({ output, colorMode: 'never' });

  await terminal.task('Long Apply', async () => {
    await delay(120);
    terminal.progress('Creating Storyblok Components', 8, 16, 'rate safe: 6 retries');
    await delay(180);
  });

  const text = output.text();
  const progressIndex = text.indexOf('Creating Storyblok Components');
  assert.notEqual(progressIndex, -1);
  const afterProgress = text.slice(progressIndex);
  assert.doesNotMatch(afterProgress, /⠋ Long Apply|⠙ Long Apply|⠹ Long Apply|⠸ Long Apply|⠼ Long Apply|⠴ Long Apply|⠦ Long Apply|⠧ Long Apply|⠇ Long Apply|⠏ Long Apply/);
  assert.match(afterProgress, /8 \/ 16 50%/);
  assert.match(afterProgress, /✓ Long Apply done/);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
