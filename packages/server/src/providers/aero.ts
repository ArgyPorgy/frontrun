import { AERO_BASE, CHAINS, D, GUARDRAILS, HOME_CHAIN, fromBaseUnits, stockToken, toBaseUnits, type ExecStep } from "@frontrun/core";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { env } from "../env";
import { encodeApprove, erc20Allowance, evmClient, parseSwapReceipt } from "../onchain";
import { cachedJson } from "../redis";
import { gaslessEnabled } from "../trading/sponsor";
import type { AdvanceResult, ExecContext, ProviderQuote, RouteProvider, RouteRequest, StatusInput, StatusUpdate } from "./types";
import { completedStep } from "./types";

/**
 * Swaps through Aero's concentrated-liquidity pools on Base, where most of the tokenized-stock liquidity sits.
 * Contracts are from Aero's own deployment file (dromos-labs/metadex-slipstream-public, cl-base.json).
 *
 * The swap is the user's own transaction, so it carries the Builder Code. The app's fee is taken the way the
 * Uniswap route takes it: out of what the swap returns, in the same transaction. The router swaps to itself, then
 * sweeps the output to the user and the fee to our wallet. Only Coinbase's stock tokens are routed here for now.
 */

const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const METAQUOTER_ABI = parseAbi([
  "function quoteExactInputSingleV3(address pool, address tokenIn, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)",
]);
export const AERO_ROUTER_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
  "function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

/** The tick spacings Aero's CL factory enables on Base (from its constructor arguments). */
const TICK_SPACINGS = [1, 10, 50, 100, 150, 200, 250] as const;
/** A swap this long after its quote reverts rather than filling at a stale price. */
const DEADLINE_S = 600;

interface AeroRaw {
  pool: string;
  tickSpacing: number;
  amountIn: string;
  /** What the pool returns, before the app's fee. */
  grossOut: string;
  /** The least the swap may return before the fee, or it reverts. */
  grossOutMin: string;
  feeBips: number;
  decimalsOut: number;
}

function usdc(): string {
  return CHAINS[HOME_CHAIN].usdc!;
}

function tokensFor(req: RouteRequest) {
  return req.side === "buy" ? { tokenIn: usdc(), tokenOut: req.address } : { tokenIn: req.address, tokenOut: usdc() };
}

/** USDC pools for a token that hold any liquidity, found once an hour. */
async function poolsFor(token: string): Promise<Array<{ pool: string; tickSpacing: number }>> {
  return cachedJson(`aero:pools:${token.toLowerCase()}`, 3600, async () => {
    const client = evmClient(HOME_CHAIN);
    const found = await client.multicall({
      contracts: TICK_SPACINGS.map((ts) => ({ address: AERO_BASE.clFactory as Hex, abi: FACTORY_ABI, functionName: "getPool" as const, args: [usdc() as Hex, token as Hex, ts] as const })),
      allowFailure: true,
    });
    const pools = TICK_SPACINGS.flatMap((tickSpacing, i) => {
      const r = found[i];
      return r?.status === "success" && r.result !== "0x0000000000000000000000000000000000000000" ? [{ pool: r.result as string, tickSpacing }] : [];
    });
    if (!pools.length) return [];
    const liq = await client.multicall({ contracts: pools.map((p) => ({ address: p.pool as Hex, abi: POOL_ABI, functionName: "liquidity" as const })), allowFailure: true });
    return pools.filter((_, i) => liq[i]?.status === "success" && (liq[i]!.result as bigint) > 0n);
  });
}

function feeBips(): number {
  const bps = env().FLASH_INTEGRATOR_FEE_BPS;
  // The router caps the fee at 1%.
  return env().FEE_RECIPIENT_ADDRESS && bps > 0 ? Math.min(bps, 100) : 0;
}

