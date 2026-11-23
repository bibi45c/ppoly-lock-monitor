# ppoly-lock-monitor

pPOLY 锁仓看板（非官方）：实时统计 Paimon pPOLY「Unicorn HODLer」锁仓的 BSC 链上数据，包括总锁仓与占比、6 个月锁 / IPO 锁分布、锁仓曲线、单地址锁仓量分布、二级价格、最近锁仓与全部锁仓地址，以及季度回购日程。

线上地址：https://juiceless.cn/ppoly-lock-monitor/lock-monitor/

部署方式沿用 [pages-deploy-template](https://github.com/bibi45c/pages-deploy-template)（`scripts/build.mjs` + `.github/workflows/pages.yml`），推送到 `main` 即自动发布。

## 目录

| 路径 | 说明 |
|---|---|
| `lock-monitor/` | 看板页面（单个 `index.html`，无构建步骤） |
| `scripts/lock-snapshot.mjs` | 锁仓快照：Pages 构建时运行，输出 `_site/lock-monitor/snapshot.json` |
| `scripts/build.mjs` | 模板自带的站点构建脚本 |

## 数据来源

- 锁仓合约：`0xde4da55b45c4634517111d3e4fd8f3a39c643bf9`（BSC，代理，实现未验证源码；ABI 取自 Paimon 前端）
  - `getLock(address)` → amount, usdtBase, accruedPoints, tokenId, createdAt, lockStart, lockEnd, lastAccrualTime, lockType（0 = 6 个月，1 = IPO）, convertedAt
  - `totalLockedAmount()`、`activeLockCount()`
- 徽章 NFT：`0x3507b3ef34998dc87157658432bad694b96927ce`，每个锁仓一枚，tokenId 从 1 递增；逐个 `ownerOf` 得到全部锁仓地址（连续 8 个不存在即停止）
- pPOLY：`0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6`，总量 322,580.65
- 链上读取：`bsc-rpc.publicnode.com` 批量 `eth_call`（备用 `bsc-dataseed.bnbchain.org`）
- 二级价格：DexScreener，取 BSC 上 pPOLY/稳定币池中流动性最大的一个

## 快照

页面打开时先读 `snapshot.json` 画首屏，再直接读链刷新，之后每分钟刷新一次。快照由 Pages 工作流每 30 分钟重建（GitHub 定时任务可能延迟），`hist` 字段在上一次线上快照的基础上追加一点（间隔 ≥ 20 分钟），形成总锁仓的历史记录。

快照字段 `locks` 为列式数组：`[tokenId, owner, lockType, amount, usdtBase, createdAt, lockStart, lockEnd, convertedAt, lastAccrualTime, walletBalance]`（`walletBalance` 为该地址钱包内未锁的 pPOLY；末两列为后加，旧快照可能缺）。

## 本地预览

```bash
node scripts/build.mjs
node scripts/lock-snapshot.mjs _site/lock-monitor/snapshot.json
npx serve _site
```
