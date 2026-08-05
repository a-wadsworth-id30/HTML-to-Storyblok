#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`html-to-storyblok: ${message}`);
  process.exitCode = 1;
});

