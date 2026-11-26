import { randomUUID } from "node:crypto";
import { ARC_USDC, ARC_GAS_RESERVE_USDC6, BASE_USDC, CHAINS, D, HOME_CHAIN, fromBaseUnits, type ArcMoveView } from "@frontrun/core";
import { db, schema } from "../db/client";
import { conflict } from "../errors";
import { logger } from "../logger";
import { arcUsdcBalance } from "../onchain";
import { flashStatusToUpdate, getFlashOrder, quoteTransfer } from "../providers/flash";
import { flashProvider } from "../providers";
import type { RouteRequest } from "../providers/types";
import { redis } from "../redis";
import { isPaperMode, signerStatus } from "./service";
import { loadSigningWallets, performServerStep, serverSigningConfigured } from "./signer";
import { sponsorshipConfigured } from "./sponsor";
import type { StepResult } from "@frontrun/core";

/** Below this the route's fixed costs would eat too much of it, and Flash may not take it at all. */
const MIN_MOVE_USD = "1";
const MAX_STEPS = 6;
const moveKey = (userId: string) => `move:arc-to-base:${userId}`;

interface MoveRecord {
  orderId: string;
  amountUsd: string;
  at: number;
}

/**
 * Before Base became home, balances were USDC on Arc. Anything still there doesn't count as a balance
 * anymore, so this sends it to the same address on Base in one order through Flash. It's the person's own
 * money moving, so the app's trading fee isn't charged on it.
 */
export async function arcMoveStatus(userId: string): Promise<ArcMoveView> {
  if (isPaperMode()) return { arcUsdc: "0", pending: null };
  const wallets = await loadSigningWallets(userId).catch(() => null);
  if (!wallets) return { arcUsdc: "0", pending: null };
  const arcUsdc = fromBaseUnits(await arcUsdcBalance(wallets.evmAddress).catch(() => 0n), CHAINS.arc.usdcDecimals);
  const saved = await redis().get(moveKey(userId));
  if (!saved) return { arcUsdc, pending: null };
  const record = JSON.parse(saved) as MoveRecord;
  const status = await getFlashOrder(record.orderId, wallets.evmAddress)
    .then((res) => flashStatusToUpdate(res, { side: "buy" }).status)
    .catch(() => "pending" as const);
  return { arcUsdc, pending: { amountUsd: record.amountUsd, status, startedAt: new Date(record.at).toISOString() } };
}

export async function moveArcUsdcToBase(userId: string): Promise<ArcMoveView> {
  if (isPaperMode()) throw conflict("not_live", "Paper balances already live on Base.");
  if (!serverSigningConfigured() || !(await signerStatus(userId)).active) throw conflict("needs_one_tap", "Turn on one-tap trading first, so the move can be signed for you.");
  const wallets = await loadSigningWallets(userId);
  const raw = await arcUsdcBalance(wallets.evmAddress);
  // Without sponsorship Arc's gas comes out of this same USDC, so a little stays behind to pay for it.
  const movable = sponsorshipConfigured("arc") ? raw : raw > ARC_GAS_RESERVE_USDC6 ? raw - ARC_GAS_RESERVE_USDC6 : 0n;
  const amount = fromBaseUnits(movable, CHAINS.arc.usdcDecimals);
  if (D(amount).lt(MIN_MOVE_USD)) throw conflict("nothing_to_move", `There's under $${MIN_MOVE_USD} of USDC on Arc, which is too little to move.`);

  const request: RouteRequest = {
    side: "buy",
    chain: HOME_CHAIN,
    address: BASE_USDC,
    decimals: 6,
    usdcIn: amount,
    evmAddress: wallets.evmAddress,
    solanaAddress: wallets.solanaAddress,
    priceUsd: "1",
    notionalUsd: amount,
    contra: { chain: "arc", asset: ARC_USDC, decimals: CHAINS.arc.usdcDecimals },
  };
  const quote = await quoteTransfer(request);
  const tradeId = randomUUID();
  const completed: StepResult[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = await flashProvider.advance({ tradeId, userId, request, quote, completed });
    if ("done" in next) {
      const orderId = next.done.providerOrderId;
      if (!orderId) throw new Error("Flash took the move but returned no order id.");
      const record: MoveRecord = { orderId, amountUsd: amount, at: Date.now() };
      await redis().set(moveKey(userId), JSON.stringify(record), "EX", 3600);
      await db().insert(schema.auditLog).values({ userId, action: "arc_moved_to_base", detail: { orderId, amountUsd: amount } });
      logger.info({ userId, orderId, amountUsd: amount }, "moving Arc USDC to Base");
      return arcMoveStatus(userId);
    }
    for (const step of next.steps) completed.push(await performServerStep(wallets, step, { userId, tradeId }));
  }
  throw new Error("Too many signing steps.");
}
