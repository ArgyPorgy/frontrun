import {
  ARC_USDC,
  CHAINS,
  D,
  GUARDRAILS,
  HOME_CHAIN,
  PERMIT2,
  UNISWAP_ARC,
  UNISWAP_ROUTERS,
  type ChainKey,
  fromBaseUnits,
  toBaseUnits,
  usdc6ToArcNative,
  type ExecStep,
} from "@frontrun/core";
import { encodeFunctionData, type Hex } from "viem";
import { env } from "../env";
import { fetchJson } from "../http";
import {
  QUOTER_V2_ABI,
  SWAP_ROUTER_02_ABI,
  encodeApprove,
  erc20Allowance,
  erc20Decimals,
  evmClient,
  parseSwapReceipt,
} from "../onchain";
import type { AdvanceResult, ExecContext, ProviderQuote, RouteProvider, RouteRequest, StatusInput, StatusUpdate } from "./types";
import { gaslessEnabled } from "../trading/sponsor";
import { completedStep } from "./types";

const API = "https://trade-api.gateway.uniswap.org/v1";

/**
 * Same-chain swaps through Uniswap, on the home chain.
 *
 * `uniswapProvider` uses the Trading API (quote, Permit2 signature, swap transaction). The swap is sent
 * from the user's own wallet, so it carries Front Run's Builder Code.
 * `uniswapDirectProvider` calls QuoterV2 and SwapRouter02 on Arc directly, and stays for Arc.
 */
function usdcOn(chain: ChainKey): string {
  return chain === "arc" ? ARC_USDC : CHAINS[chain].usdc!;
}

function tokensFor(req: RouteRequest) {
  const usdc = usdcOn(req.chain);
  return req.side === "buy" ? { tokenIn: usdc, tokenOut: req.address } : { tokenIn: req.address, tokenOut: usdc };
}

async function resolveDecimals(req: RouteRequest): Promise<number> {
  return req.decimals ?? erc20Decimals(req.chain, req.address);
}

function apiHeaders(chain: ChainKey) {
  return { "x-api-key": env().UNISWAP_API_KEY ?? "", "x-universal-router-version": UNISWAP_ROUTERS[chain]?.version ?? "2.0" };
}

interface UniswapQuoteResponse {
  routing: string;
  /** False on Arc buys: USDC is the native gas token, so it's paid as value with nothing to approve. */
  isTokenApprovalApplicable?: boolean;
  quote: {
    output?: { amount?: string };
    aggregatedOutputs?: Array<{ amount: string; recipient: string; fee?: string }>;
    gasFeeUSD?: string;
    priceImpact?: number | string;
  };
  permitData?: { domain: unknown; types: Record<string, unknown>; values: unknown } | null;
}

interface UniswapRaw {
  response: UniswapQuoteResponse;
  amountIn: string;
  decimalsOut: number;
}

function typedDataFromPermit(permit: NonNullable<UniswapQuoteResponse["permitData"]>): string {
  const types = { ...permit.types };
  const primaryType = Object.keys(types).find((k) => k !== "EIP712Domain" && k !== "PermitDetails" && k !== "TokenPermissions") ?? "PermitSingle";
  // Uniswap leaves out the domain type, which Privy's signer expects to be spelled out.
  if (!types.EIP712Domain) {
    const domain = permit.domain as Record<string, unknown>;
    const fields: Array<[string, string]> = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];
    types.EIP712Domain = fields.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({ name, type }));
  }
  return JSON.stringify({ domain: permit.domain, types, primaryType, message: permit.values });
}

/**
 * Trade sanity, run before a swap is signed. On a buy the value is the whole USDC amount, at 18 decimals,
 * so a wrong value here would spend the wrong amount, and the signer policy can't see that.
 */
