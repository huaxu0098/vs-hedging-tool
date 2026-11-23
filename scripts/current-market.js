import { subscribeVestMarket } from '../src/vest-market.js';
import { collectHype, subscribeHypeMarket, MAINNET } from '../src/hedge/adapters.js';
import { quoteClock } from '../src/hedge/current.js';
import { readVestSpecs } from './vest-contract.js';

async function publicInfo(body) {
  const res = await fetch(MAINNET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(body.type==='l2Book' ? 4500 : 25000),
    redirect: 'error'
  });
  if (!res.ok) throw Error('Hype HTTP ' + res.status);
  return res.json();
}

let tokenIndex, tokenRequest;
async function readTokenIndex() {
  if (tokenIndex && Date.now() - tokenIndex.at < 60000) return tokenIndex;
  tokenRequest ??= publicInfo({ type: 'spotMeta' })
    .then(({ tokens }) => {
      tokenIndex = {
        at: Date.now(),
        tokens: new Map(tokens.filter((x) => x.isCanonical).map((x) => [x.index, x]))
      };
      return tokenIndex;
    })
    .finally(() => {
      tokenRequest = null;
    });
  return tokenRequest;
}
// Deduplicate a source's outstanding request across tabs. A stalled dependency
// must not reduce the refresh frequency of either venue's native prices.
function refreshSource(stream, source, read, interval=1000) {
  const previous = stream.reads[source];
  if (previous && (previous.pending || Date.now() - previous.at < interval)) return previous.pending;
  const current = { at: Date.now() };
  stream.reads[source] = current;
  current.pending = read(current.at).finally(() => {
    current.pending = null;
  });
  return current.pending;
}

