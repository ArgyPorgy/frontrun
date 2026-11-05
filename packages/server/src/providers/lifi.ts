import { ARC_USDC, CHAINS, D, GUARDRAILS, fromBaseUnits, toBaseUnits, type ExecStep } from "@frontrun/core";
import { env } from "../env";
import { fetchJson } from "../http";
import { encodeApprove, erc20Decimals } from "../onchain";
import { sponsorshipConfigured } from "../trading/sponsor";
import type { AdvanceResult, ExecContext, ProviderQuote, RouteProvider, RouteRequest, StatusInput, StatusUpdate } from "./types";
import { completedStep, isCrossChain, recipientOn, spentChain } from "./types";

const BASE = "https://li.quest/v1";

interface LifiQuote {
  action: { fromToken: { decimals: number }; toToken: { decimals: number; symbol: string } };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    toAmountUSD?: string;
    fromAmountUSD?: string;
    executionDuration: number;
    approvalAddress?: string;
    gasCosts?: Array<{ amountUSD?: string }>;
    feeCosts?: Array<{ amountUSD?: string; included?: boolean }>;
  };
  transactionRequest?: { to?: string; data: string; value?: string; chainId?: number };
  tool: string;
}

function headers(): Record<string, string> {
  const key = env().LIFI_API_KEY;
  return key ? { "x-lifi-api-key": key } : {};
}

async function amountAndDecimals(req: RouteRequest): Promise<string> {
  if (req.side === "buy") return toBaseUnits(req.usdcIn!, CHAINS.arc.usdcDecimals).toString();
  const decimals = req.decimals ?? (CHAINS[req.chain].type === "evm" ? await erc20Decimals(req.chain, req.address) : 9);
  return toBaseUnits(req.qtyIn!, decimals).toString();
}

export const lifiProvider: RouteProvider = {
  id: "lifi",
  enabled: () => true,
  // Only a fallback for cross-chain. Arc same-chain races Uniswap against Flash.
  supports: (req) => isCrossChain(req),

  async quote(req, signal) {
    const started = Date.now();
    const source = spentChain(req);
    const dest = req.side === "buy" ? req.chain : "arc";
    const fromAmount = await amountAndDecimals(req);
    const params = new URLSearchParams({
      fromChain: String(CHAINS[source].lifiId),
      toChain: String(CHAINS[dest].lifiId),
      fromToken: req.side === "buy" ? ARC_USDC : req.address,
      toToken: req.side === "buy" ? req.address : ARC_USDC,
      fromAmount,
      fromAddress: recipientOn(req, source),
      toAddress: recipientOn(req, dest),
      slippage: String(GUARDRAILS.crossChainSlippage),
      integrator: env().LIFI_INTEGRATOR,
      order: "RECOMMENDED",
      ...(env().LIFI_FEE ? { fee: env().LIFI_FEE! } : {}),
    });
    const raw = await fetchJson<LifiQuote>(`${BASE}/quote?${params}`, { headers: headers(), timeoutMs: 4_000, signal });
    const out = fromBaseUnits(BigInt(raw.estimate.toAmount), raw.action.toToken.decimals);
    const sum = (items?: Array<{ amountUSD?: string }>) => (items ?? []).reduce((acc, c) => acc.add(c.amountUSD ?? 0), D(0));
    const gas = sponsorshipConfigured(source) ? D(0) : sum(raw.estimate.gasCosts);
    const fees = sum(raw.estimate.feeCosts);
    const toUsd = raw.estimate.toAmountUSD ?? (req.side === "buy" ? D(out).mul(req.priceUsd).toFixed() : out);
    const fromUsd = D(raw.estimate.fromAmountUSD ?? req.notionalUsd);
    const impact = fromUsd.gt(0) ? Math.max(fromUsd.sub(toUsd).div(fromUsd).toNumber(), 0) : null;
    return {
      provider: "lifi",
      netOutputUsd: D(toUsd).sub(gas).toFixed(),
      expectedOut: out,
      feeUsd: fees.toFixed(),
      gasUsd: gas.toFixed(),
      etaSeconds: raw.estimate.executionDuration,
      priceImpact: impact,
      recommendedSlippage: GUARDRAILS.crossChainSlippage,
      crossChain: true,
      needsSetup: true,
      sponsoredSetup: source !== "arc" && CHAINS[source].privySponsored,
      latencyMs: Date.now() - started,
      raw,
    } satisfies ProviderQuote;
  },

  async advance(ctx: ExecContext): Promise<AdvanceResult> {
    const raw = ctx.quote.raw as LifiQuote;
    const req = ctx.request;
    const source = spentChain(req);
    const bridged = completedStep(ctx, "bridge");
    if (bridged?.txHash) return { done: { srcTx: bridged.txHash } };

    const tx = raw.transactionRequest;
    if (!tx) throw new Error("LI.FI returned no transaction.");

    if (CHAINS[source].type === "solana") {
      return { steps: [{ id: "bridge", kind: "svm_tx", chain: "solana", label: "Send", transactionBase64: tx.data, broadcast: true, sponsor: true }] };
    }

    const spentToken = req.side === "buy" ? ARC_USDC : req.address;
    if (raw.estimate.approvalAddress && !completedStep(ctx, "approve")) {
      const fromAmount = await amountAndDecimals(req);
      const step: ExecStep = {
        id: "approve",
        kind: "evm_tx",
        chain: source,
        label: "Approve this trade",
        to: spentToken,
        // Exact amount, per the plan: only Flash gets a standing approval.
        data: encodeApprove(raw.estimate.approvalAddress, BigInt(fromAmount)),
        waitForReceipt: true,
      };
      return { steps: [step] };
    }
    if (!tx.to) throw new Error("LI.FI returned no transaction target.");
    return {
      steps: [{ id: "bridge", kind: "evm_tx", chain: source, label: "Send", to: tx.to, data: tx.data, value: tx.value, sponsor: source !== "arc", waitForReceipt: false }],
    };
  },

  async status(input: StatusInput): Promise<StatusUpdate> {
    if (!input.srcTx) return { status: "failed", error: "No transaction" };
    const req = input.request;
    const source = spentChain(req);
    const dest = req.side === "buy" ? req.chain : "arc";
    const params = new URLSearchParams({
      txHash: input.srcTx,
      fromChain: String(CHAINS[source].lifiId),
      toChain: String(CHAINS[dest].lifiId),
    });
    const res = await fetchJson<LifiStatus>(`${BASE}/status?${params}`, { headers: headers(), timeoutMs: 6_000, retries: 1 });
    const update = lifiStatusToUpdate(res, req, input.srcTx);
    // LI.FI's gas is paid separately from the swapped amount, so the estimate goes into PnL.
    return update.status === "filled" ? { ...update, feeUsd: input.quote.feeUsd, extraCostUsd: input.quote.gasUsd } : update;
  },
};