export function assertSwapMatches(tx: { to: string; value?: string }, expected: { amountIn: bigint; nativeInput: boolean; chain?: ChainKey }) {
  const router = UNISWAP_ROUTERS[expected.chain ?? "arc"]?.router;
  if (!router || tx.to.toLowerCase() !== router.toLowerCase()) {
    throw new Error("Refusing to sign: the swap doesn't target the Universal Router.");
  }
  const value = BigInt(tx.value ?? 0);
  // Only Arc pays for a buy in native USDC. Everywhere else the swap carries no value.
  const wanted = expected.nativeInput && (expected.chain ?? "arc") === "arc" ? usdc6ToArcNative(expected.amountIn) : 0n;
  if (value !== wanted) throw new Error("Refusing to sign: the swap's value doesn't match the quote.");
}

async function statusFromReceipt(input: StatusInput): Promise<StatusUpdate> {
  if (!input.srcTx) return { status: "failed", error: "No transaction" };
  const receipt = await evmClient(input.request.chain)
    .getTransactionReceipt({ hash: input.srcTx as Hex })
    .catch(() => null);
  if (!receipt) return { status: "pending", srcTx: input.srcTx };
  if (receipt.status === "reverted") return { status: "failed", srcTx: input.srcTx, error: "The swap reverted. Nothing was traded, only gas was spent." };
  const req = input.request;
  const { tokenIn, tokenOut } = tokensFor(req);
  const fill = parseSwapReceipt(receipt, req.evmAddress, tokenIn, tokenOut, req.chain);
  const decimals = await resolveDecimals(req);
  const usdc = (amount: bigint) => fromBaseUnits(amount, CHAINS[req.chain].usdcDecimals);
  // Arc's gas is USDC. Elsewhere it's the native coin, and a sponsored swap's gas was never the user's.
  const gasUsd = req.chain === "arc" ? fromBaseUnits(fill.gasNative, 18) : "0";
  const token = (amount: bigint) => fromBaseUnits(amount, decimals);
  const qty = req.side === "buy" ? token(fill.amountOut) : token(fill.amountIn);
  const usd = req.side === "buy" ? usdc(fill.amountIn) : usdc(fill.amountOut);
  return {
    status: "filled",
    qty,
    ...(req.side === "buy" ? { usdIn: usd } : { usdOut: usd }),
    priceUsd: D(qty).gt(0) ? D(usd).div(qty).toFixed() : undefined,
    feeUsd: gasUsd,
    // Only the routed quote carries the app's fee. A direct swap's feeUsd is the pool's own.
    revenueUsd: input.quote.provider === "uniswap" ? input.quote.feeUsd : "0",
    extraCostUsd: gasUsd,
    srcTx: input.srcTx,
    dstTx: input.srcTx,
  };
}

function valueOut(req: RouteRequest, out: string): string {
  return req.side === "buy" ? D(out).mul(req.priceUsd).toFixed() : out;
}

