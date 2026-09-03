#!/usr/bin/env node
/**
 * Remove the downloadable APK from the APK's own assets.
 *
 * ★ THE APK WAS EATING ITSELF ★
 *
 * `pnpm publish:apk` copies the built APK into `apps/web/public/downloads/`,
 * so the web build can offer it for download. `next build` copies `public/`
 * into `out/`. `cap sync` copies `out/` into the Android assets. So the NEXT
 * APK contains the previous one — and the one after that contains both.
 *
 * Measured: 12.8 MB became 25.1 MB in a single cycle, and would have kept
 * doubling. The symptom is a size, not an error, which is why it survived
 * several builds unnoticed.
 *
 * An installed app has no use for a copy of its own installer, so it is
 * dropped after sync. The web deployment keeps its copy, which is the one that
 * matters — that is where people download it from.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ASSETS = join(ROOT, 'apps/web/android/app/src/main/assets/public/downloads');

if (!existsSync(ASSETS)) {
  console.log('  no downloads/ in the Android assets — nothing to strip');
  process.exit(0);
}

let freed = 0;
for (const entry of readdirSync(ASSETS)) {
  if (!entry.endsWith('.apk')) continue;
  const full = join(ASSETS, entry);
  freed += statSync(full).size;
  rmSync(full);
  console.log(`  stripped ${entry} from the Android assets`);
}

if (freed > 0) {
  console.log(`  APK is ${(freed / 1024 / 1024).toFixed(1)} MB smaller for it`);
} else {
  console.log('  no APK inside the APK');
}
