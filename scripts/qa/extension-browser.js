// An isolated Chrome DevTools pipe allows unpacked extension loading without
// attaching to an existing browser or opening a debugging network port.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function chooseChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw Error('需要 Chrome 或 Chromium，可通过 CHROME_BIN 指定可执行文件。');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(1400)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function protocol(child) {
  let sequence = 0,
    buffer = '';
  const pending = new Map(),
    listeners = new Set();
  function send(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('DevTools 命令超时 ' + method));
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.id !== undefined) {
        const call = pending.get(event.id);
        if (!call) continue;
        clearTimeout(call.timer);
        pending.delete(event.id);
        if (event.error) call.reject(Error(event.error.message));
        else call.resolve(event.result);
      } else for (const listener of listeners) listener(event);
    }
  });
  child.once('exit', () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(Error('测试 Chrome 已退出'));
    }
    pending.clear();
  });
  return {
    send,
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

export async function extensionBrowser({ buildExtension } = {}) {
  const executable = await chooseChrome();
  const dir = await mkdtemp(path.join(tmpdir(), 'vs-vest-collect-'));
  let chrome, server;
  const close = async () => {
    await stopChild(chrome);
    await stopChild(server);
    await rm(dir, { recursive: true, force: true, maxRetries: 4 });
  };
  try {
    server = spawn(process.execPath, ['scripts/serve.js'], {
      cwd: root,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    const [ready] = await once(server.stdout, 'data');
    const url = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!url) throw Error('隔离的本地服务未返回回环地址');
    const extDir = path.join(dir, 'extension');
    if (buildExtension) await buildExtension(extDir, new URL(url).port);
    else {
      await cp(path.join(root, 'extension'), extDir, { recursive: true });
      const cfg = path.join(extDir, 'config.js'),
        original = await readFile(cfg, 'utf8');
      const patched = original.replace(
        /(deskPort\s*:\s*['"])4178(['"])/,
        (_, begin, end) => begin + new URL(url).port + end
      );
      if (patched === original) throw Error('测试扩展未能精确绑定临时服务端口');
      await writeFile(cfg, patched);
    }
    const profile = path.join(dir, 'profile');
    await mkdir(profile);
    chrome = spawn(
      executable,
      [
        '--headless=new',
        '--window-size=1440,1200',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--no-proxy-server',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        '--user-data-dir=' + profile,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    const cdp = protocol(chrome);
    const version = await cdp.send('Browser.getVersion');
    const faults = [];
    const tab = async (handler) => {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const send = (method, params) => cdp.send(method, params, sessionId);
      const off = cdp.listen((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Fetch.requestPaused') {
          const { requestId, request } = msg.params;
          Promise.resolve()
            .then(() => handler?.(request))
            .then((reply) => {
              if (!reply) return send('Fetch.continueRequest', { requestId });
              return send('Fetch.fulfillRequest', {
                requestId,
                responseCode: reply.code ?? 200,
                responseHeaders: [
                  { name: 'Content-Type', value: reply.contentType ?? 'text/html; charset=utf-8' },
                  { name: 'Cache-Control', value: 'no-store' }
                ],
                body: Buffer.from(reply.body).toString('base64')
              });
            })
            .catch((error) => {
              if (!error.message.includes('session')) faults.push(error.message);
            });
        }
        if (msg.method === 'Runtime.exceptionThrown')
          faults.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      });
      await send('Runtime.enable');
      await send('Page.enable');
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      async function run(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails)
          throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      }
      async function wait(expression, timeout = 10000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          if (await run(expression)) return;
          await delay(65);
        }
        const status = await run(
          "['trade-feedback','trade-why','feed-auto-status','feed-health','feed-values','notice'].map(k=>document.getElementById(k)?.textContent).filter(Boolean).join(' | ')"
        );
        throw Error('等待超时 ' + expression + '\n' + status.slice(0, 1300));
      }
      async function click(selector) {
        await send('Page.bringToFront');
        const point =
          await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('控件不存在');
          el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw Error('控件不可见');
          return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point
        });
      }
      return {
        targetId,
        run,
        wait,
        click,
        send,
        go: (dest) => send('Page.navigate', { url: dest }),
        text: (selector) => run('document.querySelector(' + JSON.stringify(selector) + ')?.textContent'),
        close: async () => {
          off();
          await cdp.send('Target.closeTarget', { targetId });
        }
      };
    };
    return {
      url,
      version: version.product,
      tab,
      faults,
      close,
      install: () => cdp.send('Extensions.loadUnpacked', { path: extDir })
    };
  } catch (error) {
    await close();
    throw error;
  }
}
