// Local-only test model: forwards OpenAI-compatible requests to Anthropic's
// OpenAI-compatible endpoint with a key read from a local env file, so a dev build
// can talk to a real model without anyone pasting a key into the page.
// Never deploy or expose this; it listens on 127.0.0.1 only.
//
//   node scripts/dev/test-model-proxy.mjs   # ANTHROPIC_API_KEY from ../Private/credentials/.env
//   DG_TEST_MODEL_ENV_FILE=/other/.env node scripts/dev/test-model-proxy.mjs
//
// The local router (scripts/dev/local-router.mjs) serves it at /dev-llm/v1.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(
  process.env.DG_TEST_MODEL_ENV_FILE ??
    resolve(import.meta.dirname, '../../../Private/credentials/.env'),
);
const key =
  readFileSync(envFile, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('ANTHROPIC_API_KEY='))
    ?.slice('ANTHROPIC_API_KEY='.length)
    .trim() ?? '';
if (!key) throw new Error(`ANTHROPIC_API_KEY missing from ${envFile}`);
const port = Number(process.env.DG_TEST_MODEL_PORT ?? 8791);

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').replace(/^\/dev-llm/, '');
  if (!path.startsWith('/v1/')) {
    res.writeHead(404).end('only /v1/* is proxied');
    return;
  }
  const headers = { ...req.headers };
  for (const name of ['host', 'authorization', 'x-api-key', 'origin', 'referer', 'cookie'])
    delete headers[name];
  const upstream = https.request(
    {
      host: 'api.anthropic.com',
      path,
      method: req.method,
      headers: {
        ...headers,
        host: 'api.anthropic.com',
        authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    },
    (upstreamRes) => {
      const out = { ...upstreamRes.headers, 'access-control-allow-origin': '*' };
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    res.writeHead(502).end(`upstream: ${error.message}`);
  });
  req.pipe(upstream);
});
server.listen(port, '127.0.0.1', () => console.log(`test model proxy ready on ${port}`));
