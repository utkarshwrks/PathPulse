#!/usr/bin/env node
/**
 * Removes macOS/iCloud conflict copies ("config 2.xml") before an Android build.
 *
 * This project lives under ~/Documents, which iCloud Drive syncs. Every time
 * `cap sync` rewrites a file, iCloud can race it and leave a duplicate with a
 * space in the name. Android's resource merger rejects spaces outright, so the
 * APK build fails with a message that says nothing about iCloud.
 *
 * The real fix is to move the project outside a synced folder. Until then this
 * runs first and keeps builds green.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = ['apps/web/android/app/src', 'apps/web/out', 'apps/web/public'];
const DUPLICATE = /\s\d+(\.[^.]+)?$/; // "config 2.xml", "index 2.html"

let removed = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
    } else if (DUPLICATE.test(entry)) {
      unlinkSync(full);
      console.log(`  removed ${relative(ROOT, full)}`);
      removed++;
    }
  }
}

for (const dir of SCAN) walk(join(ROOT, dir));

if (removed > 0) {
  console.log(
    `\n⚠ Removed ${removed} iCloud conflict cop${removed === 1 ? 'y' : 'ies'}.\n` +
      '  Consider moving this project outside ~/Documents to stop iCloud racing the build.\n',
  );
}
