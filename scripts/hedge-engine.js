import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { currentMarket } from './current-market.js';
import { createUsdRatesReader } from './usd-rates.js';
import { calculateCurrent, quoteClock, subscriptionHealthy } from '../src/hedge/current.js';
import { presetAccount, accountSnapshot } from '../src/hedge/current-account.js';
import { applyVestConfirmation } from '../src/hedge/vest-confirmation.js';
import { MAINNET, TESTNET } from '../src/feeds.js';

const workerUrl = new URL('./solver-thread.js', import.meta.url);
const readUsdRates = createUsdRatesReader();

// Lightweight cached 48h candle reference for Challenge term reachability (non-blocking)
const termCache = new Map();
async function readTermReferenceServer(asset, deadline) {
  if (!deadline || !['BTC', 'ETH', 'SOL'].includes(asset)) return null;
  const end = Date.parse(deadline);
  const now = Date.now();
  if (!Number.isFinite(end) || end <= now) return null;
  const windowMs = Math.max(3600000, Math.min(48 * 3600000, end - now));
  const key = asset + ':' + Math.round(windowMs / 3600000);
  const cached = termCache.get(key);
  if (cached && now - cached.at < 120000) return cached.value;
  if (cached?.pending) return cached.value ?? null;
  const entry = { at: cached?.at ?? 0, value: cached?.value ?? null, pending: true };
  termCache.set(key, entry);
  const startTime = now - 30 * 24 * 3600000;
  fetch(MAINNET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: asset, interval: '1h', startTime, endTime: now } }),
    signal: AbortSignal.timeout(6000)
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((candles) => {
      if (!Array.isArray(candles) || candles.length < 24) return;
      const hours = Math.max(1, Math.round(windowMs / 3600000));
      const ups = [], downs = [];
      for (let i = 0; i + hours < candles.length; i++) {
        const open = Number(candles[i].o);
        if (!(open > 0)) continue;
        let hi = open, lo = open;
        for (let k = i; k < i + hours; k++) {
          hi = Math.max(hi, Number(candles[k].h));
          lo = Math.min(lo, Number(candles[k].l));
        }
        ups.push(((hi - open) / open) * 100);
        downs.push(((open - lo) / open) * 100);
      }
      if (!ups.length) return;
      ups.sort((a, b) => a - b);
      downs.sort((a, b) => a - b);
      const q80 = (arr) => arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.8))];
      entry.value = { windowMs, samples: ups.length, up: q80(ups), down: q80(downs) };
      entry.at = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      entry.pending = false;
    });
  return entry.value;
}

function marketSignature(m) {
  if (!m) return '';
  const pf = m.pf, hl = m.hl;
  return [
    m.asset,
    pf?.mark ?? '',
    pf?.levels?.[0]?.[0]?.[0] ?? '',
    pf?.levels?.[1]?.[0]?.[0] ?? '',
    hl?.mark ?? '',
    hl?.levels?.[0]?.[0]?.[0] ?? '',
    hl?.levels?.[1]?.[0]?.[0] ?? '',
    hl?.funding ?? ''
  ].join('|');
}

