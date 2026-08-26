#!/usr/bin/env node
/** Prints the built APK's path and size — so the build ends with something usable. */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const apk = join(ROOT, 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk');

if (!existsSync(apk)) {
  console.error('\n✖ APK not found at', apk);
  process.exit(1);
}
const mb = (statSync(apk).size / 1024 / 1024).toFixed(1);
console.log(`\n✔ APK built — ${mb} MB\n  ${apk}\n\nInstall on a connected phone:\n  adb install -r "${apk}"\n`);
