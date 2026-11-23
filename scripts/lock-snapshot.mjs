// lock-monitor 快照：在 Pages 构建时运行，读出全部 pPOLY 锁仓（徽章 NFT tokenId → ownerOf → 锁仓合约 getLock），
// 写成精简 JSON，让页面首次打开时先画快照，再用 RPC 刷新。
// 历史曲线 hist 靠「上一次线上快照 + 本次一点」逐次累积，所以基准快照优先读线上已部署的版本。
// 用法：node scripts/lock-snapshot.mjs <输出路径>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || '_site/lock-monitor/snapshot.json';
const REPO_SNAP = 'lock-monitor/snapshot.json';
const LIVE_SNAP = 'https://juiceless.cn/ppoly-lock-monitor/lock-monitor/snapshot.json';

// 与 lock-monitor/index.html 保持一致
const STAKING = '0xde4da55b45c4634517111d3e4fd8f3a39c643bf9';
const BADGE = '0x3507b3ef34998dc87157658432bad694b96927ce';
const PPOLY = '0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6';
const SEL = { ownerOf: '6352211e', getLock: '6b9db4e6', totalLocked: '05a9f274', activeCount: '4ac3a13a', balanceOf: '70a08231' };
const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'];
const BATCH = 40, MISS_LIMIT = 8, HIST_MIN_GAP = 20 * 60, HIST_MAX = 5000;
const V = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (x) => BigInt(x).toString(16).padStart(64, '0');
const call = (to, sel, arg) => ({ to, data: '0x' + sel + (arg === undefined ? '' : pad(arg)) });

// 批量 eth_call；返回与 calls 同序的结果，revert 记为 null
async function batch(calls) {
  let err;
  for (let i = 0; i < 6; i++) {
    const url = RPCS[i % RPCS.length];
    try {
      const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [c, 'latest'] }));
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('batch not supported: ' + JSON.stringify(j).slice(0, 120));
      const out = new Array(calls.length).fill(undefined);
      for (const x of j) {
        if (x.error) {
          if (/revert/i.test(x.error.message || '')) out[x.id] = null;
          else throw new Error(x.error.message || 'rpc error');
        } else out[x.id] = x.result;
      }
      if (out.some((x) => x === undefined)) throw new Error('missing results');
      return out;
    } catch (e) { err = e; await sleep(700 * (i + 1)); }
  }
  throw err;
}

const words = (hex) => { const d = hex.slice(2); const w = []; for (let i = 0; i < d.length; i += 64) w.push(BigInt('0x' + d.slice(i, i + 64))); return w; };
const toNum = (x, dec = 18) => Number(x / 10n ** BigInt(dec - 6)) / 1e6;

async function readLocks() {
  const owners = [];
  let id = 1, misses = 0;
  while (misses < MISS_LIMIT) {
    const ids = Array.from({ length: BATCH }, (_, k) => id + k);
    const res = await batch(ids.map((t) => call(BADGE, SEL.ownerOf, t)));
    for (let k = 0; k < ids.length; k++) {
      if (res[k] === null) { misses++; if (misses >= MISS_LIMIT) break; continue; }
      misses = 0;
      owners.push([ids[k], '0x' + res[k].slice(-40)]);
    }
    id += BATCH;
  }
  const locks = [];
  for (let i = 0; i < owners.length; i += BATCH) {
    const part = owners.slice(i, i + BATCH);
    const res = await batch(part.map(([, o]) => call(STAKING, SEL.getLock, o)));
    part.forEach(([tokenId, owner], k) => {
      if (!res[k]) return;
      // amount, usdtBase, accruedPoints, tokenId, createdAt, lockStart, lockEnd, lastAccrualTime, lockType, convertedAt
      const g = words(res[k]);
      if (g[0] === 0n) return;
      locks.push([tokenId, owner, Number(g[8]), toNum(g[0]), Math.round(toNum(g[1]) * 100) / 100,
        Number(g[4]), Number(g[5]), Number(g[6]), Number(g[9]), Number(g[7])]);
    });
  }
  // 各地址钱包里未锁的 pPOLY
  for (let i = 0; i < locks.length; i += BATCH) {
    const part = locks.slice(i, i + BATCH);
    const res = await batch(part.map((l) => call(PPOLY, SEL.balanceOf, l[1])));
    part.forEach((l, k) => { l[10] = res[k] ? Math.round(toNum(BigInt(res[k])) * 100) / 100 : null; });
  }
  const [tl, ac, bal] = await batch([call(STAKING, SEL.totalLocked), call(STAKING, SEL.activeCount), call(PPOLY, SEL.balanceOf, STAKING)]);
  return { locks, totalLocked: toNum(BigInt(tl)), activeLockCount: Number(BigInt(ac)), contractBalance: toNum(BigInt(bal)) };
}

async function loadBase() {
  try {
    const r = await fetch(LIVE_SNAP + '?t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
    if (r.ok) { const j = await r.json(); if (j.v === V) { console.log(`base: live snapshot @${j.generatedAt}`); return j; } }
  } catch (e) { console.log('base: live snapshot unavailable:', e.message); }
  if (existsSync(REPO_SNAP)) {
    const j = JSON.parse(readFileSync(REPO_SNAP, 'utf8'));
    if (j.v === V) { console.log('base: repo snapshot'); return j; }
  }
  console.log('base: none');
  return null;
}

function write(j) {
  mkdirSync(dirname(OUT), { recursive: true });
  const s = JSON.stringify(j);
  writeFileSync(OUT, s);
  console.log(`wrote ${OUT}: ${j.locks.length} locks, total ${j.totalLocked.toFixed(2)}, hist ${j.hist.length}, ${(s.length / 1024).toFixed(1)} KB`);
}

const base = await loadBase();
try {
  const now = Math.floor(Date.now() / 1000);
  const cur = await readLocks();
  const hist = (base && base.hist) ? base.hist.slice() : [];
  const lastTs = hist.length ? hist[hist.length - 1][0] : 0;
  if (now - lastTs >= HIST_MIN_GAP) hist.push([now, Math.round(cur.totalLocked * 100) / 100, cur.locks.length]);
  write({ v: V, generatedAt: now, ...cur, hist: hist.slice(-HIST_MAX) });
} catch (e) {
  // 拉链失败时原样写出基准快照，避免这次部署把线上快照和历史弄丢
  console.log('fetch error:', e.message);
  if (base) write(base);
  else process.exitCode = 1;
}
