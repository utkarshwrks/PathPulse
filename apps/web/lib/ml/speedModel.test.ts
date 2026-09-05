/**
 * Adversarial tests for the model loader.
 *
 * The one rule: a failed load must never take the app down, and must never
 * leave the UI claiming a model is running when it is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ML_MODEL_CHANNELS, ML_WINDOW_SAMPLES } from '@pathpulse/nav-core';
import { WebSpeedPredictor } from './speedModel';

const REAL = readFileSync(
  join(process.cwd(), 'public/models/speed_model.json'),
  'utf8',
);
/** Parsed once, so tampered fixtures can be sized from the real thing. */
const real = JSON.parse(REAL) as {
  layers: Array<Record<string, number | string>>;
};

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe('WebSpeedPredictor', () => {
  it('loads the real shipped model', async () => {
    mockFetch(() => new Response(REAL, { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(true);
    expect(p.isReady()).toBe(true);
    expect(p.info.loaded).toBe(true);
    expect(p.info.error).toBeNull();
    expect(p.scaler?.mean).toHaveLength(ML_MODEL_CHANNELS);
  });

  it('predicts a finite speed once loaded', async () => {
    mockFetch(() => new Response(REAL, { status: 200 }));
    const p = new WebSpeedPredictor();
    await p.load();
    const v = p.predict(new Float32Array(ML_MODEL_CHANNELS * ML_WINDOW_SAMPLES));
    expect(Number.isFinite(v)).toBe(true);
    expect(p.info.inferences).toBe(1);
    expect(p.info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a 404 instead of throwing', async () => {
    mockFetch(() => new Response('nope', { status: 404 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.isReady()).toBe(false);
    expect(p.info.error).toMatch(/404/);
  });

  it('survives a network failure', async () => {
    mockFetch(() => Promise.reject(new Error('offline')));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toMatch(/offline/);
  });

  it('survives an SPA fallback serving HTML with a 200', async () => {
    // The classic static-host failure: a missing file returns index.html.
    mockFetch(() => new Response('<!doctype html><html></html>', { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.isReady()).toBe(false);
    expect(p.info.error).toBeTruthy();
  });

  it('refuses a truncated model file', async () => {
    mockFetch(() => new Response(REAL.slice(0, REAL.length / 2), { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toBeTruthy();
  });

  it('refuses a model whose window disagrees with the engine', async () => {
    const tampered = JSON.parse(REAL);
    tampered.windowSamples = 100;
    mockFetch(() => new Response(JSON.stringify(tampered), { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toMatch(/window/i);
  });

  it('refuses a weight block that is not a whole number of float32', async () => {
    const tampered = JSON.parse(REAL);
    tampered.layers[0].weight = 'AAAA'; // 4 base64 chars -> 3 bytes
    mockFetch(() => new Response(JSON.stringify(tampered), { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toMatch(/float32|bytes/i);
  });

  it('refuses a weight block that decodes cleanly but is the wrong length', async () => {
    // The nastier case: 8 valid floats where a full conv kernel is required. It decodes
    // without complaint, so only the shape check catches it — and without that
    // check the convolution reads past the end and answers NaN forever.
    const tampered = JSON.parse(REAL);
    tampered.layers[0].weight = Buffer.from(new Float32Array(8).buffer).toString('base64');
    mockFetch(() => new Response(JSON.stringify(tampered), { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toMatch(/expected \d+ floats, got 8/i);
  });

  it('refuses weights poisoned with NaN', async () => {
    const tampered = JSON.parse(REAL);
    // Sized from the model's own first layer, so it stays a NaN test rather
    // than silently becoming a length test the next time the shape changes.
    const first = real.layers[0] as unknown as {
      outChannels: number;
      inChannels: number;
      kernel: number;
    };
    const poisoned = new Float32Array(first.outChannels * first.inChannels * first.kernel);
    poisoned[17] = Number.NaN;
    tampered.layers[0].weight = Buffer.from(poisoned.buffer).toString('base64');
    mockFetch(() => new Response(JSON.stringify(tampered), { status: 200 }));
    const p = new WebSpeedPredictor();
    expect(await p.load()).toBe(false);
    expect(p.info.error).toMatch(/non-finite/i);
  });

  it('returns NaN rather than throwing when asked to predict unloaded', () => {
    const p = new WebSpeedPredictor();
    expect(Number.isNaN(p.predict(new Float32Array(ML_MODEL_CHANNELS * ML_WINDOW_SAMPLES)))).toBe(true);
  });

  it('a failed load leaves no stale model behind after a good one', async () => {
    mockFetch(() => new Response(REAL, { status: 200 }));
    const p = new WebSpeedPredictor();
    await p.load();
    expect(p.isReady()).toBe(true);
    mockFetch(() => new Response('broken', { status: 200 }));
    expect(await p.load()).toBe(false);
    // Critically: it must not still be answering from the old weights while
    // reporting an error — that is the worst of both worlds.
    expect(p.isReady()).toBe(false);
    expect(Number.isNaN(p.predict(new Float32Array(ML_MODEL_CHANNELS * ML_WINDOW_SAMPLES)))).toBe(true);
  });

  it('dispose stops it answering', async () => {
    mockFetch(() => new Response(REAL, { status: 200 }));
    const p = new WebSpeedPredictor();
    await p.load();
    p.dispose();
    expect(p.isReady()).toBe(false);
  });
});
