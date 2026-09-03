#!/usr/bin/env node
/**
 * Resolve the Android build toolchain WITHOUT Android Studio.
 *
 * ★ WHY THIS FILE EXISTS ★
 * A Capacitor APK needs exactly two things: a JDK 17 and an Android SDK with a
 * matching platform and build-tools. Android Studio bundles both, which is why
 * every tutorial tells you to install a 1.5 GB IDE to run a command-line
 * Gradle task. It also hides them: `./gradlew assembleDebug` in a plain shell
 * fails with "Unable to locate a Java Runtime" because the JDK lives inside
 * the app bundle and only the IDE's own terminal exports it.
 *
 * So this resolves the toolchain itself, from a Homebrew JDK, a system JDK, or
 * a Studio install if one happens to be there — and fails with an instruction
 * you can act on rather than a stack trace. The APK build then works on a
 * laptop that has never had Android Studio on it, which is also what makes it
 * runnable in CI.
 *
 * Exported for `scripts/android-build.mjs`; run directly to print what it found:
 *
 *   node scripts/android-toolchain.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const ANDROID_DIR = join(ROOT, 'apps/web/android');

/** Gradle 8.2 + AGP 8.x want a JDK in this range. 21 works; 24 does not. */
const MIN_JDK = 17;
const MAX_JDK = 21;

const quiet = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** Major version of a JDK at `home`, or null if it is not a usable JDK. */
function jdkMajor(home) {
  if (!home || !existsSync(join(home, 'bin', 'javac'))) return null;
  const out = quiet(() =>
    execFileSync(join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  // `java -version` writes to stderr on some builds; execFileSync gives us
  // stdout only, so fall back to the release file when it comes back empty.
  const text =
    out ||
    (existsSync(join(home, 'release')) ? readFileSync(join(home, 'release'), 'utf8') : '');
  const m = text.match(/(?:version\s+"|JAVA_VERSION=")(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Every JDK worth trying, best candidate first. */
function jdkCandidates() {
  const out = [];
  if (process.env.JAVA_HOME) out.push(process.env.JAVA_HOME);

  // Homebrew, both architectures. `brew install openjdk@17` does not link into
  // /Library/Java, so /usr/libexec/java_home never sees it — look directly.
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (let v = MAX_JDK; v >= MIN_JDK; v--) {
      out.push(join(prefix, `openjdk@${v}`), join(prefix, `openjdk@${v}`, 'libexec/openjdk.jdk/Contents/Home'));
    }
  }

  // System JDKs, newest first.
  const sysDir = '/Library/Java/JavaVirtualMachines';
  if (existsSync(sysDir)) {
    for (const d of readdirSync(sysDir).sort().reverse()) {
      out.push(join(sysDir, d, 'Contents/Home'));
    }
  }

  // Studio's bundled runtime, if the IDE happens to be installed. Last, on
  // purpose: this script's whole point is not to need it.
  out.push(
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    join(homedir(), 'Applications/Android Studio.app/Contents/jbr/Contents/Home'),
  );

  // Linux / CI.
  if (existsSync('/usr/lib/jvm')) {
    for (const d of readdirSync('/usr/lib/jvm').sort().reverse()) out.push(join('/usr/lib/jvm', d));
  }
  return out;
}

export function findJdk() {
  for (const home of jdkCandidates()) {
    const major = jdkMajor(home);
    if (major !== null && major >= MIN_JDK && major <= MAX_JDK) return { home, major };
  }
  return null;
}

export function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library/Android/sdk'),
    join(homedir(), 'Android/Sdk'),
    '/usr/local/lib/android/sdk', // GitHub Actions runners
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(join(dir, 'platforms'))) return dir;
  }
  return null;
}

/** compileSdkVersion / build-tools the project asks for, read from variables.gradle. */
export function requiredSdk() {
  const text = readFileSync(join(ANDROID_DIR, 'variables.gradle'), 'utf8');
  const compile = text.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1];
  return { platform: compile ? `android-${compile}` : null };
}

/**
 * Point Gradle at the SDK.
 *
 * `local.properties` is generated, machine-specific and git-ignored — writing
 * it here is what lets a fresh clone build without anyone opening an IDE to
 * have it written for them.
 */
export function writeLocalProperties(sdkDir) {
  const path = join(ANDROID_DIR, 'local.properties');
  const line = `sdk.dir=${sdkDir}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === line) return false;
  writeFileSync(path, line);
  return true;
}

/** Everything Gradle needs, or a thrown error naming the one thing that is missing. */
export function resolveToolchain() {
  const jdk = findJdk();
  if (!jdk) {
    throw new Error(
      `no JDK ${MIN_JDK}-${MAX_JDK} found.\n\n` +
        '  Install one — no Android Studio required:\n' +
        '    brew install openjdk@17\n\n' +
        '  Already have a JDK? Point JAVA_HOME at it and re-run.\n' +
        '  (Gradle 8.2 rejects JDK 22+, so a very new JDK counts as missing here.)',
    );
  }

  const sdk = findAndroidSdk();
  if (!sdk) {
    throw new Error(
      'no Android SDK found.\n\n' +
        '  Install the command-line tools only — no Android Studio required:\n' +
        '    brew install --cask android-commandlinetools\n' +
        '    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"\n' +
        '    sdkmanager --licenses\n\n' +
        '  Then export ANDROID_HOME to the SDK directory and re-run.',
    );
  }

  const { platform } = requiredSdk();
  if (platform && !existsSync(join(sdk, 'platforms', platform))) {
    throw new Error(
      `Android SDK at ${sdk} has no ${platform}, which app/build.gradle needs.\n\n` +
        `  sdkmanager "platforms;${platform}"`,
    );
  }

  return { jdk, sdk, platform };
}

// Run directly: report what is on this machine and stop.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { jdk, sdk, platform } = resolveToolchain();
    writeLocalProperties(sdk);
    console.log(`\n  JDK ${jdk.major}   ${jdk.home}`);
    console.log(`  SDK ${platform}   ${sdk}`);
    console.log('\n  Toolchain is complete — `pnpm build:android` will work.\n');
  } catch (err) {
    console.error(`\n  ✖ ${err.message}\n`);
    process.exitCode = 1;
  }
}
