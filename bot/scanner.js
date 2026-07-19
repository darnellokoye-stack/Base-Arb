/**
 * Base-chain triangle-arb scanner. Replaces the old zkSync Era scanner.js
 * entirely (SyncSwap/Mute/SpaceFi -> Uniswap V2 + Aerodrome; ERC-3156/
 * SyncSwap flash loans -> Aave V3 flash loans). Same overall pattern
 * (dynamic gas-aware minProfit, startup ABI verification, allowlisted
 * adapters, dry-run-safe estimation) — see this file's function-level
 * comments for what changed and why, not just what stayed the same.
 *
 * Run: node bot/scanner.js            (pre-funded TriangleArb)
 *      FLASH_MODE=1 node bot/scanner.js  (Aave V3 flash-loan-funded)
 */

require("dotenv").config();
const { createPublicClient, createWalletClient, http, formatUnits, encodeAbiParameters } = require("viem");
const { base } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");
const cfg = require("./config");

const FLASH_MODE = !!process.env.FLASH_MODE;

// --- Fail loudly on missing required config, rather than a confusing
// downstream null-address revert later. ---
if (!cfg.tokens.USDC) {
  console.error("FATAL: BASE_USDC env var not set. Verify the address on BaseScan before setting it.");
  process.exit(1);
}
const CONTRACT_ADDRESS = FLASH_MODE ? cfg.contracts.triangleArbAaveFlash : cfg.contracts.triangleArb;
if (!CONTRACT_ADDRESS) {
  console.error(
    `FATAL: ${FLASH_MODE ? "BASE_TRIANGLE_ARB_AAVE_FLASH" : "BASE_TRIANGLE_ARB"} env var not set. ` +
    `Deploy the contract first (see contracts/scripts/deploy-base.md) and set its address.`
  );
  process.exit(1);
}
if (!cfg.contracts.uniswapV2Adapter || !cfg.contracts.aerodromeAdapter) {
  console.error(
    "FATAL: BASE_UNIV2_ADAPTER and/or BASE_AERODROME_ADAPTER env vars not set. " +
    "Deploy both adapter contracts and set their addresses before scanning — " +
    "without them, scanOnce() would build legs pointing at a null adapter address."
  );
  process.exit(1);
}

const UNIV2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ type: "uint256[]" }],
  },
];

