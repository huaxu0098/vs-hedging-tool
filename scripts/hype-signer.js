import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { MAINNET, TESTNET } from '../src/feeds.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, '.local', 'hype-api-config.json');
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isValidAddress(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v.trim());
}

function normAddr(v) {
  return isValidAddress(v) ? v.trim() : '';
}

function infoUrl(network) {
  return network === 'testnet' ? TESTNET : MAINNET;
}

async function queryInfo(network, body) {
  const res = await fetch(infoUrl(network), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
    cache: 'no-store'
  });
  if (!res.ok) throw Error('Hype Info HTTP ' + res.status);
  return res.json();
}

// Discover Desktop credential file ONLY when there is a single unambiguous match.
async function discoverDesktopCredential() {
  const desktop = join(homedir(), 'Desktop');
  try {
    const names = (await readdir(desktop)).filter(
      (f) => /\.txt$/i.test(f) && /hype.*api|api.*hype/i.test(f)
    );
    if (names.length === 1) return { path: join(desktop, names[0]), candidates: names };
    return { path: '', candidates: names };
  } catch {
    return { path: '', candidates: [] };
  }
}

async function loadSavedConfig() {
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          network: parsed.network === 'testnet' ? 'testnet' : 'mainnet',
          credentialPath: typeof parsed.credentialPath === 'string' ? parsed.credentialPath.trim() : '',
          tradingAccountAddress: normAddr(parsed.tradingAccountAddress),
          subAccountAddress: normAddr(parsed.subAccountAddress)
        };
      }
    } catch {
      /* Fall back to fresh discovery if local JSON is corrupt. */
    }
  }
  const found = await discoverDesktopCredential();
  return {
    network: 'mainnet',
    credentialPath: found.path,
    tradingAccountAddress: '',
    subAccountAddress: '',
    desktopCandidates: found.candidates
  };
}

