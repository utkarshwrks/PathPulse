#!/usr/bin/env node
/**
 * A static file server with a real /health endpoint.
 *
 * ★ ONLY NEEDED IF YOU DEPLOY AS A WEB SERVICE ★
 * PathPulse is a static export, so the right home for it is a static host,
 * which does not sleep and does not need this file. Some hosts only offer web
 * services, and a free web service suspends after ~15 minutes idle. This
 * serves `apps/web/out` and answers `/health` so an external pinger
 * (UptimeRobot, cron-job.org, a GitHub Actions cron) can hold it awake.
 *
 * No dependencies on purpose: adding Express to serve a folder of files would
 * be the largest thing in the deployment.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('apps/web/out');
const PORT = Number(process.env.PORT ?? 3000);
const STARTED = Date.now();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream',
  '.jsonl': 'application/x-ndjson',
  '.apk': 'application/vnd.android.package-archive',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // Without this a CDN answers the pinger and the origin still sleeps.
      'cache-control': 'no-store, max-age=0',
    });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'pathpulse-web',
        uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
        now: new Date().toISOString(),
      }),
    );
    return;
  }

  // Normalise before joining, or `..` escapes the published folder.
  const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, safe);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file)) file = join(ROOT, '404.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const headers = { 'content-type': type };
  // An APK served inline is opened by the browser instead of the installer.
  if (file.endsWith('.apk')) {
    headers['content-disposition'] = 'attachment; filename="PathPulse.apk"';
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`pathpulse serving ${ROOT} on :${PORT}  (health at /health)`);
});