export const uniswapProvider: RouteProvider = {
  id: "uniswap",
  enabled: () => !!env().UNISWAP_API_KEY,
  supports: (req) => req.chain === HOME_CHAIN && !req.contra,

  async quote(req, signal) {
    const started = Date.now();
    const decimals = await resolveDecimals(req);
    const { tokenIn, tokenOut } = tokensFor(req);
    const usdcDecimals = CHAINS[req.chain].usdcDecimals;
    const chainId = CHAINS[req.chain].chainId!;
    const amountIn = req.side === "buy" ? toBaseUnits(req.usdcIn!, usdcDecimals) : toBaseUnits(req.qtyIn!, decimals);
    const decimalsOut = req.side === "buy" ? decimals : usdcDecimals;
    const { FLASH_INTEGRATOR_FEE_BPS: feeBps, FEE_RECIPIENT_ADDRESS: feeRecipient } = env();
    const response = await fetchJson<UniswapQuoteResponse>(`${API}/quote`, {
      method: "POST",
      headers: apiHeaders(req.chain),
      body: {
        type: "EXACT_INPUT",
        tokenIn,
        tokenOut,
        tokenInChainId: chainId,
        tokenOutChainId: chainId,
        amount: amountIn.toString(),
        swapper: req.evmAddress,
        slippageTolerance: GUARDRAILS.defaultSlippage * 100,
        routingPreference: "BEST_PRICE",
        // AMM pools only: UniswapX fills come from a filler's transaction, not the user's, so they couldn't carry our Builder Code.
        protocols: ["V2", "V3", "V4"],
        ...(feeBps > 0 && feeRecipient ? { integratorFees: [{ bips: feeBps, recipient: feeRecipient }] } : {}),
      },
      timeoutMs: 4_000,
      signal,
    });
    if (response.routing !== "CLASSIC") throw new Error(`Unsupported Uniswap routing: ${response.routing}`);
    // With a fee, `output` stays gross and the split is in aggregatedOutputs. The user gets their own line.
    const swapper = req.evmAddress.toLowerCase();
    const outRaw = response.quote.aggregatedOutputs?.find((o) => o.recipient.toLowerCase() === swapper)?.amount ?? response.quote.output?.amount;
    if (!outRaw) throw new Error("Uniswap returned no output amount");
    const charged = response.quote.aggregatedOutputs?.some((o) => o.fee === "INTEGRATOR");
    const out = fromBaseUnits(BigInt(outRaw), decimalsOut);
    const gas = gaslessEnabled() ? "0" : (response.quote.gasFeeUSD ?? "0");
    const impact = response.quote.priceImpact != null ? Number(response.quote.priceImpact) / 100 : null;
    const raw: UniswapRaw = { response, amountIn: amountIn.toString(), decimalsOut };
    return {
      provider: "uniswap",
      netOutputUsd: D(valueOut(req, out)).sub(gas).toFixed(),
      expectedOut: out,
      feeUsd: charged ? D(req.notionalUsd).mul(feeBps).div(10_000).toFixed() : "0",
      gasUsd: gas,
      etaSeconds: 2,
      priceImpact: impact,
      recommendedSlippage: null,
      crossChain: false,
      needsSetup: !!response.permitData,
      sponsoredSetup: false,
      latencyMs: Date.now() - started,
      raw,
    } satisfies ProviderQuote;
  },

  async advance(ctx: ExecContext): Promise<AdvanceResult> {
    const raw = ctx.quote.raw as UniswapRaw;
    const req = ctx.request;
    const { tokenIn } = tokensFor(req);

    const swapDone = completedStep(ctx, "swap");
    if (swapDone?.txHash) return { done: { srcTx: swapDone.txHash } };

    // Per Uniswap's spec, a missing flag means an approval may be needed. An Arc buy says it isn't.
    const nativeInput = raw.response.isTokenApprovalApplicable === false;
    if (!nativeInput && !completedStep(ctx, "approve")) {
      const allowance = await erc20Allowance(req.chain, tokenIn, req.evmAddress, PERMIT2);
      if (allowance < BigInt(raw.amountIn)) {
        // Permit2 needs one standing approval. After that every swap is signature-only.
        const step: ExecStep = {
          id: "approve",
          kind: "evm_tx",
          chain: req.chain,
          label: "Approve once",
          to: tokenIn,
          data: encodeApprove(PERMIT2, 2n ** 256n - 1n),
          waitForReceipt: true,
        };
        return { steps: [step] };
      }
    }
    const permit = raw.response.permitData;
    if (permit && !completedStep(ctx, "permit")) {
      return {
        steps: [{ id: "permit", kind: "evm_typed_data", chain: req.chain, label: "Sign swap", typedData: typedDataFromPermit(permit) }],
      };
    }
    const swap = await fetchJson<{ swap: { to: string; data: string; value?: string } }>(`${API}/swap`, {
      method: "POST",
      headers: apiHeaders(req.chain),
      body: {
        quote: raw.response.quote,
        ...(permit ? { permitData: permit, signature: completedStep(ctx, "permit")?.signature } : {}),
      },
      timeoutMs: 8_000,
    });
    assertSwapMatches(swap.swap, { amountIn: BigInt(raw.amountIn), nativeInput, chain: req.chain });
    return {
      steps: [
        {
          id: "swap",
          kind: "evm_tx",
          chain: req.chain,
          label: "Swap",
          to: swap.swap.to,
          data: swap.swap.data,
          value: swap.swap.value,
          waitForReceipt: false,
        },
      ],
    };
  },

  status: statusFromReceipt,
};

const FEE_TIERS = [100, 500, 3000, 10000] as const;