const streams = new Map();
const publicAssets = new Set(['BTC', 'ETH', 'SOL']);
export async function currentMarket(asset, { partial = false } = {}) {
  if (!publicAssets.has(asset)) {
    return {
      asset,
      specStatus: 'unmapped',
      errors: {
        pf: '该品种（' + asset + '）尚未映射官方合约规格，继续显示待核实（禁止套用 BTC 规格）',
        hl: '该品种（' + asset + '）尚未映射官方合约规格，继续显示待核实（禁止套用 BTC 规格）',
        spec: '品种 ' + asset + ' 尚未建立 Vest × Hype 合约规格映射（待核实）'
      }
    };
  }
  let s = streams.get(asset);
  if (!s) {
    const health=()=>({connected:false,subscription:'connecting',lastMessageAt:null,lastValidQuoteAt:null,reconnectCount:0});
    s = { health:{pf:health(),hl:health()}, streak:{}, asset, errors: {}, reads: {}, startedAt: Date.now() };
    streams.set(asset, s);
    s.stopHype = subscribeHypeMarket(asset,(channel,item)=>{
      if(channel==='l2Book') s.wsBook=item;
      else s.wsMark=item;
    },update=>{
      Object.assign(s.health.hl,update);
      s.wsConnected=s.health.hl.connected;
      if(update.connected===false) {
        s.wsBook=s.wsMark=null;
        delete s.streak.hl;
      }
    });
    s.stop = subscribeVestMarket(
      asset + '-PERP',
      (q) => {
        s.quote = q;
        s.health.pf.lastValidQuoteAt=q.asOf;
        delete s.errors.pf;
      },
      (msg) => {
        s.errors.pf = msg;
      },
      { includeDepth:true,onHealth:update=>{ Object.assign(s.health.pf,update); if(update.connected===false || update.subscription==='stale') {delete s.streak.pf;s.quote=null;} } }
    );
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.stop();
    s.stopHype();
    streams.delete(asset);
  }, 90000);
  const specTask = refreshSource(
    s,
    'vestSpec',
    () =>
      readVestSpecs(asset + '-PERP').then(
        (spec) => {
          s.spec = spec;
          if (spec?.symbol === asset + '-PERP') {
            const missing = spec.contract?.missingApiFields ?? [];
            if (missing.length) {
              s.specStatus = 'incomplete';
              s.errors.spec = 'Vest exchangeInfo 缺少必需字段：' + missing.join('、');
            } else {
              delete s.errors.spec;
              s.specStatus = 'ok';
            }
          } else {
            s.specStatus = 'unlisted';
            s.errors.spec = 'Vest 合约列表中没有 ' + asset + '-PERP';
          }
        },
        (error) => {
          if (!s.spec) {
            s.spec = null;
            s.specStatus = 'unavailable';
            s.errors.spec = 'Vest exchangeInfo 获取失败 · ' + error.message;
          }
        }
      ),
    s.spec ? 30000 : 1000
  );
  const tokenTask = refreshSource(
    s,
    'collateral',
    () =>
      readTokenIndex().then(
        (index) => {
          s.tokenIndex = index;
        },
        () => {
          if (!s.tokenIndex) s.tokenIndex = null;
        }
      ),
    s.tokenIndex ? 30000 : 1000
  );
  const hypeTask = refreshSource(s, 'hype', (at) => {
    const requestedAt = new Date(at).toISOString();
    return collectHype({ symbol: asset, request: publicInfo })
      .then((d) => {
        // The collateral dictionary and the Vest spec are independent of the
        // native perpetual book. Publish price observations as soon as available.
        const newestBook = !s.hl || d.quote.occurredAt >= s.hl.asOf;
        s.hl = {
          symbol: d.symbol,
          mark: d.mark,
          oracle: d.oracle,
          assetId: d.assetId,
          markAt: requestedAt,
          markSource:'Hyperliquid REST · metaAndAssetCtxs（请求时间）',
          tiersAt: requestedAt,
          bookSource: newestBook ? 'Hyperliquid REST · l2Book' : s.hl.bookSource,
          asOf: newestBook ? d.quote.occurredAt : s.hl.asOf,
          levels: newestBook ? d.quote.levels : s.hl.levels,
          receivedAt: d.receivedAt,
          sizeDecimals: d.sizeDecimals,
          maxLeverage: d.maxLeverage,
          onlyIsolated: d.onlyIsolated,
          marginTiers:
            d.marginTables?.find(([id]) => id === d.marginTableId)?.[1]?.marginTiers ??
            (Number.isInteger(d.marginTableId) && d.marginTableId > 0 && d.marginTableId < 50
              ? [{ lowerBound: '0', maxLeverage: d.marginTableId }]
              : null),
          contract: d.contract,
          collateralToken: d.collateralToken
        };
        delete s.errors.hl;
      })
      .catch((error) => {
        s.errors.hl = 'Hype 请求失败 · ' + error.message;
        // Invalid instruments or schemas supersede any cached contract.
        if (!['TimeoutError','AbortError','TypeError'].includes(error.name) &&
            !/^Hype HTTP (429|5[0-9][0-9])$/.test(error.message)) s.hl=null;
      });
  }, s.wsConnected && Date.now()-Date.parse(s.wsMark?.receivedAt)<3000 &&
    Date.now()-Date.parse(s.wsBook?.occurredAt)<3000 && s.hl ? 15000 : 1000);
  if (!partial) {
    await Promise.allSettled([specTask, hypeTask, tokenTask]);
  } else if (!s.spec || !s.tokenIndex) {
    await Promise.race([
      Promise.allSettled([specTask, tokenTask]),
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
  }
  let hl = s.hl;
  if(hl && s.wsBook && s.wsMark) {
    hl={...hl,levels:s.wsBook.levels,asOf:s.wsBook.occurredAt,bookSource:'Hyperliquid WebSocket · l2Book',
      mark:s.wsMark.mark,oracle:s.wsMark.oracle,funding:s.wsMark.funding,markAt:s.wsMark.receivedAt,
      markSource:'Hyperliquid WebSocket · activeAssetCtx（本机接收时间）'};
  }
  if (hl) {
    const token = s.tokenIndex?.tokens.get(hl.collateralToken);
    hl = {
      ...hl,
      contract: {
        ...hl.contract,
        settleAsset: token?.name === hl.contract.settleAsset ? token.name : null,
        collateralEvidence: token
          ? {
              index: token.index,
              name: token.name,
              tokenId: token.tokenId,
              asOf: new Date(s.tokenIndex.at).toISOString(),
              source: 'Hyperliquid spotMeta.tokens'
            }
          : null
      }
    };
  }
  const errors = { ...s.errors };
  // The public mark stream has no exchange timestamp. Its receipt time is
  // independent of the exchange-timestamped book and the REST tier clock.
  if (hl) {
    const freshSpec=Date.now()-Date.parse(hl.tiersAt)<60000;
    // Drop a failed REST refresh only while both independent live feeds and
    // the verified contract are fresh. The workbench applies its own skew/TTL.
    if (s.wsConnected && s.wsMark && s.wsBook && freshSpec &&
        Date.now()-Date.parse(s.wsMark.receivedAt)<2500 && Date.now()-Date.parse(s.wsBook.occurredAt)<2500)
      delete errors.hl;
    if (!freshSpec) errors.hl ||= 'Hype 合约风险档位已过期，等待主网元数据';
  }
  if (Date.now() - s.startedAt > 10000) {
    if (!s.quote) errors.pf ||= 'Vest 未收到匹配合约的有效盘口与标记价，正在重试';
    if (!hl) errors.hl ||= 'Hyperliquid 未收到该永续合约的行情，正在重试';
  }
  const health={};
  for(const [side,q] of [['pf',s.quote],['hl',hl]]) {
    const h={...s.health[side]}, now=Date.now();
    const stamp=Math.min(Date.parse(q?.bookAt??q?.asOf),Date.parse(q?.markAt??q?.asOf));
    if(side==='pf') {
      h.stableMs=h.stableSince?Math.max(0,now-Date.parse(h.stableSince)):0;
      h.heartbeat=h.connected && now-Date.parse(h.lastMessageAt)<=3000;
    }
    const valid=quoteClock(q,now,3000).ok && !errors[side] && h.connected &&
      h.subscription==='streaming' && h.heartbeat && (side==='pf'||h.continuous);
    if(!valid && h.connected && h.subscription==='streaming' && !quoteClock(q,now,3000).ok) {
      h.subscription='stale';
      if(side==='pf') h.stableMs=0;
    }
    if(!valid) delete s.streak[side];
    else {
      const prior=s.streak[side];
      if(!prior || stamp-prior.stamp>3000) s.streak[side]={stamp,count:1};
      else if(stamp>prior.stamp) s.streak[side]={stamp,count:prior.count+1};
      s.health[side].lastValidQuoteAt=h.lastValidQuoteAt=new Date(stamp).toISOString();
    }
    const ready=valid && (side==='hl'?h.continuous:s.streak[side].count>=2);
    if(!ready) errors[side] ||= valid?'恢复中，等待连续有效报价':'等待有效订阅、心跳及三秒内的盘口与标记（'+h.subscription+'）';
    health[side]={...h,quoteAgeMs:h.lastValidQuoteAt?now-Date.parse(h.lastValidQuoteAt):null,ready:!!ready};
  }
  return {
    asset,health,
    pf: s.quote,
    spec: s.spec,
    specAt: s.spec?.obtainedAt,
    hl,
    specStatus: s.specStatus ?? 'loading',
    errors
  };
}
