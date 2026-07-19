// Base-chain config — replaces the old zkSync Era setup entirely.
// Per-address verification status is noted individually below; this
// project's own established standard (see main README's "fork test
// findings" section) is: confirmed-from-a-primary-source is a starting
// point, not a substitute for your own on-chain re-verification
// (cast call / a real read function) before committing real capital.

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const WS_RPC_URL = process.env.BASE_WS_RPC_URL || null;

module.exports = {
  RPC_URL,
  WS_RPC_URL,
  chainId: 8453,

  tokens: {
    // Base's canonical WETH predeploy — confirmed live via BaseScan
    // (matches the address embedded in Aerodrome's own deployed Router
    // ABI, cross-checked independently).
    WETH: process.env.BASE_WETH || "0x4200000000000000000000000000000000000006",

    // Native USDC on Base (Circle-issued, not a bridged/wrapped variant).
    // NOT hardcoded from memory — set this explicitly and verify on
    // BaseScan/Circle's own docs before use. Left required (no default)
    // deliberately, unlike WETH, since USDC contract addresses are a
    // common target for lookalike/scam token confusion and this project
    // has already been burned once by trusting an address without
    // independent verification.
    USDC: process.env.BASE_USDC || null,
  },

  dexes: {
    // Uniswap V2 Router02 on Base. Confirmed live via BaseScan:
    // 24.2M+ transactions, verified contract, active balance at time of
    // writing. Plain UniswapV2Router shape — works with the existing
    // UniswapV2Adapter unmodified.
    uniswapV2Router: process.env.BASE_UNIV2_ROUTER || "0x4752bA5DBc23f44D87826276BF6Fd6b1C372AD24",

    // Uniswap V2 Factory on Base. Confirmed via Uniswap's own official
    // docs (developers.uniswap.org/docs/protocols/v2/deployments, "Base"
    // row). Used by the new-pool listener for PairCreated events.
    uniswapV2Factory: process.env.BASE_UNIV2_FACTORY || "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",

    // Aerodrome Finance — Base's largest DEX by TVL. Confirmed via the
    // deployed Router contract's own live, verified ABI on BaseScan
    // (3.8M+ transactions, active at time of writing) AND cross-checked
    // against Aerodrome's own GitHub (github.com/aerodrome-finance/contracts).
    // NOT a plain UniswapV2 shape — uses AerodromeAdapter, not
    // UniswapV2Adapter. See contracts/interfaces/IAerodromeRouter.sol for
    // the specific ABI differences.
    aerodromeRouter: process.env.BASE_AERODROME_ROUTER || "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    aerodromeFactory: process.env.BASE_AERODROME_FACTORY || "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  },

  flashLoan: {
    // Aave V3 Pool Proxy on Base. Confirmed live via BaseScan: "Aave: Pool
    // Proxy Base", verified, 1M+ transactions, active balance at time of
    // writing. NOT ERC-3156 shaped — see contracts/interfaces/
    // IAaveV3Flash.sol for the specific callback/function differences from
    // the SyncSwap-based flash contract this replaces.
    aavePool: process.env.BASE_AAVE_POOL || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  },

  // Deployed contract addresses — filled in after you deploy (see
  // scripts/deploy-base.md). Left null so the scanner fails loudly on
  // startup rather than silently pointing at a zero address if you forget
  // to set these post-deployment.
  contracts: {
    triangleArb: process.env.BASE_TRIANGLE_ARB || null,
    triangleArbAaveFlash: process.env.BASE_TRIANGLE_ARB_AAVE_FLASH || null,
    // Per-DEX adapter contracts (deployed once, reused across every scan —
    // NOT the same as the DEX's own router address above; these are this
    // project's own ISwapAdapter-implementing wrapper contracts).
    uniswapV2Adapter: process.env.BASE_UNIV2_ADAPTER || null,
    aerodromeAdapter: process.env.BASE_AERODROME_ADAPTER || null,
  },

  // Same gas-aware minProfit pattern as the original zkSync scanner —
  // live gas price + buffer, recomputed every scan, not a static threshold.
  gasPriceBufferBps: BigInt(process.env.GAS_PRICE_BUFFER_BPS || 2000), // +20%
  minProfitMarginBps: BigInt(process.env.MIN_PROFIT_MARGIN_BPS || 0),
  slippageBps: BigInt(process.env.SLIPPAGE_BPS || 50), // 0.50% per leg

  amountInWei: BigInt(process.env.AMOUNT_IN_WEI || "100000000000000000"), // 0.1 WETH default
};
