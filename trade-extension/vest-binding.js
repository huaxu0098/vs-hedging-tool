// Explicit, short-lived proof from Vest's own "copy current account ID" button.
// No Clipboard API, page-world hooks, account credentials or persistent storage.
(() => {
  if (self !== top || location.origin !== 'https://next.vestmarkets.com') return;
  const reader = globalThis.readVisibleVest;
  const resetReader = globalThis.resetVestAccountBinding;
  const triggerId = '[data-testid="account-selector-trigger"]';
  const lifetime = 60000;
  let armed, bound, hint, timer, selectorChanges;
  const visible = (el) =>
    !!el?.getClientRects().length && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const single = (el, query) => {
    const all = [...el.querySelectorAll(query)].filter(visible);
    return all.length === 1 ? all[0] : null;
  };
  function controls() {
    const trigger = single(document, triggerId);
    if (!trigger || trigger.disabled || trigger.getAttribute('aria-expanded') === 'true') return null;
    const button = single(
      trigger,
      'button[type="button"][aria-label="Copy"],button[type="button"][aria-label="复制"]'
    );
    const badge = single(trigger, ':scope > [data-slot="badge"]');
    if (!button || button.disabled || !badge) return null;
    const text = badge.innerText.trim();
    const passed = /^(Passed|Evaluation Passed|已通过|评估已通过)$/i.test(text);
    const evaluationFailed = /^(Evaluation Failed|Challenge Failed|考核(?:已)?失败|评估(?:已)?失败)$/i.test(
      text
    );
    const fundedFailed = /^(Funded Account Failed|出金号爆号)$/i.test(text);
    const failed =
      evaluationFailed ||
      fundedFailed ||
      /^(Failed|Account Failed|Blown Account|已失败|账户(?:已)?失败|(?:账户)?已爆号|账户爆号)$/i.test(text);
    const stage =
      passed || evaluationFailed || /^(Evaluation|评估|Step [12]\/2|第 [12]\/2 阶段)$/.test(text)
        ? 'challenge'
        : fundedFailed || /^(Live|Instant|实盘|即时)$/.test(text)
          ? 'funded'
          : null;
    if (!stage && !failed) return null;
    const status = passed ? 'passed' : failed ? 'failed' : null;
    return { trigger, button, badge, stage, status, text, caption: trigger.innerText.trim() };
  }
  function same(a, b) {
    return a && b && ['trigger', 'button', 'badge', 'stage', 'text', 'caption'].every((k) => a[k] === b[k]);
  }
  function cancel() {
    armed = null;
    bound = null;
    selectorChanges?.disconnect();
    clearTimeout(timer);
    hint?.remove();
    hint = null;
  }
  function inform(label) {
    if (!hint) {
      hint = document.createElement('div');
      hint.setAttribute('role', 'status');
      hint.style.cssText =
        'position:fixed;z-index:2147483646;bottom:16px;left:16px;max-width:min(440px,90vw);padding:12px 16px;background:#173b2d;color:white;border-radius:8px;font:14px/1.5 system-ui;pointer-events:none';
      document.body.append(hint);
    }
    hint.textContent = 'VS × Hype · ' + label;
  }
  function keep() {
    if (
      bound &&
      (Date.now() >= bound.until || bound.url !== location.href || !same(controls(), bound.controls))
    )
      cancel();
    return bound;
  }
  function copyParent(button) {
    let parent = button.parentElement;
    while (parent) {
      const interactive = parent.closest('button,a,[role="button"]');
      if (!interactive) return parent;
      parent = interactive.parentElement;
    }
    return document.body;
  }
  // Only while the initiating trusted click is on the stack, accept the
  // newly-created, focused native control that this one copy action selected.
  function capture(click, c) {
    const consent = armed,
      parent = copyParent(c.button);
    const inserted = new MutationObserver(() => {});
    const previous = new Set(parent.querySelectorAll('textarea'));
    inserted.observe(parent, { childList: true });
    function finish() {
      inserted.disconnect();
      document.removeEventListener('copy', onCopy, true);
    }
    function onCopy(event) {
      const added = inserted.takeRecords().flatMap((record) => [...record.addedNodes]);
      finish();
      const field = document.activeElement;
      if (
        !event.isTrusted ||
        !click.eventPhase ||
        consent !== armed ||
        Date.now() >= consent.until ||
        !same(controls(), c) ||
        !added.includes(field) ||
        previous.has(field) ||
        field.parentElement !== parent ||
        !(field instanceof HTMLTextAreaElement) ||
        !field.readOnly ||
        field.tabIndex !== -1 ||
        field.getAttribute('aria-hidden') !== 'true' ||
        field.style.position !== 'fixed' ||
        field.style.opacity !== '0' ||
        field.style.width !== '1px' || field.style.height !== '1px' ||
        field.selectionStart !== 0 ||
        field.selectionEnd !== field.textLength ||
        field.textLength < 1 ||
        field.textLength > 80
      )
        return;
      const id = field.value;
      if (!/^(?=[\w-]*\d)[A-Za-z0-9_-]{1,80}$/.test(id)) return;
      // A different explicit copy starts a new binding even for the same person.
      // Neither the public ID nor a reusable hash of it is sent to the desk.
      clearTimeout(timer);
      armed = null;
      bound = {
        controls: c,
        url: location.href,
        token: crypto.randomUUID(),
        asOf: new Date().toISOString(),
        until: Date.now() + lifetime
      };
      selectorChanges = new MutationObserver((records) => {
        // The copy button's checkmark is the only expected selector mutation.
        // A changed/reset caption, badge or menu invalidates even if its text
        // changes back before the next account/price sample.
        if (records.some((r) => r.target === c.trigger || !c.button.contains(r.target))) cancel();
      });
      selectorChanges.observe(c.trigger, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'aria-hidden', 'hidden', 'data-state']
      });
      inform('已核对当前账户。请在 60 秒内返回本机开仓页复核并操作。');
      timer = setTimeout(cancel, lifetime);
    }
    document.addEventListener('copy', onCopy, true);
    setTimeout(finish, 0);
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      const c = controls();
      if (
        armed &&
        c &&
        c.button.contains(event.target) &&
        armed.url === location.href &&
        Date.now() < armed.until
      ) {
        capture(event, c);
        return;
      }
      // Any real interaction elsewhere can change the active account, including
      // account menus in the SPA with no URL or displayed-name change.
      if (bound || armed) cancel();
    },
    true
  );
  for (const type of ['pagehide', 'popstate', 'hashchange', 'storage']) addEventListener(type, cancel);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') && !armed)
        cancel();
    },
    true
  );
  globalThis.resetVestAccountBinding = (doc) => {
    cancel();
    resetReader?.(doc);
  };
  globalThis.readVisibleVest = (doc, loc) => {
    const snap = reader(doc, loc);
    const proof = keep();
    if (snap.account?.accountContext) {
      if (proof) cancel();
      return snap;
    }
    if (!proof || snap.reason || doc !== document || loc.href !== proof.url) return snap;
    const account = { ...snap.account, accountContext: proof.token };
    if (proof.controls.stage) account.stage = proof.controls.stage;
    else delete account.stage;
    if (proof.controls.status) account.outcome = { status: proof.controls.status, asOf: proof.asOf };
    return { ...snap, account };
  };
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m.type !== 'bind-vest-account' || sender.id !== chrome.runtime.id) return;
    cancel();
    if (!globalThis.isVestReaderActive?.(m.symbol))
      return reply({
        ok: false,
        reason: '请先在开仓页的行情接入中启动 VS 页面识别，并只保留一个对应品种的 Vest 标签页。'
      });
    const c = controls();
    if (!c || location.pathname !== '/trade/' + m.symbol)
      return reply({
        ok: false,
        reason: '请登录对应 Vest 品种，关闭账户菜单，并让当前考核或实盘账户徽标及复制图标可见。'
      });
    armed = { url: location.href, until: Date.now() + lifetime };
    timer = setTimeout(cancel, lifetime);
    inform('请亲自点当前账户名称旁的复制图标。扩展只确认这次复制的公开账户编号。');
    reply({ ok: true });
  });
})();
