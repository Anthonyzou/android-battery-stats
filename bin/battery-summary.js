#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseBatteryStats } from '../src/parse.js';
import { formatSummary } from '../src/format.js';

const USAGE = `Usage: battery-summary [options] <batterystats.txt | ->

Summarize the output of \`adb shell dumpsys batterystats\`.

Options:
  -n, --top <N>   Rows to show in each top-N table (default 10)
  -j, --json      Print the parsed data as JSON
  -h, --help      Show this help`;

async function readInput(path) {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      top: { type: 'string', short: 'n', default: '10' },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const top = Number(values.top);
  if (!Number.isInteger(top) || top < 1) {
    console.error(`Invalid --top value: ${values.top}`);
    process.exitCode = 2;
    return;
  }

  const report = parseBatteryStats(await readInput(positionals[0]));
  console.log(values.json ? JSON.stringify(report, null, 2) : formatSummary(report, { top }));
}

main().catch((err) => {
  console.error(`battery-summary: ${err.message}`);
  process.exitCode = 1;
});
