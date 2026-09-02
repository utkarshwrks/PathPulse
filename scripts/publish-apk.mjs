#!/usr/bin/env node
/**
 * Copy the built APK into the website so visitors can install it.
 *
 * ★ THE ORDERING TRAP, STATED SO NOBODY REDISCOVERS IT ★
 * The APK *contains* the web build (`next build` -> `cap sync` -> gradle), so
 * an APK can never contain the site that offers it. Publish therefore runs
 * BETWEEN the two builds:
 *
 *     pnpm build:android      # produces the APK from the current source
 *     node scripts/publish-apk.mjs
 *     pnpm build              # rebuilds the site, now carrying that APK
 *
 * Skip the middle step and the site serves whatever APK it served last time,
 * which is the exact failure mode that had a stale build in Downloads earlier:
 * a real file, correctly signed, quietly one revision behind. So this writes a
 * manifest with the size, hash and mtime, and the download button shows them —
 * a stale APK should be visible, not merely possible.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apk = resolve(root, 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk');
const outDir = resolve(root, 'apps/web/public/downloads');
const outApk = resolve(outDir, 'PathPulse.apk');
const outManifest = resolve(root, 'apps/web/public/downloads/apk.json');

if (!existsSync(apk)) {
  console.error(
    `\n  No APK at ${apk}\n` +
      `  Build one first:  pnpm build:android\n`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(apk, outApk);

const bytes = readFileSync(outApk);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const { size, mtime } = statSync(outApk);

const manifest = {
  file: 'downloads/PathPulse.apk',
  sizeBytes: size,
  sizeMb: Number((size / 1024 / 1024).toFixed(2)),
  sha256,
  builtAt: mtime.toISOString(),
  package: 'in.avinya.pathpulse',
};
writeFileSync(outManifest, JSON.stringify(manifest, null, 2) + '\n');

console.log(`\n  published  apps/web/public/downloads/PathPulse.apk`);
console.log(`  size       ${manifest.sizeMb} MB`);
console.log(`  sha256     ${sha256.slice(0, 24)}…`);
console.log(`  built      ${manifest.builtAt}`);
console.log(`\n  Now run  pnpm build  so the site picks it up.\n`);
