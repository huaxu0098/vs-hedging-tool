import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildTradeExtension } from './build-trade-extension.js';

const port = '4178',
  base = 'http://127.0.0.1:' + port,
  url = base + '/trade.html';
const extension = await buildTradeExtension();
let response;
try {
  response = await fetch(url, { signal: AbortSignal.timeout(1000) });
} catch {}
if (response) {
  if (!response.ok || !(await response.text()).includes('id="trade-controls"'))
    throw Error('4178 端口正在运行其他服务或旧版匹配器，请先关闭该服务再启动开仓工具。');
} else {
  const server = spawn(process.execPath, ['scripts/serve.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: port },
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const ready = await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => {
      throw Error('本机服务未能启动');
    })
  ]);
  if (!String(ready[0]).includes(base)) throw Error('本机服务地址与交易扩展不一致。');
  server.stdout.destroy();
  server.unref();
}
console.log('本机开仓页 ' + url + '\nChrome 加载已解压扩展目录 ' + extension);
if (process.platform === 'darwin')
  execFile('/usr/bin/open', ['-a', 'Google Chrome', url], (error) => {
    if (error) console.error(error.message);
  });