interface DirectRaw {
  fee: number;
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  decimalsOut: number;
  gasEstimate: string;
}

export const uniswapDirectProvider: RouteProvider = {
  id: "uniswap_direct",
  // Stands in when there's no Trading API key.
  enabled: () => !env().UNISWAP_API_KEY,
  supports: (req) => req.chain === "arc" && req.contra?.chain === "arc",

  async quote(req) {
    const started = Date.now();
    const decimals = await resolveDecimals(req);
    const { tokenIn, tokenOut } = tokensFor(req);
    const amountIn = req.side === "buy" ? toBaseUnits(req.usdcIn!, CHAINS.arc.usdcDecimals) : toBaseUnits(req.qtyIn!, decimals);
    const decimalsOut = req.side === "buy" ? decimals : CHAINS.arc.usdcDecimals;
    const client = evmClient("arc");
    const settled = await Promise.allSettled(
      FEE_TIERS.map(async (fee) => {
        const { result } = await client.simulateContract({
          address: UNISWAP_ARC.v3QuoterV2 as Hex,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: tokenIn as Hex, tokenOut: tokenOut as Hex, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return { fee, amountOut: result[0], gasEstimate: result[3] };
      }),
    );
    const best = settled
      .flatMap((r) => (r.status === "fulfilled" && r.value.amountOut > 0n ? [r.value] : []))
      .reduce<{ fee: number; amountOut: bigint; gasEstimate: bigint } | null>((a, b) => (!a || b.amountOut > a.amountOut ? b : a), null);
    if (!best) throw new Error("No Uniswap v3 pool for this pair on Arc");
    const out = fromBaseUnits(best.amountOut, decimalsOut);
    // Arc gas sits at the 20 gwei floor and is paid in USDC with 18 decimals.
    const gasUnits = best.gasEstimate + 60_000n;
    const gasUsd = fromBaseUnits(gasUnits * 20_000_000_000n, 18);
    const notional = D(req.notionalUsd);
    const value = D(valueOut(req, out));
    const impact = notional.gt(0) ? Math.max(notional.sub(value).div(notional).toNumber(), 0) : null;
    const minOut = (best.amountOut * BigInt(Math.round((1 - GUARDRAILS.defaultSlippage) * 10_000))) / 10_000n;
    const raw: DirectRaw = {
      fee: best.fee,
      amountIn: amountIn.toString(),
      amountOut: best.amountOut.toString(),
      amountOutMin: minOut.toString(),
      decimalsOut,
      gasEstimate: gasUnits.toString(),
    };
    return {
      provider: "uniswap_direct",
      netOutputUsd: value.sub(gasUsd).toFixed(),
      expectedOut: out,
      feeUsd: D(req.notionalUsd).mul(best.fee).div(1_000_000).toFixed(),
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
    const raw = ctx.quote.raw as DirectRaw;
    const req = ctx.request;
    const { tokenIn, tokenOut } = tokensFor(req);
    const swapDone = completedStep(ctx, "swap");
    if (swapDone?.txHash) return { done: { srcTx: swapDone.txHash } };
    if (!completedStep(ctx, "approve")) {
      const allowance = await erc20Allowance("arc", tokenIn, req.evmAddress, UNISWAP_ARC.v3SwapRouter02);
      if (allowance < BigInt(raw.amountIn)) {
        return {
          steps: [
            {
              id: "approve",
              kind: "evm_tx",
              chain: "arc",
              label: "Approve this swap",
              to: tokenIn,
              data: encodeApprove(UNISWAP_ARC.v3SwapRouter02, BigInt(raw.amountIn)),
              waitForReceipt: true,
            },
          ],
        };
      }
    }
    const data = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn as Hex,
          tokenOut: tokenOut as Hex,
          fee: raw.fee,
          recipient: req.evmAddress as Hex,
          amountIn: BigInt(raw.amountIn),
          amountOutMinimum: BigInt(raw.amountOutMin),
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return {
      steps: [{ id: "swap", kind: "evm_tx", chain: "arc", label: "Swap", to: UNISWAP_ARC.v3SwapRouter02, data, waitForReceipt: false }],
    };
  },

  status: statusFromReceipt,
};
