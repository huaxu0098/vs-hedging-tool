import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeBridge } from '../scripts/bridge.js';
test('本机桥限制来源、品种和授权字段，旋转配对及撤销立即生效', async () => {
  const route = makeBridge();
  const s = createServer((req, res) => route(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + s.address().port,
    origin = 'https://trade.example.test';
  const post = (path, body, source = base, token = '') =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        origin: source,
        'Content-Type': 'application/json',
        ...(token && { Authorization: 'Bearer ' + token })
      },
      body: JSON.stringify(body)
    });
  try {
    assert.equal((await post('/api/bridge/pair', { origin, assetId: 'btc' }, origin)).status, 403);
    const pairing = await (await post('/api/bridge/pair', { origin, assetId: 'btc' })).json();
    const data = {
      assetId: 'btc',
      snapshot: {
        symbol: 'BTC',
        bid: 50,
        ask: 51,
        mark: 50.5,
        open: true,
        asOf: new Date().toISOString(),
        timeSource: 'capture',
        account: {}
      }
    };
    assert.equal(
      (await post('/api/vs-snapshot', data, 'https://elsewhere.example', pairing.token)).status,
      403
    );
    assert.equal((await post('/api/vs-snapshot', data, origin, 'invalid')).status, 403);
    assert.equal(
      (
        await post(
          '/api/vs-snapshot',
          { ...data, snapshot: { ...data.snapshot, raw: 'whole page' } },
          origin,
          pairing.token
        )
      ).status,
      400
    );
    assert.equal((await post('/api/vs-snapshot', data, origin, pairing.token)).status, 202);
    assert.equal((await (await fetch(base + '/api/bridge/latest')).json()).snapshot.bid, 50);
    assert.equal(
      (await post('/api/hype-info', { network: 'mainnet', request: { type: 'unknown' } })).status,
      400
    );
    await post('/api/bridge/revoke', {});
    assert.equal((await post('/api/vs-snapshot', data, origin, pairing.token)).status, 403);
    assert.equal(await (await fetch(base + '/api/bridge/latest')).json(), null);
  } finally {
    await new Promise((r) => s.close(r));
  }
});
