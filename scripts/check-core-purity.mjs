#!/usr/bin/env node
/**
 * Golden Rule #1 enforcement.
 *
 * @pathpulse/nav-core must stay pure TypeScript: no browser APIs, no Node
 * APIs, no React. That purity is what lets one codebase serve the browser,
 * the Capacitor APK, headless replay tests, and the Part B 200 Hz edge engine.
 *
 * Comments and string literals are stripped before scanning, so the file that
 * documents the rule does not itself violate it.
 *
 * Usage: node scripts/check-core-purity.mjs   (or `pnpm lint:core-purity`)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'packages/nav-core/src');

/** Identifiers that must never appear in nav-core. */
const FORBIDDEN = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'requestAnimationFrame',
  'DeviceMotionEvent',
  'DeviceOrientationEvent',
  'Geolocation',
  'process',
  'require',
  '__dirname',
  'Buffer',
  'react',
  'Capacitor',
];

/** Strip // line comments, block comments and string/template literals. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(full);
  }
  return files;
}

const violations = [];
const files = walk(TARGET);

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const code = stripNonCode(raw);
  const lines = code.split('\n');
  lines.forEach((line, idx) => {
    for (const word of FORBIDDEN) {
      // Word boundary match so `windowSize` and `processed` do not trip it.
      const re = new RegExp(`\\b${word}\\b`);
      if (re.test(line)) {
        violations.push({
          file: relative(ROOT, file),
          line: idx + 1,
          word,
          text: raw.split('\n')[idx]?.trim() ?? '',
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('\n✖ nav-core purity violated — Golden Rule #1\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  uses "${v.word}"`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    'nav-core must contain pure functions only. Move browser code into\n' +
      '@pathpulse/sensor-sources or apps/web.\n',
  );
  process.exit(1);
}

console.log(`✔ nav-core is pure — scanned ${files.length} file(s), 0 violations`);
