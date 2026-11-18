import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function openTestBrowser({ hedge = false } = {}) {
  const locations = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  let executable;
  for (const name of locations) {
    try {
      await access(name);
      executable = name;
      break;
    } catch {}
  }
  if (!executable) throw Error('请设置 CHROME_BIN 指向本机 Chrome 或 Chromium。');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vs-hype-browser-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const server = spawn(process.execPath, ['scripts/serve.js', ...(hedge ? ['--hedge'] : [])], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const [ready] = await once(server.stdout, 'data');
  const url = ready.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  const chrome = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      '--user-data-dir=' + dir,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  const close = async () => {
    for (const child of [chrome, server])
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await Promise.race([exited, delay(2500)]);
      }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    let port;
    for (let i = 0; i < 150 && !port; i++) {
      try {
        port = (await readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      } catch {
        await delay(80);
      }
    }
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
    const ws = new WebSocket(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const pending = new Map(),
      faults = [];
    let seq = 0;
    function send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(Error(msg.error.message));
        else p.resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown')
        faults.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Page.javascriptDialogOpening')
        void send('Page.handleJavaScriptDialog', { accept: true });
      if (msg.method === 'Fetch.requestPaused')
        void send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'TimedOut' });
    };
    async function run(expression) {
      const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails)
        throw Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
      return value.result.value;
    }
    async function wait(expression, timeout = 10000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await run(expression)) return;
        await delay(80);
      }
      const status = await run(
        "['notice','verdict','feed-health','vs-paste-error'].map(k=>document.getElementById(k)?.textContent).filter(Boolean).join(' | ')"
      );
      throw Error('等待页面条件超时 ' + expression + ' ' + status + ' ' + faults.join(' / '));
    }
    for (const method of ['Page.enable', 'Runtime.enable']) await send(method);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1390,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false
    });
    await send('Page.navigate', { url });
    if (hedge) {
      await wait("document.querySelector('#calc-status')?.textContent.length > 0", 15000);
    } else {
      await wait(
        "document.querySelector('#feed-values') && document.querySelector('#feed-switch')?.value==='live'",
        15000
      );
      await run(
        "document.querySelector('#feed-switch').value='offline';document.querySelector('#feed-switch').dispatchEvent(new Event('change'))"
      );
      await wait("document.querySelector('#verdict')?.innerText.includes('匹配可交易')", 15000);
    }
    const selector = (s) => 'document.querySelector(' + JSON.stringify(s) + ')';
    return {
      url,
      run,
      send,
      wait,
      faults,
      close: async () => {
        ws.close();
        await close();
      },
      click: (s) => run(selector(s) + '.click()'),
      text: (s) => run(selector(s) + '.textContent'),
      set: (s, value, event = 'change') =>
        run(
          '(()=>{const e=' +
            selector(s) +
            ';e.value=' +
            JSON.stringify(String(value)) +
            ';e.dispatchEvent(new Event(' +
            JSON.stringify(event) +
            ',{bubbles:true}));})()'
        )
    };
  } catch (e) {
    await close();
    throw e;
  }
}
