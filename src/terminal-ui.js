import readline from 'node:readline';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  clearLine: '\u001b[2K',
  cursorStart: '\r'
};

export function createTerminal({
  input = defaultInput,
  output = defaultOutput,
  colorMode = 'auto',
  interactive = Boolean(input.isTTY && output.isTTY)
} = {}) {
  const color = colorMode === 'always' || (colorMode !== 'never' && !process.env.NO_COLOR && output.isTTY === true);
  const style = (name, value) => color ? `${ANSI[name]}${value}${ANSI.reset}` : value;
  const write = (value = '') => output.write(String(value));
  const line = (value = '') => write(`${value}\n`);
  const terminal = {
    input,
    output,
    interactive,
    color,
    style,
    write,
    line,
    header(title, subtitle = '') {
      line(style('gray', '────────────────────────────────────────────'));
      line('');
      line(style('bold', title));
      if (subtitle) line(style('dim', subtitle));
      line('');
    },
    section(title) {
      line(style('cyan', title));
    },
    status(label, status = 'info', detail = '') {
      const symbol = statusSymbol(status);
      const colorName = statusColor(status);
      line(`${style(colorName, symbol)} ${label}${detail ? ` ${style('dim', detail)}` : ''}`);
    },
    keyValue(label, value, status = null) {
      const prefix = status ? `${style(statusColor(status), statusSymbol(status))} ` : '';
      line(`${prefix}${label.padEnd(22)} ${value ?? 'Unknown'}`);
    },
    panel(title, rows = []) {
      if (title) this.section(title);
      for (const row of rows) {
        if (Array.isArray(row)) this.keyValue(row[0], row[1], row[2]);
        else line(String(row));
      }
      line('');
    },
    progress(label, current, total) {
      const safeTotal = Math.max(Number(total) || 0, 1);
      const safeCurrent = Math.min(Math.max(Number(current) || 0, 0), safeTotal);
      const width = 10;
      const filled = Math.round((safeCurrent / safeTotal) * width);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
      const percent = Math.round((safeCurrent / safeTotal) * 100);
      line(`${label}\n${style('cyan', bar)} ${safeCurrent} / ${safeTotal} ${percent}%`);
    },
    async task(label, callback) {
      if (!interactive) {
        this.status(label, 'info', 'started');
        const result = await callback();
        this.status(label, 'success', 'done');
        return result;
      }
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const started = Date.now();
      let index = 0;
      const timer = setInterval(() => {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        write(`${ANSI.clearLine}${ANSI.cursorStart}${style('cyan', frames[index % frames.length])} ${label} ${style('dim', `${elapsed}s`)}`);
        index += 1;
      }, 80);
      try {
        const result = await callback();
        clearInterval(timer);
        write(`${ANSI.clearLine}${ANSI.cursorStart}`);
        this.status(label, 'success', 'done');
        return result;
      } catch (error) {
        clearInterval(timer);
        write(`${ANSI.clearLine}${ANSI.cursorStart}`);
        this.status(label, 'error', 'failed');
        throw error;
      }
    }
  };
  return terminal;
}

export async function selectOption(terminal, {
  message,
  choices,
  defaultIndex = 0,
  allowEscape = true,
  answers
}) {
  if (answers?.length) {
    const answer = answers.shift();
    const matched = choices.find((choice) => choice.value === answer || choice.label === answer);
    return matched ? matched.value : answer;
  }
  if (!terminal.interactive || !terminal.input.isTTY) {
    terminal.line(message);
    choices.forEach((choice, index) => terminal.line(`${index === defaultIndex ? '>' : ' '} ${choice.label}`));
    return choices[defaultIndex]?.value;
  }

  return new Promise((resolve) => {
    let selected = defaultIndex;
    const input = terminal.input;
    const output = terminal.output;
    const wasRaw = input.isRaw;

    const render = () => {
      output.write('\u001b[?25l');
      output.write(`${ANSI.clearLine}${ANSI.cursorStart}${message}\n`);
      for (let index = 0; index < choices.length; index += 1) {
        const choice = choices[index];
        const pointer = index === selected ? terminal.style('cyan', '❯') : ' ';
        output.write(`${ANSI.clearLine}${ANSI.cursorStart}${pointer} ${choice.label}\n`);
      }
      output.write(`\u001b[${choices.length + 1}A`);
    };

    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (input.setRawMode) input.setRawMode(wasRaw);
      output.write(`\u001b[${choices.length + 1}B`);
      output.write('\u001b[?25h');
    };

    const onKeypress = (_str, key = {}) => {
      if (key.name === 'up') selected = selected === 0 ? choices.length - 1 : selected - 1;
      else if (key.name === 'down' || key.name === 'tab') selected = (selected + 1) % choices.length;
      else if (key.name === 'return') {
        cleanup();
        resolve(choices[selected].value);
        return;
      } else if ((key.name === 'escape' && allowEscape) || (key.ctrl && key.name === 'c') || key.name === 'q') {
        cleanup();
        resolve(null);
        return;
      }
      render();
    };

    readline.emitKeypressEvents(input);
    if (input.setRawMode) input.setRawMode(true);
    input.on('keypress', onKeypress);
    render();
  });
}

export async function promptInput(terminal, {
  message,
  defaultValue = '',
  answers
}) {
  if (answers?.length) return String(answers.shift());
  if (!terminal.interactive) {
    terminal.line(`${message}${defaultValue ? ` ${terminal.style('dim', `(${defaultValue})`)}` : ''}`);
    return defaultValue;
  }
  const rl = readline.createInterface({ input: terminal.input, output: terminal.output });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`${message}${defaultValue ? ` (${defaultValue})` : ''}: `, resolve);
    });
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

export async function promptSecret(terminal, {
  message,
  answers
}) {
  if (answers?.length) return String(answers.shift());
  if (!terminal.interactive || !terminal.input.isTTY) {
    terminal.line(message);
    return '';
  }

  return new Promise((resolve) => {
    let value = '';
    let settled = false;
    const input = terminal.input;
    const output = terminal.output;
    const wasRaw = input.isRaw;

    const finish = (nextValue) => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKeypress);
      input.off('end', onEnd);
      input.off('close', onEnd);
      if (input.setRawMode) input.setRawMode(wasRaw);
      output.write('\n');
      resolve(nextValue);
    };

    const onEnd = () => {
      finish(value);
    };

    const onKeypress = (str, key = {}) => {
      if (key.name === 'return') {
        finish(value);
        return;
      }
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        finish('');
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        value += str;
        output.write('*');
      }
    };

    output.write(`${message}: `);
    readline.emitKeypressEvents(input);
    if (input.setRawMode) input.setRawMode(true);
    if (input.resume) input.resume();
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.on('keypress', onKeypress);
  });
}

export async function confirm(terminal, {
  message,
  defaultValue = false,
  answers
}) {
  const answer = await promptInput(terminal, {
    message: `${message} ${defaultValue ? '[Y/n]' : '[y/N]'}`,
    defaultValue: defaultValue ? 'yes' : 'no',
    answers
  });
  return /^(y|yes|true)$/i.test(answer);
}

export function summarizeCount(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}

function statusSymbol(status) {
  if (status === 'success' || status === 'passed' || status === true) return '✓';
  if (status === 'warning' || status === 'skipped') return '!';
  if (status === 'error' || status === 'failed' || status === false) return '✕';
  return '•';
}

function statusColor(status) {
  if (status === 'success' || status === 'passed' || status === true) return 'green';
  if (status === 'warning' || status === 'skipped') return 'yellow';
  if (status === 'error' || status === 'failed' || status === false) return 'red';
  return 'blue';
}
