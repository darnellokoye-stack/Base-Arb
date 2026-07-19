# Base Triangle Arbitrage

Atomic multi-leg swap (A → B → ... → A) across DEX adapters on Base, in
either a pre-funded or flash-loan-funded flavor, plus an off-chain scanner
that watches quotes, computes a live gas-aware profit floor, and fires the
trade when profitable.

**This project was migrated from zkSync Era to Base in full.** The zkSync
Era version (SyncSwap/Mute/SpaceFi adapters, ERC-3156 flash loans against
SyncSwap's Vault, and all the fork-testing history that went with it) is
preserved in `test/_archived-zksync/` — including the original README
(`README-zksync-era.md`) — rather than deleted, since it's a real record of
what was confirmed and how. Nothing in `test/_archived-zksync/` is wired
into the current build.

## What's verified vs. what you must verify yourself

**Confirmed against live, verified Base contracts (via BaseScan and/or the
protocol's own official docs/GitHub) during this migration:**
- Uniswap V2 Router02 on Base: `0x4752bA5DBc23f44D87826276BF6Fd6b1C372AD24`
  — verified contract, 24M+ transactions, confirmed via BaseScan
- Uniswap V2 Factory on Base: `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`
  — confirmed via Uniswap's own official docs
  (developers.uniswap.org/docs/protocols/v2/deployments)
- Aerodrome Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` — confirmed
  via the deployed contract's own live, verified ABI on BaseScan (3.8M+
  transactions) AND cross-checked against Aerodrome's own GitHub
  (github.com/aerodrome-finance/contracts)
- Aerodrome PoolFactory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` —
  same two-source cross-check
- Aave V3 Pool Proxy on Base: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
  — confirmed via BaseScan, verified, 1M+ transactions
- Base's canonical WETH predeploy: `0x4200000000000000000000000000000000000006`

**Fork-tested, but not live-deployed or live-exercised with your own
capital yet:**
- Base fork tests execute real Uniswap V2 and Aerodrome swaps against live
  Base state.
- `TriangleArbAaveFlash` is fork-tested against Aave V3 on Base, including
  a bare WETH flash-loan probe and a flash-loan-backed leg chain. Foundry is
  pinned to `evm_version = "cancun"` because Aave's current Base
  implementation uses opcodes that older fork EVM settings report as
  `NotActivated`.
- No production deployment from this repo has been funded and sent by the
  bot yet. Treat fork success as integration proof, not proof that a live
  opportunity is profitable or safe to submit publicly.
- `AerodromeAdapter`'s stable-vs-volatile route selection
  (`quoteAerodrome` in `bot/scanner.js`) is a documented heuristic (try
  volatile, fall back to stable), not a "best route" guarantee — a thorough
  version would quote both and take the better one.
- USDC address on Base is deliberately left unset (`BASE_USDC` env var,
  no default) — verify it yourself on BaseScan/Circle's docs before use,
  the same discipline this project applied to zkSync's USDT address.

## Architecture

- `contracts/TriangleArbBase.sol` — shared owner/allowlist/leg-execution
  logic, chain-agnostic, unchanged from the zkSync version
- `contracts/TriangleArb.sol` — pre-funded variant, chain-agnostic,
  unchanged
- `contracts/TriangleArbAaveFlash.sol` — flash-loan-funded variant,
  **new**, replaces the old SyncSwap/ERC-3156-based `TriangleArbFlash.sol`
  because Aave V3's flash loan interface is NOT ERC-3156 (different
  function names, different callback signature — see
  `contracts/interfaces/IAaveV3Flash.sol` for specifics)
- `contracts/adapters/UniswapV2Adapter.sol` — unchanged, works against
  Base's Uniswap V2 fork since it's genuinely UniV2-shaped
- `contracts/adapters/AerodromeAdapter.sol` — **new**, required because
  Aerodrome's Router takes a `Route[]` struct (from/to/stable/factory),
  not a plain `address[]` path, despite being a UniV2-derived DEX
- `bot/config.js` / `bot/scanner.js` — fully rewritten for Base (see
  inline comments for what changed and why)
- `bot/base-edges/` — the solo-dev "edges" work (new-pool discovery,
  small-trade sweeping); see `bot/base-edges/README.md` for status

## Deploying

Prep-only — this repo does not deploy on your behalf. See
`contracts/scripts/deploy-base.md` for the full checklist, including the
on-chain re-verification step you should run before trusting any address
in this README with real capital.

## Running the scanner

```bash
npm install
BASE_USDC=0x...                  # verify first, see above
BASE_TRIANGLE_ARB=0x...          # from deployment
BASE_UNIV2_ADAPTER=0x...
BASE_AERODROME_ADAPTER=0x...
PRIVATE_KEY=0x...                # omit to dry-run only
OWNER_ADDRESS=0x...              # required for dry-run gas/simulation if PRIVATE_KEY is omitted
SLIPPAGE_BPS=50                  # optional, per-leg output floor buffer; default 0.50%
BASE_TRIANGLE_TOKENS=0x...,0x... # extra middle-token universe for WETH -> A -> B -> WETH routes
MAX_ROUTE_CANDIDATES=50          # max quoted candidates evaluated per scan cycle
npm run scan                     # pre-funded mode
npm run scan:flash               # Aave V3 flash-loan mode
```

In flash mode, the scanner now reads Aave's live
`FLASHLOAN_PREMIUM_TOTAL()`, subtracts the flash premium from quote P&L,
adds the gas-aware profit floor, applies per-leg slippage floors to the
exact calldata, and runs an `eth_call` simulation before any transaction is
submitted. If the exact calldata cannot clear the contract's
`minProfit` guard, it is skipped.

The scanner generates real 3-hop candidate cycles:
`WETH -> tokenA -> tokenB -> WETH`. `BASE_USDC` is included automatically;
add at least one more verified token address in `BASE_TRIANGLE_TOKENS` for
real triangles. Each hop is quoted against both Uniswap V2 and Aerodrome,
then the best candidates are gas/simulation checked.

Backrun monitoring is dry-run only:

```bash
BASE_WS_RPC_URL=wss://...
npm run backrun:watch
```

It decodes pending swaps against the configured Uniswap V2 and Aerodrome
routers and reports impacted paths. It does not submit transactions. Real
backrunning should be wired to private bundle/post-victim simulation first;
public mempool submission is not a production-safe path.

## The solo-dev edges (Base-specific angle, separate from the core
migration above)

1. New-pool listener — built, discovery-only (see `bot/base-edges/`)
2. Small-trade size sweep — built, quote/math verified, execution still a
   dry-run stub pending real gas estimates from a deployed contract
3. Private submission via a Base builder/relay — not started
4. Non-obvious token triangles — not started
5. Backrunning — not started

See `bot/base-edges/README.md` for the honest per-edge status.