async function statusFromReceipt(input: StatusInput): Promise<StatusUpdate> {
  if (!input.srcTx) return { status: "failed", error: "No transaction" };
  const receipt = await evmClient(HOME_CHAIN)
    .getTransactionReceipt({ hash: input.srcTx as Hex })
    .catch(() => null);
  if (!receipt) return { status: "pending", srcTx: input.srcTx };
  if (receipt.status === "reverted") return { status: "failed", srcTx: input.srcTx, error: "The swap reverted. Nothing was traded, only gas was spent." };
  const req = input.request;
  const { tokenIn, tokenOut } = tokensFor(req);
  const fill = parseSwapReceipt(receipt, req.evmAddress, tokenIn, tokenOut, HOME_CHAIN);
  const decimals = req.decimals ?? stockToken(req.address)?.decimals ?? 18;
  const usdcAmount = (amount: bigint) => fromBaseUnits(amount, CHAINS[HOME_CHAIN].usdcDecimals);
  const qty = req.side === "buy" ? fromBaseUnits(fill.amountOut, decimals) : fromBaseUnits(fill.amountIn, decimals);
  const usd = req.side === "buy" ? usdcAmount(fill.amountIn) : usdcAmount(fill.amountOut);
  const gasUsd = "0";
  return {
    status: "filled",
    qty,
    ...(req.side === "buy" ? { usdIn: usd } : { usdOut: usd }),
    priceUsd: D(qty).gt(0) ? D(usd).div(qty).toFixed() : undefined,
    feeUsd: input.quote.feeUsd,
    revenueUsd: input.quote.feeUsd,
    extraCostUsd: gasUsd,
    srcTx: input.srcTx,
    dstTx: input.srcTx,
  };
}

