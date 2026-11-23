import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeBridge } from './bridge.js';
import { readVestContract } from './vest-contract.js';
import { createUsdRatesReader } from './usd-rates.js';
import { createHypeSignerService } from './hype-signer.js';
import { createHypeBackendEngine } from './hedge-engine.js';

const root = new URL('../', import.meta.url);
const host = '127.0.0.1';
const internal = process.argv.includes('--internal-qa');
const hedge = internal || process.argv.includes('--hedge') || process.argv.includes('--paper');
const port = Number(process.env.PORT || (hedge ? 4181 : 4178));
const types = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  csv: 'text/csv',
  json: 'application/json'
};
const bridge = makeBridge();
const readUsdRates = createUsdRatesReader();
const hypeSigner = createHypeSignerService();
const hedgeEngine = createHypeBackendEngine(hypeSigner);

const server = createServer(async (request, response) => {
  const validHost = ['localhost', '127.0.0.1'].some(
    (name) => request.headers.host === name + ':' + server.address().port
  );
  if (!validHost) {
    response.writeHead(403).end();
    return;
  }
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (hedge && url.pathname === '/api/current-market' && request.method === 'GET') {
    try {
      const { currentMarket } = await import('./current-market.js');
      const data = await currentMarket(url.searchParams.get('asset'), { partial: url.searchParams.get('partial') === '1' });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } catch {
      response.writeHead(503).end();
    }
    return;
  }
  if (
    hedge &&
    (url.pathname === '/api/hedge/session' ||
      url.pathname === '/api/hedge/stream' ||
      url.pathname === '/api/hedge/stats')
  ) {
    const localOrigin = 'http://' + request.headers.host;
    if (
      (request.headers.origin && request.headers.origin !== localOrigin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.writeHead(403).end();
      return;
    }
    const jsonHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    try {
      if (url.pathname === '/api/hedge/stream' && request.method === 'GET') {
        const sid = url.searchParams.get('sessionId') || '';
        if (!hedgeEngine.attachStream(sid, request, response)) {
          response.writeHead(404, jsonHeaders).end(JSON.stringify({ error: '会话不存在或已过期' }));
        }
        return;
      }
      if (url.pathname === '/api/hedge/stats' && request.method === 'GET') {
        const sid = url.searchParams.get('sessionId') || '';
        const stats = hedgeEngine.getSessionStats(sid);
        response.writeHead(stats ? 200 : 404, jsonHeaders).end(JSON.stringify(stats ?? { error: '会话不存在' }));
        return;
      }
      if (url.pathname === '/api/hedge/session' && request.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65536) throw Error('会话配置过大');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('会话配置 JSON 无效');
        const out = hedgeEngine.upsertSession(body);
        response.writeHead(200, jsonHeaders).end(JSON.stringify(out));
        return;
      }
      response.writeHead(405, jsonHeaders).end(JSON.stringify({ error: '不支持的请求方法' }));
    } catch (error) {
      response.writeHead(400, jsonHeaders).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (
    hedge &&
    (url.pathname === '/api/hype-api/status' ||
      url.pathname === '/api/hype-api/config' ||
      url.pathname === '/api/hype-api/verify')
  ) {
    const localOrigin = 'http://' + request.headers.host;
    if (
      (request.headers.origin && request.headers.origin !== localOrigin) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.method !== 'GET' && request.headers.origin && request.headers.origin !== localOrigin)
    ) {
      response.writeHead(403).end();
      return;
    }
    const jsonHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    try {
      if (url.pathname === '/api/hype-api/status' && request.method === 'GET') {
        const status = await hypeSigner.getStatus();
        response.writeHead(200, jsonHeaders).end(JSON.stringify(status));
        return;
      }
      if (url.pathname === '/api/hype-api/verify' && request.method === 'POST') {
        const status = await hypeSigner.verifyAndRefresh();
        response.writeHead(200, jsonHeaders).end(JSON.stringify(status));
        return;
      }
      if (url.pathname === '/api/hype-api/config' && request.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) throw Error('配置请求过大');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('配置 JSON 无效');
        const status = await hypeSigner.verifyAndRefresh(body);
        response.writeHead(200, jsonHeaders).end(JSON.stringify(status));
        return;
      }
      response.writeHead(405, jsonHeaders).end(JSON.stringify({ error: '不支持的请求方法' }));
    } catch (error) {
      response.writeHead(400, jsonHeaders).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (hedge && !['/api/hype-info', '/api/usd-rates', '/api/bridge/pair', '/api/bridge/revoke', '/api/bridge/latest', '/api/vs-snapshot'].includes(url.pathname)) {
    const path = url.pathname;
    const files = {
      '/': internal ? 'fixtures/internal-hedge.html' : 'hedge.html',
      '/dev/replay': 'fixtures/hedge-replay.html',
      '/hedge.css': 'hedge.css',
      '/node_modules/decimal.js/decimal.mjs': 'node_modules/decimal.js/decimal.mjs',
      '/vendor/decimal.mjs': 'node_modules/decimal.js/decimal.mjs'
    };
    const file = Object.hasOwn(files, path)
      ? files[path]
      : /^\/(?:src\/hedge\/[a-z-]+\.js|src\/vs-parser\.js|fixtures\/hedge-[a-z-]+\.(?:json|csv)|config\/hedge-example\.json)$/.test(
            path
          )
        ? path.slice(1)
        : null;
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(new URL(file, root));
      response
        .writeHead(200, {
          'Content-Type':
            (file.endsWith('.mjs') ? 'text/javascript' : types[file.split('.').at(-1)]) + '; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        })
        .end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  if (url.pathname === '/api/usd-rates') {
    if (
      (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (url.search) {
      response.writeHead(400).end();
      return;
    }
    const result = await readUsdRates();
    response
      .writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      })
      .end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/api/vest-contract' && request.method === 'GET') {
    try {
      const contract = await readVestContract(url.searchParams.get('symbol'));
      response
        .writeHead(contract ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(contract));
    } catch {
      response
        .writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end('null');
    }
    return;
  }
  if (await bridge(request, response, url.pathname)) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const path = decodeURIComponent(url.pathname);
    const file = (path === '/' || path === '/trade.html') ? 'index.html' : path.slice(1);
    if (file === 'config/extension-location.json' || file === 'config/trade-extension-location.json') {
      const location = JSON.stringify({ path: fileURLToPath(new URL(file.includes('trade-extension') ? 'build/trade-extension' : 'extension', root)) });
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(request.method === 'HEAD' ? undefined : location);
      return;
    }
    if (
      !/^(?:index\.html|[a-z-]+\.css|src\/[a-z][a-z0-9-]*\.js|config\/example\.json|fixtures\/[\p{L}\d_-]+\.(?:csv|json))$/u.test(
        file
      )
    ) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(new URL(file, root));
    response
      .writeHead(200, {
        'Content-Type': types[file.split('.').at(-1)] + '; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      })
      .end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});
server.requestTimeout = 12000;
server.headersTimeout = 10000;
server.on('error', (error) => {
  console.error('本地服务启动失败', error.message);
  process.exitCode = 1;
});
server.listen(port, host, async () => {
  const url = 'http://' + host + ':' + server.address().port;
  console.log('本地匹配器 ' + url);
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    execFile('/usr/bin/open', [url], (error) => {
      if (error) console.error('请在浏览器打开上面的本地地址。');
    });
  }
});
