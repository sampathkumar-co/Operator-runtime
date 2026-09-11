#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Operator bootstrap failed: ${message}`);
  process.exitCode = 1;
}
