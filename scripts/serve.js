import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeBridge } from './bridge.js';
import { readVestContract } from './vest-contract.js';
import { createUsdRatesReader } from './usd-rates.js';

const root = new URL('../', import.meta.url);
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4178);
const types = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  csv: 'text/csv',
  json: 'application/json'
};
const bridge = makeBridge();
const readUsdRates = createUsdRatesReader();

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
server.listen(port, host, () => {
  const url = 'http://' + host + ':' + server.address().port;
  console.log('本地匹配器 ' + url);
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    execFile('/usr/bin/open', [url], (error) => {
      if (error) console.error('请在浏览器打开上面的本地地址。');
    });
  }
});