export const aeroProvider: RouteProvider = {
  id: "aero",
  enabled: () => true,
  supports: (req) => req.chain === HOME_CHAIN && !req.contra && !!stockToken(req.address),

  async quote(req) {
    const started = Date.now();
    const token = stockToken(req.address)!;
    const { tokenIn } = tokensFor(req);
    const usdcDecimals = CHAINS[HOME_CHAIN].usdcDecimals;
    const amountIn = req.side === "buy" ? toBaseUnits(req.usdcIn!, usdcDecimals) : toBaseUnits(req.qtyIn!, token.decimals);
    const decimalsOut = req.side === "buy" ? token.decimals : usdcDecimals;
    const pools = await poolsFor(req.address);
    if (!pools.length) throw new Error("No Aero pool for this token");
    const client = evmClient(HOME_CHAIN);
    const settled = await Promise.allSettled(
      pools.map(async (p) => {
        const { result } = await client.simulateContract({
          address: AERO_BASE.metaquoter as Hex,
          abi: METAQUOTER_ABI,
          functionName: "quoteExactInputSingleV3",
          args: [p.pool as Hex, tokenIn as Hex, amountIn, 0n],
        });
        return { ...p, amountOut: result[0] };
      }),
    );
    const best = settled
      .flatMap((r) => (r.status === "fulfilled" && r.value.amountOut > 0n ? [r.value] : []))
      .reduce<{ pool: string; tickSpacing: number; amountOut: bigint } | null>((a, b) => (!a || b.amountOut > a.amountOut ? b : a), null);
    if (!best) throw new Error("Aero returned no quote");

    const bips = feeBips();
    const netOut = best.amountOut - (best.amountOut * BigInt(bips)) / 10_000n;
    const out = fromBaseUnits(netOut, decimalsOut);
    const value = req.side === "buy" ? D(out).mul(req.priceUsd) : D(out);
    const notional = D(req.notionalUsd);
    // Impact against the market price, with our fee taken back out so it measures the pool alone.
    const gross = req.side === "buy" ? D(fromBaseUnits(best.amountOut, decimalsOut)).mul(req.priceUsd) : D(fromBaseUnits(best.amountOut, decimalsOut));
    const impact = notional.gt(0) ? Math.max(notional.sub(gross).div(notional).toNumber(), 0) : null;
    const gasUsd = gaslessEnabled() ? "0" : "0.01";
    const raw: AeroRaw = {
      pool: best.pool,
      tickSpacing: best.tickSpacing,
      amountIn: amountIn.toString(),
      grossOut: best.amountOut.toString(),
      grossOutMin: ((best.amountOut * BigInt(Math.round((1 - GUARDRAILS.defaultSlippage) * 10_000))) / 10_000n).toString(),
      feeBips: bips,
      decimalsOut,
    };
    return {
      provider: "aero",
      netOutputUsd: value.sub(gasUsd).toFixed(),
      expectedOut: out,
      feeUsd: notional.mul(bips).div(10_000).toFixed(),
      gasUsd,
      etaSeconds: 2,
      priceImpact: impact,
      recommendedSlippage: null,
      crossChain: false,
      needsSetup: false,
      sponsoredSetup: false,
      latencyMs: Date.now() - started,
      raw,
    } satisfies ProviderQuote;
  },

  async advance(ctx: ExecContext): Promise<AdvanceResult> {
    const raw = ctx.quote.raw as AeroRaw;
    const req = ctx.request;
    const { tokenIn, tokenOut } = tokensFor(req);
    const swapDone = completedStep(ctx, "swap");
    if (swapDone?.txHash) return { done: { srcTx: swapDone.txHash } };

    if (!completedStep(ctx, "approve")) {
      const allowance = await erc20Allowance(HOME_CHAIN, tokenIn, req.evmAddress, AERO_BASE.swapRouter);
      if (allowance < BigInt(raw.amountIn)) {
        // Only this swap's amount, so nothing is left approved afterwards.
        const step: ExecStep = { id: "approve", kind: "evm_tx", chain: HOME_CHAIN, label: "Approve this swap", to: tokenIn, data: encodeApprove(AERO_BASE.swapRouter, BigInt(raw.amountIn)), waitForReceipt: true };
        return { steps: [step] };
      }
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_S);
    const swap = encodeFunctionData({
      abi: AERO_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn as Hex,
          tokenOut: tokenOut as Hex,
          tickSpacing: raw.tickSpacing,
          // The router holds the output for a moment, so the sweep can split it.
          recipient: AERO_BASE.swapRouter as Hex,
          deadline,
          amountIn: BigInt(raw.amountIn),
          amountOutMinimum: BigInt(raw.grossOutMin),
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const feeRecipient = env().FEE_RECIPIENT_ADDRESS;
    const sweep =
      raw.feeBips > 0 && feeRecipient
        ? encodeFunctionData({ abi: AERO_ROUTER_ABI, functionName: "sweepTokenWithFee", args: [tokenOut as Hex, BigInt(raw.grossOutMin), req.evmAddress as Hex, BigInt(raw.feeBips), feeRecipient as Hex] })
        : encodeFunctionData({ abi: AERO_ROUTER_ABI, functionName: "sweepToken", args: [tokenOut as Hex, BigInt(raw.grossOutMin), req.evmAddress as Hex] });
    const data = encodeFunctionData({ abi: AERO_ROUTER_ABI, functionName: "multicall", args: [[swap, sweep]] });
    assertAeroSwap({ to: AERO_BASE.swapRouter, data }, req.evmAddress);
    return { steps: [{ id: "swap", kind: "evm_tx", chain: HOME_CHAIN, label: "Swap", to: AERO_BASE.swapRouter, data, waitForReceipt: false }] };
  },

  status: statusFromReceipt,
};

/**
 * Trade sanity before signing: the call goes to Aero's router, and its sweep pays the user. The signer policy
 * can't read inside a multicall, so this is where a wrong recipient would be caught.
 */
export function assertAeroSwap(tx: { to: string; data: string }, wallet: string) {
  if (tx.to.toLowerCase() !== AERO_BASE.swapRouter.toLowerCase()) throw new Error("Refusing to sign: the swap doesn't target Aero's router.");
  if (!tx.data.toLowerCase().includes(wallet.slice(2).toLowerCase())) throw new Error("Refusing to sign: the swap doesn't pay this wallet.");
}