export interface LifiStatus {
  status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
  substatus?: string;
  substatusMessage?: string;
  sending?: { txHash?: string; amountUSD?: string; amount?: string; token?: { decimals: number } };
  receiving?: { txHash?: string; amountUSD?: string; amount?: string; token?: { decimals: number; address?: string } };
}

export function lifiStatusToUpdate(res: LifiStatus, req: Pick<RouteRequest, "side" | "qtyIn" | "usdcIn" | "priceUsd">, srcTx: string): StatusUpdate {
  switch (res.status) {
    case "DONE": {
      if (res.substatus === "REFUNDED") {
        return { status: "refunded", srcTx, dstTx: res.receiving?.txHash, error: "The bridge failed and your funds were returned." };
      }
      const decimals = res.receiving?.token?.decimals ?? 18;
      const received = res.receiving?.amount ? fromBaseUnits(BigInt(res.receiving.amount), decimals) : undefined;
      if (req.side === "buy") {
        const usdIn = req.usdcIn;
        return {
          status: "filled",
          qty: received,
          usdIn,
          priceUsd: received && usdIn && D(received).gt(0) ? D(usdIn).div(received).toFixed() : undefined,
          srcTx,
          dstTx: res.receiving?.txHash,
        };
      }
      return {
        status: "filled",
        qty: req.qtyIn,
        usdOut: received,
        priceUsd: received && req.qtyIn && D(req.qtyIn).gt(0) ? D(received).div(req.qtyIn).toFixed() : undefined,
        srcTx,
        dstTx: res.receiving?.txHash,
      };
    }
    case "FAILED":
    case "INVALID":
      return { status: "failed", srcTx, error: res.substatusMessage ?? "The bridge failed." };
    case "PENDING":
      return { status: "source_confirmed", srcTx };
    default:
      return { status: "pending", srcTx };
  }
}
