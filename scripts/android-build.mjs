#!/usr/bin/env node
/**
 * Run a Gradle task in apps/web/android with a resolved JDK and SDK.
 *
 *   node scripts/android-build.mjs                 # assembleDebug
 *   node scripts/android-build.mjs assembleRelease
 *   node scripts/android-build.mjs clean assembleDebug --stacktrace
 *
 * The point is that this needs no Android Studio and no shell profile: the
 * toolchain is resolved per-invocation and exported into Gradle's environment
 * only. See scripts/android-toolchain.mjs for why that is not the default.
 */
import { spawnSync } from 'node:child_process';
import { ANDROID_DIR, resolveToolchain, writeLocalProperties } from './android-toolchain.mjs';

let toolchain;
try {
  toolchain = resolveToolchain();
} catch (err) {
  console.error(`\n  ✖ ${err.message}\n`);
  process.exit(1);
}

const { jdk, sdk } = toolchain;
writeLocalProperties(sdk);

const tasks = process.argv.slice(2);
if (tasks.length === 0) tasks.push('assembleDebug');

console.log(`\n  gradle ${tasks.join(' ')}   (JDK ${jdk.major}, SDK ${sdk})\n`);

const result = spawnSync('./gradlew', tasks, {
  cwd: ANDROID_DIR,
  stdio: 'inherit',
  env: {
    ...process.env,
    JAVA_HOME: jdk.home,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    // Gradle 8 warns on ANDROID_SDK_ROOT alone; both are set so neither the
    // wrapper nor AGP has to guess, and the warning stays out of the log.
  },
});

process.exit(result.status ?? 1);