async function persistConfig(cfg) {
  // Never write private keys! Persist only file path and public addresses.
  const safe = {
    network: cfg.network === 'testnet' ? 'testnet' : 'mainnet',
    credentialPath: cfg.credentialPath || '',
    tradingAccountAddress: normAddr(cfg.tradingAccountAddress),
    subAccountAddress: normAddr(cfg.subAccountAddress),
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
}

// Strictly parse a local credential TXT without ever logging or returning the key.
async function readPrivateKeyFromFile(filePath) {
  if (!filePath) {
    return { status: 'not_configured', error: '未配置本地凭证文件路径' };
  }
  const resolved = resolve(filePath.replace(/^~(?=\/|$)/, homedir()));
  let raw;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (e) {
    return {
      status: 'missing',
      resolvedPath: resolved,
      error: e.code === 'ENOENT' ? '凭证文件不存在：' + resolved : '无法读取凭证文件：' + e.message
    };
  }
  const keys = new Set();
  const keyRe = /(?:^|[^0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
  for (const m of raw.matchAll(keyRe)) {
    keys.add('0x' + m[1].toLowerCase());
  }
  const publicAddresses = [...new Set(raw.match(/\b0x[0-9a-fA-F]{40}\b/g) || [])];
  if (keys.size === 0) {
    return {
      status: 'invalid_format',
      resolvedPath: resolved,
      publicAddresses,
      error: '凭证文件中未识别到合法的 64 位十六进制私钥'
    };
  }
  if (keys.size > 1) {
    return {
      status: 'ambiguous',
      resolvedPath: resolved,
      keyCount: keys.size,
      publicAddresses,
      error: '凭证文件包含 ' + keys.size + ' 把私钥，系统不会随意选取，请改用单私钥文件'
    };
  }
  const privateKey = [...keys][0];
  try {
    const account = privateKeyToAccount(privateKey);
    return {
      status: 'loaded',
      resolvedPath: resolved,
      account,
      signerAddress: account.address,
      publicAddresses
    };
  } catch (e) {
    return {
      status: 'invalid_format',
      resolvedPath: resolved,
      error: '私钥派生地址失败：' + e.message
    };
  }
}

export function createHypeSignerService() {
  let config = null;
  let loadedAccount = null; // In-memory viem Account only; never serialized out.
  let cachedStatus = null;

  async function ensureConfig() {
    if (!config) config = await loadSavedConfig();
    return config;
  }

  async function verifyAndRefresh(overrides = null) {
    const base = await ensureConfig();
    if (overrides) {
      if (overrides.network === 'mainnet' || overrides.network === 'testnet') base.network = overrides.network;
      if (typeof overrides.credentialPath === 'string') base.credentialPath = overrides.credentialPath.trim();
      if (typeof overrides.tradingAccountAddress === 'string') {
        const t = overrides.tradingAccountAddress.trim();
        if (t && !isValidAddress(t)) throw Error('资金账户公开地址格式无效（须为 0x + 40 位十六进制）');
        base.tradingAccountAddress = t;
      }
      if (typeof overrides.subAccountAddress === 'string') {
        const s = overrides.subAccountAddress.trim();
        if (s && !isValidAddress(s)) throw Error('子账户公开地址格式无效（须为 0x + 40 位十六进制）');
        base.subAccountAddress = s;
      }
      await persistConfig(base);
    }

    const checkedAt = new Date().toISOString();
    const cred = await readPrivateKeyFromFile(base.credentialPath);
    loadedAccount = cred.status === 'loaded' ? cred.account : null;

    const status = {
      network: base.network,
      credentialPath: base.credentialPath,
      credentialStatus: cred.status, // 'loaded' | 'not_configured' | 'missing' | 'invalid_format' | 'ambiguous'
      credentialError: cred.error || null,
      signerAddress: cred.signerAddress || null,
      signerRole: null, // 'user' | 'agent' | 'subAccount' | 'vault' | 'missing' | null
      discoveredMasterAddress: null,
      tradingAccountAddress: normAddr(base.tradingAccountAddress),
      subAccountAddress: normAddr(base.subAccountAddress),
      effectiveQueryAddress: null,
      authStatus: cred.status === 'loaded' ? 'unverified' : 'not_applicable',
      authDetail: cred.status === 'loaded' ? '等待核对平台授权关系' : '未加载本地私钥，仅使用公开行情/只读地址',
      agentName: null,
      agentValidUntil: null,
      subAccountVerified: null,
      sdkReady: false,
      checkedAt
    };

    // If credential TXT explicitly contained a single public address and user hasn't set tradingAccountAddress, note it as candidate.
    if (!status.tradingAccountAddress && cred.publicAddresses?.length === 1) {
      status.tradingAccountAddress = cred.publicAddresses[0];
    }

    // 1. Query official userRole for derived signerAddress
    if (status.signerAddress) {
      try {
        const roleResp = await queryInfo(base.network, { type: 'userRole', user: status.signerAddress });
        status.signerRole = roleResp?.role ?? 'unknown';
        if (roleResp?.role === 'agent' && isValidAddress(roleResp?.data?.user)) {
          status.discoveredMasterAddress = roleResp.data.user;
          if (!status.tradingAccountAddress) {
            status.tradingAccountAddress = roleResp.data.user;
            base.tradingAccountAddress = roleResp.data.user;
            await persistConfig(base);
          }
        } else if (roleResp?.role === 'user' && !status.tradingAccountAddress) {
          status.tradingAccountAddress = status.signerAddress;
          base.tradingAccountAddress = status.signerAddress;
          await persistConfig(base);
        }
      } catch (e) {
        status.authStatus = 'unverified';
        status.authDetail = '查询签名地址角色失败：' + e.message;
      }
    }

    // 2. Determine which public address should be queried for account funds (NEVER use an agent address!)
    if (status.subAccountAddress) {
      status.effectiveQueryAddress = status.subAccountAddress;
    } else if (status.tradingAccountAddress) {
      status.effectiveQueryAddress = status.tradingAccountAddress;
    } else if (status.signerAddress && status.signerRole === 'user') {
      status.effectiveQueryAddress = status.signerAddress;
    }

    // 3. Verify official authorization between signerAddress and tradingAccountAddress (read-only!)
    if (status.signerAddress && status.tradingAccountAddress) {
      const sameAddr = status.signerAddress.toLowerCase() === status.tradingAccountAddress.toLowerCase();
      if (sameAddr) {
        if (status.signerRole === 'agent') {
          status.authStatus = 'misconfigured_agent_as_fund';
          status.authDetail =
            '当前资金账户地址与 API/Agent 签名地址相同；Agent 地址不持有资金，请填写主资金账户地址' +
            (status.discoveredMasterAddress ? '（平台绑定主账户：' + status.discoveredMasterAddress + '）' : '');
          if (status.discoveredMasterAddress) {
            status.effectiveQueryAddress = status.subAccountAddress || status.discoveredMasterAddress;
          }
        } else {
          status.authStatus = 'direct_master';
          status.authDetail = '主账户直签（签名地址与资金账户地址一致）';
        }
      } else {
        try {
          const agents = await queryInfo(base.network, {
            type: 'extraAgents',
            user: status.tradingAccountAddress
          });
          const match = Array.isArray(agents)
            ? agents.find((a) => a.address?.toLowerCase() === status.signerAddress.toLowerCase())
            : null;
          if (!match) {
            status.authStatus = 'unauthorized';
            status.authDetail =
              '签名地址不在资金账户 ' + status.tradingAccountAddress + ' 的已授权 extraAgents 列表中';
          } else {
            status.agentName = match.name ?? '';
            status.agentValidUntil = match.validUntil ? new Date(match.validUntil).toISOString() : null;
            const expired = match.validUntil != null && match.validUntil <= Date.now();
            if (expired) {
              status.authStatus = 'expired';
              status.authDetail = 'API Agent 授权已于 ' + status.agentValidUntil + ' 过期';
            } else {
              status.authStatus = 'verified';
              status.authDetail =
                '已核对 · API Agent' +
                (match.name ? ' "' + match.name + '"' : '') +
                ' 已获主账户授权' +
                (status.agentValidUntil ? '（有效至 ' + status.agentValidUntil.slice(0, 10) + '）' : '');
            }
          }
        } catch (e) {
          status.authStatus = 'unverified';
          status.authDetail = '查询 extraAgents 授权列表失败：' + e.message;
        }
      }

      // If subAccountAddress is provided, verify it belongs to tradingAccountAddress
      if (status.subAccountAddress) {
        try {
          const subs = await queryInfo(base.network, {
            type: 'subAccounts',
            user: status.tradingAccountAddress
          });
          const ok =
            Array.isArray(subs) &&
            subs.some((s) => s.subAccountUser?.toLowerCase() === status.subAccountAddress.toLowerCase());
          status.subAccountVerified = ok;
          if (!ok) {
            status.authDetail += ' · 警告：该子账户未出现在主账户 subAccounts 列表中';
          }
        } catch {
          status.subAccountVerified = null;
        }
      }
    } else if (status.signerAddress && !status.tradingAccountAddress) {
      status.authStatus = 'unverified';
      status.authDetail = '已派生签名地址，但尚未确定主资金账户公开地址（请补充公开资金账户地址）';
    }

    // 4. Verify official SDK signing client can instantiate (purely local, ZERO network /exchange calls!)
    if (loadedAccount) {
      try {
        const transport = new HttpTransport({ isTestnet: base.network === 'testnet' });
        const client = new ExchangeClient({
          wallet: loadedAccount,
          transport,
          ...(status.subAccountAddress ? { defaultVaultAddress: status.subAccountAddress } : {})
        });
        status.sdkReady = Boolean(client && typeof client.order === 'function');
      } catch {
        status.sdkReady = false;
      }
    }

    cachedStatus = status;
    return status;
  }

  async function getStatus() {
    if (!cachedStatus) return verifyAndRefresh();
    return cachedStatus;
  }

  // Reusable official SDK Exchange adapter for future explicit trading actions ONLY.
  // Never called by quote polling, solver recalculation, or candidate switching.
  async function getExchangeAdapter() {
    const st = await getStatus();
    if (!loadedAccount) throw Error('本地签名私钥未加载，无法构造交易签名适配器');
    if (!['verified', 'direct_master'].includes(st.authStatus)) {
      throw Error('签名账户授权尚未核对通过（当前状态：' + st.authStatus + '）');
    }
    const transport = new HttpTransport({ isTestnet: st.network === 'testnet' });
    const vaultAddress = st.subAccountAddress || undefined;
    const client = new ExchangeClient({
      wallet: loadedAccount,
      transport,
      ...(vaultAddress ? { defaultVaultAddress: vaultAddress } : {})
    });

    async function resolveAssetIndex(coin) {
      const meta = await queryInfo(st.network, { type: 'meta' });
      const idx = (meta?.universe ?? []).findIndex((u) => u.name === coin);
      if (idx < 0) throw Error('Hyperliquid meta 中未找到永续合约：' + coin);
      return { asset: idx, spec: meta.universe[idx] };
    }

    return {
      network: st.network,
      signerAddress: st.signerAddress,
      tradingAccountAddress: st.tradingAccountAddress,
      subAccountAddress: st.subAccountAddress || null,
      // Official POST /exchange action.type = 'order'
      async placeOrder({ coin, isBuy, size, limitPx, tif = 'Ioc', reduceOnly = false, cloid }) {
        const { asset } = await resolveAssetIndex(coin);
        return client.order({
          orders: [
            {
              a: asset,
              b: Boolean(isBuy),
              p: String(limitPx),
              s: String(size),
              r: Boolean(reduceOnly),
              t: { limit: { tif } },
              ...(cloid ? { c: cloid } : {})
            }
          ],
          grouping: 'na'
        });
      },
      // Reduce/close position with mandatory reduceOnly = true matching opposite direction of currentQty
      async reducePosition({ coin, currentQty, reduceQty, limitPx, tif = 'Ioc' }) {
        const q = Number(currentQty);
        const r = Math.abs(Number(reduceQty));
        if (!Number.isFinite(q) || q === 0) throw Error('当前持仓为 0，无法执行减仓/平仓');
        if (!Number.isFinite(r) || r <= 0 || r > Math.abs(q)) {
          throw Error('减仓数量须大于 0 且不超过当前持仓绝对值');
        }
        return this.placeOrder({
          coin,
          isBuy: q < 0,
          size: String(r),
          limitPx,
          tif,
          reduceOnly: true
        });
      },
      // Official action.type = 'cancel'
      async cancelOrders({ coin, oids }) {
        const { asset } = await resolveAssetIndex(coin);
        return client.cancel({
          cancels: oids.map((oid) => ({ a: asset, o: Number(oid) }))
        });
      },
      // Official action.type = 'modify'
      async modifyOrder({ coin, oid, isBuy, size, limitPx, tif = 'Gtc', reduceOnly = false }) {
        const { asset } = await resolveAssetIndex(coin);
        return client.modify({
          oid: Number(oid),
          order: {
            a: asset,
            b: Boolean(isBuy),
            p: String(limitPx),
            s: String(size),
            r: Boolean(reduceOnly),
            t: { limit: { tif } }
          }
        });
      },
      // Official action.type = 'batchModify'
      async batchModifyOrders({ coin, modifies }) {
        const { asset } = await resolveAssetIndex(coin);
        return client.batchModify({
          modifies: modifies.map((m) => ({
            oid: Number(m.oid),
            order: {
              a: asset,
              b: Boolean(m.isBuy),
              p: String(m.limitPx),
              s: String(m.size),
              r: Boolean(m.reduceOnly),
              t: { limit: { tif: m.tif || 'Gtc' } }
            }
          }))
        });
      },
      // Official action.type = 'updateLeverage'
      async updateLeverage({ coin, isCross = true, leverage }) {
        const { asset } = await resolveAssetIndex(coin);
        const lev = Number(leverage);
        if (!Number.isInteger(lev) || lev < 1) throw Error('杠杆须为正整数');
        return client.updateLeverage({ asset, isCross: Boolean(isCross), leverage: lev });
      }
    };
  }

  return {
    getStatus,
    verifyAndRefresh,
    getExchangeAdapter
  };
}