const AERODROME_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ type: "uint256[]" }],
  },
  {
    name: "defaultFactory",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const AAVE_POOL_ABI = [
  {
    name: "FLASHLOAN_PREMIUM_TOTAL",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
];

const HOP_COMPONENTS = [
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amountOutMin", type: "uint256" },
  { name: "extraData", type: "bytes" },
];
const LEG_COMPONENTS = [
  { name: "adapter", type: "address" },
  { name: "hops", type: "tuple[]", components: HOP_COMPONENTS },
  { name: "amountOutMin", type: "uint256" },
];

const TRIANGLE_ARB_ABI = [
  {
    name: FLASH_MODE ? "executeTriangleFlash" : "executeTriangle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "legs", type: "tuple[]", components: LEG_COMPONENTS },
      { name: "amountIn", type: "uint256" },
      { name: "minProfit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "profit", type: "uint256" }],
  },
];
const CONTRACT_FUNCTION = FLASH_MODE ? "executeTriangleFlash" : "executeTriangle";

const publicClient = createPublicClient({ chain: base, transport: http(cfg.RPC_URL) });

let walletClient = null;
let account = null;
if (process.env.PRIVATE_KEY) {
  account = privateKeyToAccount(process.env.PRIVATE_KEY);
  walletClient = createWalletClient({ account, chain: base, transport: http(cfg.RPC_URL) });
}

// Same dry-run pattern as the original zkSync scanner: estimateContractGas
// needs a `from` that passes onlyOwner even with no PRIVATE_KEY set.
const ESTIMATION_ACCOUNT = account ? account.address : process.env.OWNER_ADDRESS || null;

function quoteConstantProduct(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

async function quoteUniV2(routerAddress, tokenIn, tokenOut, amountIn) {
  try {
    const amounts = await publicClient.readContract({
      address: routerAddress,
      abi: UNIV2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    });
    return amounts[amounts.length - 1];
  } catch (err) {
    throw new Error(
      `Uniswap V2 router at ${routerAddress} rejected getAmountsOut() — verify ` +
      `BASE_UNIV2_ROUTER on BaseScan before trusting it. Underlying error: ` +
      `${err.shortMessage || err.message}`
    );
  }
}

/// Aerodrome quoting requires knowing whether to route through the stable
/// or volatile pool for a given pair — unlike UniV2, both can coexist for
/// the same token pair with genuinely different reserves/pricing. This
/// tries volatile first (the common case for a WETH/new-token pair) and
/// falls back to stable only if the volatile route reverts (e.g. no
/// volatile pool exists for this pair). This is a heuristic, not a
/// guarantee of the BEST route — a thorough scanner would quote both and
/// take the better one; left as a documented simplification rather than
/// silently picking one without explanation.
async function quoteAerodrome(routerAddress, tokenIn, tokenOut, amountIn, factory) {
  const tryRoute = async (stable) => {
    const amounts = await publicClient.readContract({
      address: routerAddress,
      abi: AERODROME_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [{ from: tokenIn, to: tokenOut, stable, factory }]],
    });
    return amounts[amounts.length - 1];
  };

  try {
    return { amountOut: await tryRoute(false), stable: false };
  } catch (volatileErr) {
    try {
      return { amountOut: await tryRoute(true), stable: true };
    } catch (stableErr) {
      throw new Error(
        `Aerodrome router at ${routerAddress} rejected getAmountsOut() for both ` +
        `stable and volatile routes on ${tokenIn} -> ${tokenOut}. Volatile error: ` +
        `${volatileErr.shortMessage || volatileErr.message}. Stable error: ` +
        `${stableErr.shortMessage || stableErr.message}`
      );
    }
  }
}

/// Startup check: confirms both configured DEX routers actually respond to
/// their expected ABI shape, before the scan loop starts — same
/// fail-loud-and-early philosophy as the original zkSync scanner's
/// verifyThirdDexAbiOrExit, extended to cover both Base DEXs since neither
/// address has been re-verified on-chain by THIS specific deployment yet
/// (only cross-checked against external sources during setup).
async function verifyDexAbisOrExit() {
  const probeAmount = 10n ** 15n; // trivial size, purely to confirm the call succeeds
  try {
    await quoteUniV2(cfg.dexes.uniswapV2Router, cfg.tokens.WETH, cfg.tokens.USDC, probeAmount);
    console.log(`Uniswap V2 router ${cfg.dexes.uniswapV2Router} responds correctly — OK.`);
  } catch (err) {
    console.error(`\nSTARTUP CHECK FAILED (Uniswap V2):\n${err.message}\n`);
    process.exit(1);
  }

  try {
    const factory = cfg.dexes.aerodromeFactory;
    await quoteAerodrome(cfg.dexes.aerodromeRouter, cfg.tokens.WETH, cfg.tokens.USDC, probeAmount, factory);
    console.log(`Aerodrome router ${cfg.dexes.aerodromeRouter} responds correctly — OK.`);
  } catch (err) {
    console.error(`\nSTARTUP CHECK FAILED (Aerodrome):\n${err.message}\n`);
    process.exit(1);
  }
}

/// Aave V3 has no ERC-3156-style maxFlashLoan() view function. The
/// documented mechanism (Aave's own flash loan docs) is simpler: a
/// single-asset flashLoanSimple() can borrow up to the Pool's own token
/// balance for that asset (assuming the asset isn't paused/frozen for
/// flash loans, which isn't checked here — a genuinely thorough version
/// would also read the reserve's configuration flags via the Pool's
/// getReserveData, left as a further TODO). This checks the simpler,
/// more common failure mode: is there even enough of the token sitting in
/// the Pool to satisfy this specific loan size.
async function checkFlashLoanCapacity(startToken, amountIn) {
  const ERC20_BALANCE_ABI = [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ];
  try {
    const poolBalance = await publicClient.readContract({
      address: startToken,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [cfg.flashLoan.aavePool],
    });
    return poolBalance >= amountIn;
  } catch (err) {
    console.error("Aave pool balance check failed:", err.shortMessage || err.message);
    return false; // fail closed
  }
}

async function getAaveFlashPremium(amountIn) {
  const premiumBps = await publicClient.readContract({
    address: cfg.flashLoan.aavePool,
    abi: AAVE_POOL_ABI,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
  });
  return {
    premiumBps,
    premium: (amountIn * premiumBps) / 10000n,
  };
}

function applySlippageFloor(amount) {
  return (amount * (10000n - cfg.slippageBps)) / 10000n;
}

async function gasCostInStartToken(legs, amountIn, minProfitGuess, startToken) {
  if (!ESTIMATION_ACCOUNT) {
    throw new Error(
      "No PRIVATE_KEY or OWNER_ADDRESS set — cannot estimate gas (estimateContractGas " +
      "needs a `from` that passes the contract's onlyOwner check). Set one of these env vars."
    );
  }
  const gasPrice = await publicClient.getGasPrice();
  const bufferedGasPrice = (gasPrice * (10000n + cfg.gasPriceBufferBps)) / 10000n;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const gasUnits = await publicClient.estimateContractGas({
    address: CONTRACT_ADDRESS,
    abi: TRIANGLE_ARB_ABI,
    functionName: CONTRACT_FUNCTION,
    args: [legs, amountIn, minProfitGuess, deadline],
    account: ESTIMATION_ACCOUNT,
  });

  const gasCostWei = gasUnits * bufferedGasPrice;

  // gasCostWei is denominated in ETH; if startToken isn't WETH, this
  // module doesn't do a unit conversion (same limitation the original
  // zkSync scanner had) — this assumes startToken IS WETH, which matches
  // this project's WETH-anchored triangle design throughout. Flag loudly
  // rather than silently returning a wrong-unit number if that assumption
  // ever changes.
  if (startToken.toLowerCase() !== cfg.tokens.WETH.toLowerCase()) {
    throw new Error(
      "gasCostInStartToken assumes startToken is WETH (gas is paid in ETH); " +
      `got startToken=${startToken}. Add a real ETH->startToken conversion ` +
      "before using this with a non-WETH-denominated triangle."
    );
  }

  return gasCostWei;
}

async function simulateExecution(legs, amountIn, minProfit) {
  if (!ESTIMATION_ACCOUNT) {
    throw new Error(
      "No PRIVATE_KEY or OWNER_ADDRESS set â€” cannot simulate execution " +
      "(the eth_call needs a `from` that passes onlyOwner)."
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const simulation = await publicClient.simulateContract({
    address: CONTRACT_ADDRESS,
    abi: TRIANGLE_ARB_ABI,
    functionName: CONTRACT_FUNCTION,
    args: [legs, amountIn, minProfit, deadline],
    account: ESTIMATION_ACCOUNT,
  });

  return simulation.result;
}

function legsUseFlashLenderProtocol(legs) {
  // Placeholder allowlist check mirroring the old SyncSwap-specific guard.
  // No equivalent Aave-V3-reentrancy conflict has been confirmed for Base
  // yet (see TriangleArbAaveFlash.sol's header comment) — this currently
  // always returns false until fork-testing proves otherwise. Do not
  // remove this function; wire in a real check the moment a conflict is
  // found, the same way the original SyncSwap conflict was discovered and
  // documented rather than assumed away.
  return false;
}

async function submit(legs, amountIn, minProfit) {
  if (!walletClient) {
    console.log(">>> [DRY RUN] would submit — no PRIVATE_KEY set, not sending a transaction.");
    return;
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: TRIANGLE_ARB_ABI,
    functionName: CONTRACT_FUNCTION,
    args: [legs, amountIn, minProfit, deadline],
  });
  console.log(`submitted: ${hash}`);
}

async function scanOnce() {
  const amountIn = cfg.amountInWei;
  const startToken = cfg.tokens.WETH;

  // Triangle: WETH -> USDC (Uniswap V2) -> WETH (Aerodrome). A genuinely
  // 3-DEX triangle needs a third distinct venue for a real middle leg;
  // this 2-DEX round trip is left as the minimal working example — extend
  // with a third router once you've identified and verified one (see this
  // project's README for the standard this repo holds itself to before
  // trusting any DEX address).
  let usdcOut, wethBack, aerodromeStable;
  try {
    usdcOut = await quoteUniV2(cfg.dexes.uniswapV2Router, cfg.tokens.WETH, cfg.tokens.USDC, amountIn);
    const aeroQuote = await quoteAerodrome(
      cfg.dexes.aerodromeRouter,
      cfg.tokens.USDC,
      cfg.tokens.WETH,
      usdcOut,
      cfg.dexes.aerodromeFactory
    );
    wethBack = aeroQuote.amountOut;
    aerodromeStable = aeroQuote.stable;
  } catch (err) {
    console.error("quote error:", err.message);
    return;
  }

  const usdcOutMin = applySlippageFloor(usdcOut);
  const wethBackMin = applySlippageFloor(wethBack);

  const legs = [
    {
      adapter: cfg.contracts.uniswapV2Adapter,
      hops: [{
        tokenIn: cfg.tokens.WETH,
        tokenOut: cfg.tokens.USDC,
        amountOutMin: usdcOutMin,
        extraData: "0x",
      }],
      amountOutMin: usdcOutMin,
    },
    {
      adapter: cfg.contracts.aerodromeAdapter,
      hops: [{
        tokenIn: cfg.tokens.USDC,
        tokenOut: cfg.tokens.WETH,
        amountOutMin: wethBackMin,
        // abi.encode(bool stable, address factory) — see AerodromeAdapter.sol
        extraData: encodeAerodromeExtraData(aerodromeStable, cfg.dexes.aerodromeFactory),
      }],
      amountOutMin: wethBackMin,
    },
  ];

  let flashPremium = 0n;
  let flashPremiumBps = 0n;
  if (FLASH_MODE) {
    try {
      const flashFee = await getAaveFlashPremium(amountIn);
      flashPremium = flashFee.premium;
      flashPremiumBps = flashFee.premiumBps;
    } catch (err) {
      console.error("Aave flash premium read failed:", err.shortMessage || err.message);
      return;
    }
  }

  const grossProfit = wethBack > amountIn ? wethBack - amountIn : 0n;
  const netProfitBeforeGas = grossProfit > flashPremium ? grossProfit - flashPremium : 0n;

  if (FLASH_MODE && netProfitBeforeGas === 0n) {
    console.log(
      `[${new Date().toISOString()}] ${formatUnits(amountIn, 18)} WETH -> ` +
      `${formatUnits(usdcOut, 6)} USDC -> ${formatUnits(wethBack, 18)} WETH | ` +
      `gross=${formatUnits(grossProfit, 18)} flashFee=${formatUnits(flashPremium, 18)} ` +
      `netBeforeGas=0 below floor`
    );
    return;
  }

  let gasCost;
  try {
    gasCost = await gasCostInStartToken(legs, amountIn, 0n, startToken);
  } catch (err) {
    console.error("gas estimation error (likely unprofitable or a revert upstream):", err.message);
    return;
  }

  const requiredProfit = gasCost + (gasCost * cfg.minProfitMarginBps) / 10000n;
  const profitable = netProfitBeforeGas >= requiredProfit;

  console.log(
    `[${new Date().toISOString()}] ${formatUnits(amountIn, 18)} WETH -> ` +
    `${formatUnits(usdcOut, 6)} USDC -> ${formatUnits(wethBack, 18)} WETH | ` +
    `gross=${formatUnits(grossProfit, 18)} ` +
    `flashFee=${formatUnits(flashPremium, 18)}(${flashPremiumBps}bps) ` +
    `netBeforeGas=${formatUnits(netProfitBeforeGas, 18)} ` +
    `gasFloor=${formatUnits(requiredProfit, 18)} ` +
    `slippage=${cfg.slippageBps}bps ` +
    `${profitable ? "PROFITABLE" : "below floor"}`
  );

  if (!profitable) return;

  if (FLASH_MODE) {
    const hasCapacity = await checkFlashLoanCapacity(startToken, amountIn);
    if (!hasCapacity) {
      console.log("Aave pool lacks capacity for this loan size — skipping.");
      return;
    }
    if (legsUseFlashLenderProtocol(legs)) {
      console.log("legs route through the flash lender's own protocol — skipping (see legsUseFlashLenderProtocol).");
      return;
    }
  }

  try {
    const simulatedProfit = await simulateExecution(legs, amountIn, requiredProfit);
    console.log(`simulation OK: contract profit=${formatUnits(simulatedProfit, 18)} WETH`);
  } catch (err) {
    console.error("simulation rejected exact calldata:", err.shortMessage || err.message);
    return;
  }

  await submit(legs, amountIn, requiredProfit);
}

function encodeAerodromeExtraData(stable, factory) {
  // Real ABI encoding via viem, matching AerodromeAdapter.sol's
  // abi.decode(hops[i].extraData, (bool, address)) exactly.
  return encodeAbiParameters(
    [{ type: "bool" }, { type: "address" }],
    [stable, factory]
  );
}

async function main() {
  await verifyDexAbisOrExit();
  console.log(`Starting Base scanner (${FLASH_MODE ? "FLASH" : "pre-funded"} mode) against ${CONTRACT_ADDRESS}...`);
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS || 3000);
  setInterval(() => {
    scanOnce().catch((err) => console.error("scan error:", err.message));
  }, intervalMs);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
