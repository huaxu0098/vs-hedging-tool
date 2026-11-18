(() => {
  if (self !== top) return;
  let prepared;
  const venue = location.origin === 'https://next.vestmarkets.com' ? 'vs' : 'hype';
  function check(m) {
    if (Date.now() >= m.expires) throw Error('本次报价已过期。');
    if (
      m.leg?.venue !== venue ||
      decodeURIComponent(location.pathname).replace(/\/$/, '') !== '/trade/' + m.leg.symbol
    )
      throw Error('当前标签页的品种已改变。');
    if (!globalThis.tradeVenue) throw Error('当前网页的委托表单适配未就绪。');
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !['prepare', 'verify', 'submit'].includes(m.type)) return;
    (async () => {
      check(m);
      if (m.type === 'prepare') {
        prepared = null;
        const fingerprint = await globalThis.tradeVenue.prepare(m.leg);
        check(m);
        if (!fingerprint || fingerprint !== globalThis.tradeVenue.verify(m.leg))
          throw Error('表单或账户在准备期间发生变化。');
        prepared = { id: m.id, fingerprint, leg: JSON.stringify(m.leg) };
      } else {
        const p = prepared;
        if (
          !p ||
          p.id !== m.id ||
          p.leg !== JSON.stringify(m.leg) ||
          p.fingerprint !== globalThis.tradeVenue.verify(m.leg)
        )
          throw Error('两次核对之间表单、品种或账户发生变化。');
        if (m.type === 'submit') {
          prepared = null;
          globalThis.tradeVenue.submit(m.leg);
        }
      }
      return { ok: true };
    })().then(reply, (error) => reply({ ok: false, reason: error.message }));
    return true;
  });
})();
