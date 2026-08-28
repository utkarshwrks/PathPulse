import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The CLI, run for real as a subprocess.
 *
 * Everything else in this package tests the functions the CLI calls. This tests
 * the CLI: that it parses its own flags, resolves its own paths, exits non-zero
 * when it should, and emits JSON that actually parses. Those are exactly the
 * parts that break when someone renames a flag, and exactly the parts no unit
 * test touches.
 */

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temps: string[] = [];

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('npx', ['tsx', 'src/cli.ts', ...args], {
      cwd: PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const LOG = 'sim_city_4242.jsonl';
const haveLog = existsSync(join(PKG, '..', '..', 'data', 'replay', LOG));

describe.skipIf(!haveLog)('eval CLI', () => {
  it('prints usage with no arguments and exits non-zero', () => {
    // A silent zero-exit on missing arguments would let a broken CI step pass.
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/--log/);
  });

  it('prints help on --help and exits zero', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--outage-duration/);
  });

  it('lists the available logs', () => {
    const r = run(['--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(LOG);
  });

  it('evaluates a log and reports every headline metric', () => {
    const r = run(['--log', LOG, '--config', 'full']);
    expect(r.status).toBe(0);
    for (const label of [
      'distance travelled',
      'final error',
      'DRIFT',
      'RMSE',
      'along-track RMSE',
      'cross-track RMSE',
      'CEP95',
      'recovery time',
      'road snap applied',
    ]) {
      expect(r.stdout, label).toContain(label);
    }
  });

  it('emits parseable JSON with --json and nothing else', () => {
    const r = run(['--log', LOG, '--config', 'full', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.configName).toBe('full');
    expect(parsed.log).toBe(LOG);
    expect(typeof parsed.driftPercent).toBe('number');
    expect(parsed.discardedSamples).toBe(0);
  });

  it('honours a custom outage window', () => {
    const a = JSON.parse(
      run(['--log', LOG, '--config', 'full', '--json', '--outage-duration', '20000']).stdout,
    ) as { outageDurationS: number };
    expect(a.outageDurationS).toBe(20);
  });

  it('reports a longer outage as worse than a shorter one', () => {
    const short = JSON.parse(
      run(['--log', LOG, '--config', 'full', '--json', '--outage-duration', '20000']).stdout,
    ) as { finalErrorM: number };
    const long = JSON.parse(
      run(['--log', LOG, '--config', 'full', '--json', '--outage-duration', '80000']).stdout,
    ) as { finalErrorM: number };
    expect(long.finalErrorM).toBeGreaterThan(short.finalErrorM);
  });

  it('shows naive integration as far worse than the full configuration', () => {
    // The single claim the whole project rests on, asserted through the CLI a
    // judge would actually be shown.
    const naive = JSON.parse(run(['--log', LOG, '--config', 'naive', '--json']).stdout) as {
      driftPercent: number;
    };
    const full = JSON.parse(run(['--log', LOG, '--config', 'full', '--json']).stdout) as {
      driftPercent: number;
    };
    expect(full.driftPercent).toBeLessThan(naive.driftPercent * 0.5);
  });

  it('reports whether the road graph engaged, rather than leaving it implicit', () => {
    expect(run(['--log', LOG, '--config', 'full']).stdout).toMatch(/road graph: city/);
    expect(run(['--log', LOG, '--config', 'naive']).stdout).toMatch(/road graph: disabled/);
    expect(run(['--log', LOG, '--config', 'full', '--no-road-graph']).stdout).toMatch(
      /road graph: disabled/,
    );
  });

  it('fails loudly on an unknown config', () => {
    const r = run(['--log', LOG, '--config', 'nope']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no config named/);
  });

  it('fails loudly on an unknown log', () => {
    const r = run(['--log', 'nope.jsonl', '--config', 'full']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no log named/);
  });

  it('refuses a log with no GNSS, because there would be no ground truth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathpulse-eval-'));
    temps.push(dir);
    const file = join(dir, 'nognss.jsonl');
    writeFileSync(
      file,
      [0, 20, 40]
        .map((t) => JSON.stringify({ t, imu: { ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 } }))
        .join('\n'),
    );
    const r = run(['--log', file, '--config', 'full']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no GNSS|ground truth/i);
  });

  it('refuses an empty log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathpulse-eval-'));
    temps.push(dir);
    const file = join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    const r = run(['--log', file, '--config', 'full']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no usable samples/);
  });

  it('gives byte-identical output for the same invocation', () => {
    // Determinism, through the actual entry point rather than the library.
    const a = run(['--log', LOG, '--config', 'full', '--json']).stdout;
    const b = run(['--log', LOG, '--config', 'full', '--json']).stdout;
    expect(a).toBe(b);
  });
}, 180_000);
