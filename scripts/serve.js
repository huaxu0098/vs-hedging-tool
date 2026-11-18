import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4178);
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' };

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^(?:index\.html|styles\.css|editor\.css|src\/[a-z-]+\.js)$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(new URL(file, root));
    response.writeHead(200, {
      'Content-Type': types[file.split('.').at(-1)] + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});
server.on('error', error => {
  console.error('本地服务启动失败', error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const url = 'http://' + host + ':' + server.address().port;
  console.log('本地匹配器 ' + url);
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    execFile('/usr/bin/open', [url], error => {
      if (error) console.error('请在浏览器打开上面的本地地址。');
    });
  }
});