function quoteTimestamp(m) {
  const times = [m?.pf?.bookAt ?? m?.pf?.asOf, m?.pf?.markAt ?? m?.pf?.asOf, m?.hl?.bookAt ?? m?.hl?.asOf, m?.hl?.markAt ?? m?.hl?.asOf]
    .filter(Boolean)
    .map(Date.parse)
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function createHypeBackendEngine(hypeSigner) {
  const sessions = new Map();

  function computeInputHash(sig) {
    return createHash('sha256').update(String(sig || '')).digest('hex').slice(0, 16);
  }

  function createSession(initialConfig, clientConfigSeq = 0) {
    const id = randomUUID();
    const initialSig = JSON.stringify(initialConfig);
    const session = {
      id,
      clients: new Set(),
      streamAttachCount: 0,
      config: initialConfig,
      configSig: initialSig,
      inputHash: computeInputHash(initialSig),
      configVersion: 1,
      lastClientConfigSeq: Number.isFinite(Number(clientConfigSeq)) ? Number(clientConfigSeq) : 0,
      marketVersion: 0,
      lastMarketSig: '',
      calcSeq: 0,
      lastPublishedCalcVersion: 0,
      lastPublishedMarketVersion: 0,
      lastPublishedConfigVersion: 0,
      lastPublishedAt: null,
      lastPublishedQuoteTime: null,
      lastSnapshot: null,
      lastCalcError: null,
      latestMarket: null,
      latestRates: {},
      apiAccount: null,
      apiAccountError: '',
      apiAccountAt: 0,
      apiAccountPending: false,
      runningJob: null,
      pendingSolve: false,
      pendingFullReset: true,
      cooldownTimer: null,
      jobTimeout: null,
      pollTimer: null,
      idleTimer: null,
      worker: null,
      lastSolveMs: 0,
      lastFullSolveMs: 0,
      lastFullCalculatedAt: null,
      lastJobStartedAt: null,
      lastCalcLayer: null,
      lastTimings: null,
      lastTickerPayload: ''
    };
    sessions.set(id, session);
    startSessionLoop(session);
    return session;
  }

  function ensureWorker(session) {
    if (session.worker) return session.worker;
    const worker = new Worker(workerUrl);
    worker.on('message', (msg) => handleWorkerResult(session, msg));
    worker.on('error', (err) => {
      if (session.runningJob) {
        clearTimeout(session.jobTimeout);
        session.runningJob = null;
      }
      session.worker = null;
      session.lastCalcError = '计算线程异常：' + err.message;
      broadcastTicker(session);
      scheduleNextSolve(session, 1500);
    });
    session.worker = worker;
    return worker;
  }

  function destroySession(session) {
    clearInterval(session.pollTimer);
    clearTimeout(session.cooldownTimer);
    clearTimeout(session.jobTimeout);
    clearTimeout(session.idleTimer);
    for (const res of session.clients) {
      try { res.end(); } catch {}
    }
    session.clients.clear();
    if (session.worker) {
      session.worker.terminate().catch(() => {});
      session.worker = null;
    }
    sessions.delete(session.id);
  }

  function sendEvent(res, event, data) {
    try {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch {
      /* Client closed; cleaned up by close handler. */
    }
  }

  function broadcast(session, event, data) {
    for (const res of session.clients) sendEvent(res, event, data);
  }

  function resolveAccounts(session) {
    const cfg = session.config;
    if (cfg.fundingView === 'plan') {
      return { pf: presetAccount(cfg.rules, 'pf'), hl: presetAccount(cfg.rules, 'hl') };
    }
    const pf = cfg.manualAccounts?.pf ?? { source: '本机手工快照', equity: null, qty: null };
    if (cfg.hlSource === 'api') {
      return {
        pf,
        hl: session.apiAccount
          ? { ...session.apiAccount, accountId: cfg.wallet || '', error: session.apiAccountError || '' }
          : { accountId: cfg.wallet || '', error: session.apiAccountError || '等待 Hype API 账户读取' }
      };
    }
    return { pf, hl: cfg.manualAccounts?.hl ?? { source: '本机手工快照', equity: null, qty: null } };
  }

  async function refreshApiAccountIfNeeded(session, force = false) {
    const cfg = session.config;
    if (cfg.fundingView !== 'account' || cfg.hlSource !== 'api') return;
    if (session.apiAccountPending) return;
    const now = Date.now();
    if (!force && now - session.apiAccountAt < 4500) return;

    let wallet = (cfg.wallet || '').trim();
    let network = 'mainnet';
    if (!wallet && hypeSigner) {
      try {
        const st = await hypeSigner.getStatus();
        wallet = st.effectiveQueryAddress || '';
        network = st.network || 'mainnet';
      } catch {}
    }
    if (!/^0x[0-9a-f]{40}$/i.test(wallet)) {
      session.apiAccount = null;
      session.apiAccountError = '缺少有效的 Hype 资金账户公开地址';
      session.apiAccountAt = now;
      return;
    }
    session.apiAccountPending = true;
    try {
      const snap = await accountSnapshot(wallet, cfg.asset, async (body) => {
        const res = await fetch(network === 'testnet' ? TESTNET : MAINNET, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) throw Error('Hype API HTTP ' + res.status);
        return res.json();
      });
      const changed =
        !session.apiAccount ||
        session.apiAccount.equity !== snap.equity ||
        session.apiAccount.qty !== snap.qty ||
        session.apiAccount.leverage !== snap.leverage ||
        (session.apiAccount.orders?.length ?? -1) !== (snap.orders?.length ?? -1);
      session.apiAccount = snap;
      session.apiAccountError = '';
      session.apiAccountAt = Date.now();
      if (changed) {
        session.pendingFullReset = true;
        session.pendingSolve = true;
      }
    } catch (e) {
      session.apiAccountError = e.message;
      session.apiAccountAt = Date.now();
    } finally {
      session.apiAccountPending = false;
    }
  }

  function buildEffectiveMarket(session, rawFeed) {
    const cfg = session.config;
    const base =
      cfg.quoteSource === 'manual' && cfg.manualPrices
        ? {
            ...rawFeed,
            asset: cfg.asset,
            source: '手工确认盘口',
            pf: cfg.manualPrices.pf,
            hl: cfg.manualPrices.hl && { ...rawFeed?.hl, ...cfg.manualPrices.hl, contract: rawFeed?.hl?.contract },
            errors: { spec: rawFeed?.errors?.spec ?? null }
          }
        : { ...rawFeed, asset: cfg.asset, source: 'Vest / Hyperliquid 公开行情' };
    return applyVestConfirmation(base, cfg.vestSpec, cfg.rules.stage);
  }

  function evaluateConnectionState(session, m, a, now, overrideReason = null) {
    const cfg = session.config;
    const quoteTTL = Math.min(3000, Math.max(500, Number(cfg.rules.quoteSecs || 5) * 1000));
    const pfClock = quoteClock(m?.pf, now, quoteTTL);
    const hlClock = quoteClock(m?.hl, now, quoteTTL);
    const pfHealthy = m?.pf && pfClock.ok && subscriptionHealthy(m, 'pf', now) && !m?.errors?.pf;
    const hlHealthy = m?.hl && hlClock.ok && subscriptionHealthy(m, 'hl', now) && !m?.errors?.hl;
    const hasQuotes = Boolean(m?.pf?.mark && m?.hl?.mark);

    let precheck = null;
    try {
      precheck = calculateCurrent(cfg.rules, a, m || { asset: cfg.asset, errors: {} }, session.latestRates, now, {
        deferAuto: true,
        openingCapacity: cfg.openingCapacity !== false
      });
    } catch (e) {
      return {
        state: 'disconnected',
        stateLabel: '连接失败',
        canAct: false,
        needsSearch: false,
        reason: e.message
      };
    }

    const quoteSkewExceeded =
      precheck.timing?.quoteSkew != null &&
      precheck.timing?.quoteLimit != null &&
      precheck.timing.quoteSkew > precheck.timing.quoteLimit;

    if (overrideReason) {
      return { state: 'disconnected', stateLabel: '连接失败', canAct: false, needsSearch: false, reason: overrideReason };
    }
    if (!hasQuotes || (!m?.health?.pf?.connected && !m?.health?.hl?.connected && cfg.quoteSource !== 'manual')) {
      return {
        state: 'disconnected',
        stateLabel: '连接失败',
        canAct: false,
        needsSearch: false,
        reason: m?.errors?.pf || m?.errors?.hl || '等待双边行情连接'
      };
    }
    if (!pfHealthy || !hlHealthy || quoteSkewExceeded) {
      const reason = quoteSkewExceeded
        ? '双边盘口时差 ' + precheck.timing.quoteSkew + ' ms 超出阈值'
        : !pfHealthy
          ? m?.errors?.pf || 'Vest 行情过期或重连中'
          : m?.errors?.hl || 'Hype 行情过期或重连中';
      return { state: 'stale', stateLabel: '行情过期', businessStatus: 'quote_stale', canAct: false, needsSearch: false, reason };
    }
    if (!precheck.needsSearch) {
      if (m?.specStatus === 'loading' && !m?.spec) {
        return {
          state: 'calculating',
          stateLabel: '正在计算',
          businessStatus: 'calculating',
          canAct: false,
          needsSearch: false,
          reason: '正在读取并核实 Vest 官方合约规格…'
        };
      }
      // Market connection is healthy; rules/inputs or contract specs have an explicit validation issue.
      return {
        state: 'error',
        stateLabel: '计算失败',
        businessStatus: 'rule_invalid',
        issues: precheck.issues ?? [],
        canAct: false,
        needsSearch: false,
        reason: precheck.issues?.[0] || precheck.notices?.[0] || '规则或账户输入待完善'
      };
    }

    // Check whether published snapshot matches current config & remains within validity window.
    // Never discard or invalidate an already-completed valid result just because a new market tick arrived!
    const hasPublishedForConfig =
      session.lastSnapshot != null && session.lastPublishedConfigVersion === session.configVersion;
    const publishedCalcAgeMs = session.lastPublishedAt
      ? now - Date.parse(session.lastPublishedAt)
      : Infinity;
    const isValidPublished = hasPublishedForConfig && publishedCalcAgeMs <= 30000;

    if (session.lastCalcError && !session.runningJob) {
      return {
        state: 'error',
        stateLabel: '计算失败',
        businessStatus: 'calc_error',
        canAct: false,
        needsSearch: true,
        reason: session.lastCalcError
      };
    }

    if (!hasPublishedForConfig || !isValidPublished) {
      return {
        state: 'calculating',
        stateLabel: '正在计算',
        businessStatus: 'calculating',
        canAct: false,
        needsSearch: true,
        reason: session.lastPublishedConfigVersion !== session.configVersion ? '规则或资金变更，重算中' : '首次计算中'
      };
    }
    return {
      state: 'live',
      stateLabel: '实时连接',
      businessStatus: 'ready',
      canAct: true,
      needsSearch: true,
      reason: session.runningJob ? '后台增量同步最新盘口' : '实时行情与计算已同步'
    };
  }

  function computeLayerAFloating(session, m) {
    const col = session.lastSnapshot?.collection;
    if (!col?.groups || session.lastPublishedConfigVersion !== session.configVersion) return null;
    const pfMark = Number(m?.pf?.mark), hlMark = Number(m?.hl?.mark);
    if (!Number.isFinite(pfMark) || !Number.isFinite(hlMark)) return null;
    const floating = {};
    for (const g of col.groups) {
      for (const r of g.rows || []) {
        const refPf = Number(r.entryPrices?.pfMark ?? pfMark);
        const refHl = Number(r.entryPrices?.hlMark ?? hlMark);
        const dPf = (pfMark - refPf) * Number(r.pf || 0);
        const dHl = (hlMark - refHl) * Number(r.hl || 0);
        floating[r.key] = {
          dPf: dPf.toFixed(2),
          dHl: dHl.toFixed(2),
          netDelta: (dPf + dHl).toFixed(2)
        };
      }
    }
    return floating;
  }

  function broadcastTicker(session, overrideReason = null) {
    if (!session.clients.size) return;
    const now = Date.now();
    const m = session.latestMarket;
    const a = resolveAccounts(session);
    const conn = evaluateConnectionState(session, m, a, now, overrideReason);
    const pfBid = m?.pf?.levels?.[0]?.[0]?.[0] ?? null;
    const pfAsk = m?.pf?.levels?.[1]?.[0]?.[0] ?? null;
    const pfSpread = pfBid != null && pfAsk != null ? (Number(pfAsk) - Number(pfBid)).toFixed(1) : null;
    const hlBid = m?.hl?.levels?.[0]?.[0]?.[0] ?? null;
    const hlAsk = m?.hl?.levels?.[1]?.[0]?.[0] ?? null;
    const hlSpread = hlBid != null && hlAsk != null ? (Number(hlAsk) - Number(hlBid)).toFixed(1) : null;
    const crossSpread =
      m?.pf?.mark != null && m?.hl?.mark != null
        ? (Number(m.hl.mark) - Number(m.pf.mark)).toFixed(1)
        : null;
    const latestQuoteTime = quoteTimestamp(m);
    const quoteLatencyMs =
      latestQuoteTime && Number.isFinite(Date.parse(latestQuoteTime))
        ? Math.max(0, now - Date.parse(latestQuoteTime))
        : null;
    const vestContractMeta = m?.spec?.contract
      ? {
          symbol: m.spec.contract.symbol,
          base: m.spec.contract.baseAsset,
          quote: m.spec.contract.quoteAsset,
          settlement: m.spec.contract.settleAsset,
          sizeDecimals: m.spec.sizeDecimals,
          priceDecimals: m.spec.priceDecimals,
          initMarginRatio: m.spec.initMarginRatio,
          capitalInitMarginRatio: m.spec.capitalInitMarginRatio,
          fundedInitMarginRatio: m.spec.fundedInitMarginRatio,
          maintMarginRatio: m.spec.maintMarginRatio,
          takerFee: m.spec.takerFee,
          specSource: m.spec.contract.specSource,
          specVersion: m.spec.contract.specVersion,
          obtainedAt: m.spec.obtainedAt,
          evidence: m.spec.contract.evidence
        }
      : null;

    const payload = {
      sessionId: session.id,
      state: conn.state,
      stateLabel: conn.stateLabel,
      businessStatus: conn.businessStatus ?? (conn.state === 'disconnected' ? 'disconnected' : 'ready'),
      businessIssues: conn.issues ?? [],
      canAct: conn.canAct,
      reason: conn.reason,
      asset: session.config.asset,
      configVersion: session.configVersion,
      publishedConfigVersion: session.lastPublishedConfigVersion,
      marketVersion: session.marketVersion,
      calcVersion: session.lastPublishedCalcVersion,
      publishedMarketVersion: session.lastPublishedMarketVersion,
      publishedQuoteSnapshotId: session.lastSnapshot?.quoteSnapshotId ?? null,
      bgCalculating: Boolean(session.runningJob),
      isCurrentMarket:
        session.lastPublishedConfigVersion === session.configVersion &&
        session.lastPublishedMarketVersion === session.marketVersion,
      pf: m?.pf
        ? {
            mark: m.pf.mark != null ? String(m.pf.mark) : null,
            bid: pfBid != null ? String(pfBid) : null,
            ask: pfAsk != null ? String(pfAsk) : null,
            spread: pfSpread,
            asOf: m.pf.markAt ?? m.pf.asOf ?? null,
            ready: Boolean(m.health?.pf?.ready || m.pf.mark != null),
            error: m.errors?.pf ?? null
          }
        : { mark: null, bid: null, ask: null, spread: null, asOf: null, ready: false, error: m?.errors?.pf ?? 'Vest 行情未就绪' },
      hl: m?.hl
        ? {
            mark: m.hl.mark != null ? String(m.hl.mark) : null,
            bid: hlBid != null ? String(hlBid) : null,
            ask: hlAsk != null ? String(hlAsk) : null,
            spread: hlSpread,
            funding: m.hl.funding ?? null,
            asOf: m.hl.markAt ?? m.hl.asOf ?? null,
            ready: Boolean(m.health?.hl?.ready || m.hl.mark != null),
            bookSource: m.hl.bookSource ?? null,
            error: m.errors?.hl ?? null
          }
        : { mark: null, bid: null, ask: null, spread: null, funding: null, asOf: null, ready: false, bookSource: null, error: m?.errors?.hl ?? 'Hype 行情未就绪' },
      crossSpread,
      floatingByKey: computeLayerAFloating(session, m),
      vestContractMeta,
      errors: m?.errors ?? {},
      quoteUpdatedAt: latestQuoteTime,
      quoteLatencyMs,
      jobStartedAt: session.runningJob?.startedAtIso ?? session.lastJobStartedAt,
      calculatedAt: session.lastPublishedAt,
      lastFullCalculatedAt: session.lastFullCalculatedAt ?? session.lastPublishedAt,
      quoteTime: session.lastPublishedQuoteTime,
      solveMs: session.lastSolveMs,
      lastFullSolveMs: session.lastFullSolveMs || session.lastSolveMs,
      calcLayer: session.lastCalcLayer,
      timings: session.lastTimings,
      apiAccount:
        session.config.fundingView === 'account' && session.config.hlSource === 'api'
          ? { snapshot: session.apiAccount, error: session.apiAccountError }
          : null,
      serverNow: new Date(now).toISOString()
    };
    const serialized = JSON.stringify(payload);
    if (serialized === session.lastTickerPayload) return;
    session.lastTickerPayload = serialized;
    broadcast(session, 'ticker', payload);
  }

  function scheduleNextSolve(session, delayMs = 0) {
    clearTimeout(session.cooldownTimer);
    if (session.runningJob) {
      session.pendingSolve = true;
      return;
    }
    session.cooldownTimer = setTimeout(() => {
      session.cooldownTimer = null;
      void dispatchSolveIfNeeded(session);
    }, delayMs);
  }

  async function dispatchSolveIfNeeded(session) {
    if (session.runningJob || !session.clients.size) return;
    const m = session.latestMarket;
    if (!m) return;
    const now = Date.now();
    const a = resolveAccounts(session);
    const conn = evaluateConnectionState(session, m, a, now);
    if (!conn.needsSearch) {
      session.pendingSolve = false;
      broadcastTicker(session);
      return;
    }

    // Attach non-blocking 48h term reference when in Challenge stage
    const marketForSolve = { ...m };
    if (session.config.rules.stage === 'challenge' && !session.config.rules.evaluationClose) {
      const ref = await readTermReferenceServer(session.config.asset, session.config.rules.deadline);
      if (ref) marketForSolve.termReference = ref;
    }

    const jobId = ++session.calcSeq;
    const reprice = !session.pendingFullReset && session.lastPublishedConfigVersion === session.configVersion;
    session.pendingSolve = false;
    session.pendingFullReset = false;

    const job = {
      jobId,
      configVersion: session.configVersion,
      marketVersion: session.marketVersion,
      quoteTime: quoteTimestamp(marketForSolve),
      startedAt: now,
      startedAtIso: new Date(now).toISOString()
    };
    session.runningJob = job;
    session.lastJobStartedAt = job.startedAtIso;

    const worker = ensureWorker(session);
    clearTimeout(session.jobTimeout);
    session.jobTimeout = setTimeout(() => {
      if (session.runningJob?.jobId !== jobId) return;
      session.runningJob = null;
      if (session.worker) {
        session.worker.terminate().catch(() => {});
        session.worker = null;
      }
      session.lastCalcError = '单次计算超时，正在自动重启求解';
      broadcastTicker(session);
      scheduleNextSolve(session, 1000);
    }, 15000);

    worker.postMessage({
      jobId,
      configVersion: job.configVersion,
      marketVersion: job.marketVersion,
      r: session.config.rules,
      a,
      m: marketForSolve,
      rates: session.latestRates,
      t: now,
      reprice,
      openingCapacity: session.config.openingCapacity !== false
    });
  }

  function handleWorkerResult(session, msg) {
    if (!session.runningJob || session.runningJob.jobId !== msg.jobId) return;
    const job = session.runningJob;
    clearTimeout(session.jobTimeout);
    session.runningJob = null;
    session.lastSolveMs = msg.solveMs ?? 0;

    // Stale config guard: user changed rules/capital/stage mid-flight -> discard & run full solve immediately
    if (msg.configVersion !== session.configVersion) {
      session.pendingFullReset = true;
      session.pendingSolve = true;
      scheduleNextSolve(session, 0);
      return;
    }
    // Stale calcVersion guard: never overwrite newer calculation with older result
    if (msg.jobId < session.lastPublishedCalcVersion) {
      if (session.pendingSolve) scheduleNextSolve(session, 200);
      return;
    }

    if (msg.ok && msg.collection) {
      session.lastCalcError = null;
      session.lastPublishedCalcVersion = msg.jobId;
      session.lastPublishedMarketVersion = msg.marketVersion;
      session.lastPublishedConfigVersion = msg.configVersion;
      session.lastPublishedAt = msg.finishedAt;
      session.lastPublishedQuoteTime = job.quoteTime;
      session.lastJobStartedAt = msg.startedAt || job.startedAtIso;
      const timings = msg.timings ?? msg.collection?.timings ?? null;
      session.lastTimings = timings;
      session.lastCalcLayer = timings?.layer ?? (msg.reprice ? 'B_incremental' : 'C_full_search');
      if (session.lastCalcLayer === 'C_full_search' || !session.lastFullSolveMs) {
        session.lastFullSolveMs = msg.solveMs ?? 0;
        session.lastFullCalculatedAt = msg.finishedAt;
      } else if (timings?.lastFullSearchAt) {
        session.lastFullCalculatedAt = timings.lastFullSearchAt;
      }

      const snapshotPayload = {
        sessionId: session.id,
        snapshotId: msg.traceId || 'calc-' + msg.jobId,
        quoteSnapshotId: msg.marketId || 'mkt-' + msg.marketVersion,
        calcVersion: msg.jobId,
        marketVersion: msg.marketVersion,
        configVersion: msg.configVersion,
        inputHash: session.inputHash,
        jobStartedAt: session.lastJobStartedAt,
        calculatedAt: msg.finishedAt,
        lastFullCalculatedAt: session.lastFullCalculatedAt,
        quoteTime: job.quoteTime,
        solveMs: msg.solveMs,
        lastFullSolveMs: session.lastFullSolveMs,
        calcLayer: session.lastCalcLayer,
        timings,
        reprice: msg.reprice,
        collection: msg.collection,
        marketUnits: msg.marketUnits,
        bookSummary: msg.bookSummary,
        issues: msg.issues,
        notices: msg.notices,
        deriveMoves: msg.deriveMoves
      };
      session.lastSnapshot = snapshotPayload;
      broadcast(session, 'snapshot', snapshotPayload);
    } else if (!msg.ok) {
      session.lastCalcError = '求解失败：' + (msg.error || '未知错误');
    }

    broadcastTicker(session);

    // If newer market ticks arrived while solving, coalesce into one smooth incremental reprice
    if (session.pendingSolve || session.marketVersion > session.lastPublishedMarketVersion) {
      const cooldown = Math.min(1200, Math.max(450, Math.round(session.lastSolveMs * 0.6)));
      scheduleNextSolve(session, cooldown);
    }
  }

  async function pollSession(session) {
    if (!session.clients.size) return;
    try {
      const [rawFeed, usdRates] = await Promise.all([
        currentMarket(session.config.asset, { partial: true }),
        readUsdRates().catch(() => ({ rates: session.latestRates }))
      ]);
      session.latestRates = usdRates?.rates ?? session.latestRates ?? {};
      const m = buildEffectiveMarket(session, rawFeed);
      session.latestMarket = m;
      await refreshApiAccountIfNeeded(session);

      const sig = marketSignature(m);
      if (sig && sig !== session.lastMarketSig) {
        session.lastMarketSig = sig;
        session.marketVersion++;
        session.pendingSolve = true;
      }

      broadcastTicker(session);

      const needsFirst = session.lastPublishedConfigVersion !== session.configVersion;
      if (needsFirst && !session.runningJob) {
        scheduleNextSolve(session, 0);
      } else if (session.pendingSolve && !session.runningJob && !session.cooldownTimer) {
        const cooldown = session.lastPublishedAt ? Math.min(1000, Math.max(400, Math.round(session.lastSolveMs * 0.5))) : 0;
        scheduleNextSolve(session, cooldown);
      }
    } catch (e) {
      broadcastTicker(session, '后台行情轮询失败：' + e.message);
    }
  }

  function startSessionLoop(session) {
    void pollSession(session);
    session.pollTimer = setInterval(() => void pollSession(session), 500);
  }

  function upsertSession(body) {
    const existing = body.sessionId ? sessions.get(body.sessionId) : null;
    const reqSeq = body.clientConfigSeq != null && Number.isFinite(Number(body.clientConfigSeq))
      ? Number(body.clientConfigSeq)
      : null;
    const nextConfig = {
      asset: typeof body.asset === 'string' ? body.asset : 'BTC',
      fundingView: body.fundingView === 'account' ? 'account' : 'plan',
      hlSource: body.hlSource === 'api' ? 'api' : 'manual',
      wallet: typeof body.wallet === 'string' ? body.wallet.trim() : '',
      quoteSource: body.quoteSource === 'manual' ? 'manual' : 'api',
      manualPrices: body.manualPrices ?? null,
      manualAccounts: body.manualAccounts ?? null,
      vestSpec: body.vestSpec ?? null,
      openingCapacity: body.openingCapacity !== false,
      rules: body.rules ?? {}
    };
    if (!existing) {
      const created = createSession(nextConfig, reqSeq ?? 0);
      return { sessionId: created.id, configVersion: created.configVersion, inputHash: created.inputHash, clientConfigSeq: created.lastClientConfigSeq };
    }
    // Generation guard: reject out-of-order stale config POST so slow requests never overwrite newer inputs
    if (reqSeq != null && reqSeq < existing.lastClientConfigSeq) {
      return {
        sessionId: existing.id,
        configVersion: existing.configVersion,
        inputHash: existing.inputHash,
        clientConfigSeq: existing.lastClientConfigSeq,
        stale: true
      };
    }
    if (reqSeq != null) existing.lastClientConfigSeq = reqSeq;
    const nextSig = JSON.stringify(nextConfig);
    if (nextSig === existing.configSig) {
      return {
        sessionId: existing.id,
        configVersion: existing.configVersion,
        inputHash: existing.inputHash,
        clientConfigSeq: existing.lastClientConfigSeq,
        unchanged: true
      };
    }
    const assetChanged = existing.config.asset !== nextConfig.asset;
    existing.config = nextConfig;
    existing.configSig = nextSig;
    existing.inputHash = computeInputHash(nextSig);
    existing.configVersion++;
    existing.lastSnapshot = null;
    existing.lastCalcError = null;
    existing.pendingFullReset = true;
    existing.pendingSolve = true;
    if (assetChanged) {
      existing.lastMarketSig = '';
      existing.latestMarket = null;
      existing.apiAccount = null;
      existing.apiAccountAt = 0;
    }
    // Never kill running worker synchronously; configVersion guard discards stale result cleanly,
    // and if idle, kick off immediately!
    if (!existing.runningJob) {
      void pollSession(existing).then(() => scheduleNextSolve(existing, 0));
    } else {
      broadcastTicker(existing);
    }
    return { sessionId: existing.id, configVersion: existing.configVersion, inputHash: existing.inputHash, clientConfigSeq: existing.lastClientConfigSeq };
  }

  function attachStream(sessionId, req, res) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    clearTimeout(session.idleTimer);
    req.setTimeout(0);
    res.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    session.clients.add(res);
    session.streamAttachCount++;

    // Only replay lastSnapshot if it belongs to the current active configVersion (never replay stale-config snapshot!)
    if (session.lastSnapshot && session.lastSnapshot.configVersion === session.configVersion) {
      sendEvent(res, 'snapshot', session.lastSnapshot);
    }
    session.lastTickerPayload = '';
    broadcastTicker(session);
    if (!session.runningJob && session.lastPublishedConfigVersion !== session.configVersion) {
      void pollSession(session);
    }

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      session.clients.delete(res);
      if (!session.clients.size) {
        clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => {
          if (!session.clients.size) destroySession(session);
        }, 60000);
      }
    });
    return true;
  }

  return {
    upsertSession,
    attachStream,
    getSessionStats(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return {
        sessionId: s.id,
        clients: s.clients.size,
        streamConnections: s.streamAttachCount,
        configVersion: s.configVersion,
        publishedConfigVersion: s.lastPublishedConfigVersion,
        marketVersion: s.marketVersion,
        calcVersion: s.lastPublishedCalcVersion,
        calcJobCount: s.calcSeq,
        publishedMarketVersion: s.lastPublishedMarketVersion,
        runningJob: s.runningJob ? s.runningJob.jobId : null,
        jobStartedAt: s.runningJob?.startedAtIso ?? s.lastJobStartedAt,
        pendingSolve: s.pendingSolve,
        lastCalcError: s.lastCalcError,
        solveMs: s.lastSolveMs,
        lastFullSolveMs: s.lastFullSolveMs,
        lastFullCalculatedAt: s.lastFullCalculatedAt,
        calcLayer: s.lastCalcLayer,
        timings: s.lastTimings
      };
    }
  };
}
