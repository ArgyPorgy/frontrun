import { randomUUID } from "node:crypto";
import {
  AAVE_BASE,
  AAVE_USDC_ID,
  BASE_USDC,
  D,
  HOME_CHAIN,
  LENDING_MIN_HEALTH,
  MORPHO_BASE,
  MORPHO_USDC_VAULTS,
  STOCK_MARKETS,
  STOCK_TOKENS,
  lendingHealthFactor,
  lendingLiquidationPrice,
  lendingMaxBorrow,
  lendingMaxCollateralOut,
  stockToken,
  type LendingAction,
  type LendingActionInput,
  type LendingActionView,
  type LendingMarketView,
  type LendingPositionView,
  type LendingSummaryView,
} from "@frontrun/core";
import { desc, eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, maxUint256, parseUnits, type Hex } from "viem";
import { db, schema } from "../db/client";
import { AppError, badRequest, conflict } from "../errors";
import { logger } from "../logger";
import { encodeApprove, erc20Allowance, evmClient } from "../onchain";
import { redis } from "../redis";
import { isPaperMode, signerStatus } from "../trading/service";
import { loadSigningWallets, performServerStep, serverSigningConfigured, type SigningWallets } from "../trading/signer";
import {
  AAVE_POOL_ABI,
  MORPHO_ABI,
  VAULT_ABI,
  lendingMarket,
  lendingMarkets,
  marketParamsFor,
  oraclePriceUsd,
  readMarketState,
  readOraclePrice,
  sharesToAssetsDown,
  sharesToAssetsUp,
  stockMarketDef,
} from "./markets";

type Row = typeof schema.lendingActions.$inferSelect;

const fromUnits = (raw: bigint, decimals: number) => D(raw.toString()).div(D(10).pow(decimals));
const usdc = (raw: bigint) => fromUnits(raw, 6);

function toView(row: Row): LendingActionView {
  return {
    id: row.id,
    action: row.action,
    venue: row.venue,
    marketId: row.marketId,
    marketName: row.marketName,
    asset: row.asset,
    amount: D(row.amount).toFixed(),
    status: row.status,
    txHash: row.txHash,
    reason: row.agentReason,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listLendingActions(userId: string, limit = 50): Promise<LendingActionView[]> {
  const rows = await db().select().from(schema.lendingActions).where(eq(schema.lendingActions.userId, userId)).orderBy(desc(schema.lendingActions.createdAt)).limit(limit);
  return rows.map(toView);
}

/** Raw on-chain balances for one wallet across every lending market. */
interface RawPosition {
  market: LendingMarketView;
  supplied: bigint;
  supplyShares: bigint;
  borrowed: bigint;
  borrowShares: bigint;
  collateral: bigint;
  priceRaw: bigint | null;
}

async function readPositions(address: string): Promise<{ raw: RawPosition[]; walletUsdc: bigint; stocks: bigint[] }> {
  const client = evmClient(HOME_CHAIN);
  const owner = address as Hex;
  const markets = await lendingMarkets();
  const byId = new Map(markets.map((m) => [m.id.toLowerCase(), m]));
  const [aUsdc, walletUsdc, vaultShares, morpho, states, prices, stocks] = await Promise.all([
    client.readContract({ address: AAVE_BASE.aUsdc as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: BASE_USDC as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    Promise.all(MORPHO_USDC_VAULTS.map((v) => client.readContract({ address: v.address as Hex, abi: VAULT_ABI, functionName: "balanceOf", args: [owner] }))),
    Promise.all(STOCK_MARKETS.map((m) => client.readContract({ address: MORPHO_BASE.blue as Hex, abi: MORPHO_ABI, functionName: "position", args: [m.id as Hex, owner] }))),
    Promise.all(STOCK_MARKETS.map((m) => readMarketState(m.id))),
    Promise.all(STOCK_MARKETS.map((m) => readOraclePrice(m).catch(() => null))),
    Promise.all(STOCK_TOKENS.map((t) => client.readContract({ address: t.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] }))),
  ]);
  const vaultAssets = await Promise.all(
    MORPHO_USDC_VAULTS.map((v, i) => (vaultShares[i]! > 0n ? client.readContract({ address: v.address as Hex, abi: VAULT_ABI, functionName: "convertToAssets", args: [vaultShares[i]!] }) : Promise.resolve(0n))),
  );
  const raw: RawPosition[] = [];
  const aave = byId.get(AAVE_USDC_ID);
  if (aave && aUsdc > 0n) raw.push({ market: aave, supplied: aUsdc, supplyShares: 0n, borrowed: 0n, borrowShares: 0n, collateral: 0n, priceRaw: null });
  MORPHO_USDC_VAULTS.forEach((v, i) => {
    const m = byId.get(v.address.toLowerCase());
    if (m && vaultShares[i]! > 0n) raw.push({ market: m, supplied: vaultAssets[i]!, supplyShares: vaultShares[i]!, borrowed: 0n, borrowShares: 0n, collateral: 0n, priceRaw: null });
  });
  STOCK_MARKETS.forEach((def, i) => {
    const m = byId.get(def.id.toLowerCase());
    const [supplyShares, borrowShares, collateral] = morpho[i]!;
    const s = states[i]!;
    if (!m || (supplyShares === 0n && borrowShares === 0n && collateral === 0n)) return;
    raw.push({
      market: m,
      supplied: sharesToAssetsDown(supplyShares, s.totalSupplyAssets, s.totalSupplyShares),
      supplyShares,
      borrowed: sharesToAssetsUp(borrowShares, s.totalBorrowAssets, s.totalBorrowShares),
      borrowShares,
      collateral,
      priceRaw: prices[i] ?? null,
    });
  });
  return { raw, walletUsdc, stocks };
}

function positionView(p: RawPosition): LendingPositionView {
  const token = p.market.collateral;
  const borrowed = Number(usdc(p.borrowed).toFixed());
  let collateralQty = 0;
  let collateralUsd: number | null = null;
  let price: number | null = null;
  if (token) {
    collateralQty = Number(fromUnits(p.collateral, token.decimals).toFixed());
    price = p.priceRaw === null ? null : oraclePriceUsd(p.priceRaw, token.decimals);
    collateralUsd = price === null ? null : collateralQty * price;
  }
  const lltv = p.market.lltv ?? 0;
  return {
    market: p.market,
    suppliedUsd: usdc(p.supplied).toFixed(2),
    collateralQty: token ? fromUnits(p.collateral, token.decimals).toFixed() : "0",
    collateralUsd: collateralUsd === null ? null : collateralUsd.toFixed(2),
    borrowedUsd: usdc(p.borrowed).toFixed(2),
    maxBorrowUsd: token && collateralUsd !== null ? lendingMaxBorrow(collateralUsd, borrowed, lltv).toFixed(2) : null,
    maxWithdrawCollateral: token && price !== null ? lendingMaxCollateralOut(collateralQty, price, borrowed, lltv).toFixed(8) : null,
    healthFactor: token && collateralUsd !== null ? lendingHealthFactor(collateralUsd, borrowed, lltv) : null,
    liquidationPrice: token ? lendingLiquidationPrice(collateralQty, borrowed, lltv) : null,
  };
}

export async function lendingSummaryFor(address: string): Promise<LendingSummaryView> {
  const { raw, walletUsdc, stocks } = await readPositions(address);
  const positions = raw.map(positionView);
  const markets = await lendingMarkets();
  const priceOf = (ticker: string) => markets.find((m) => m.collateral?.ticker === ticker)?.collateral?.priceUsd ?? null;
  const sum = (f: (p: LendingPositionView) => string | null) => positions.reduce((a, p) => a.add(f(p) ?? "0"), D(0)).toFixed(2);
  return {
    positions,
    totalSuppliedUsd: sum((p) => p.suppliedUsd),
    totalBorrowedUsd: sum((p) => p.borrowedUsd),
    totalCollateralUsd: sum((p) => p.collateralUsd),
    walletUsdc: usdc(walletUsdc).toFixed(2),
    stocks: STOCK_TOKENS.map((t, i) => {
      const qty = fromUnits(stocks[i]!, t.decimals);
      const price = priceOf(t.ticker);
      return { ticker: t.ticker, symbol: t.symbol, qty: qty.toFixed(), usd: price === null ? null : qty.mul(price).toFixed(2) };
    }).filter((s) => D(s.qty).gt(0)),
  };
}

export async function lendingSummary(userId: string): Promise<LendingSummaryView> {
  const wallets = await loadSigningWallets(userId);
  return lendingSummaryFor(wallets.evmAddress);
}

async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = `lending:lock:${userId}`;
  if (!(await redis().set(key, "1", "EX", 180, "NX"))) throw conflict("busy", "Another lending move is still going through. Give it a moment.");
  try {
    return await fn();
  } finally {
    await redis().del(key);
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof AppError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (/policy_violation/.test(message)) {
    logger.error({ err: message.slice(0, 200) }, "ALERT: the signer policy refused a lending action");
    return "This action isn't allowed for your wallet right now. Nothing was sent, and your funds are safe.";
  }
  if (/insufficient|exceeds balance/i.test(message)) return "Not enough balance for this.";
  if (/insufficient liquidity/i.test(message)) return "The market doesn't have that much USDC free right now.";
  if (/insufficient collateral/i.test(message)) return "That would leave too little collateral behind the loan.";
  if (/reverted/i.test(message)) return "The transaction reverted on-chain. Nothing moved.";
  return message.length < 160 ? message : "The lending move couldn't be completed.";
}

interface Call {
  to: string;
  data: Hex;
  label: string;
}

/** Approves exactly what the next call spends, unless enough is already approved. */
async function approvalIfNeeded(token: string, owner: string, spender: string, amount: bigint, label: string): Promise<Call | null> {
  const current = await erc20Allowance(HOME_CHAIN, token, owner, spender);
  if (current >= amount) return null;
  return { to: token, data: encodeApprove(spender, amount), label };
}

interface Plan {
  calls: Call[];
  venue: "aave" | "morpho_vault" | "morpho_market";
  marketName: string;
  asset: string;
  amount: string;
}

/** Works out the transactions for one move, checking balances and the safety margin first. Sends nothing. */
async function planAction(wallets: SigningWallets, input: LendingActionInput): Promise<Plan> {
  const owner = wallets.evmAddress as Hex;
  const client = evmClient(HOME_CHAIN);
  const market = await lendingMarket(input.marketId);
  if (!market) throw badRequest("unknown_market", "That lending market isn't offered here.");
  const amountUsdc = input.amount ? parseUnits(input.amount, 6) : 0n;
  const walletUsdc = () => client.readContract({ address: BASE_USDC as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  const needUsdc = async (amount: bigint) => {
    const have = await walletUsdc();
    if (have < amount) throw conflict("insufficient_balance", `You have $${usdc(have).toFixed(2)} USDC, and this needs $${usdc(amount).toFixed(2)}.`);
  };
  const base = { venue: market.venue, marketName: market.name };

  if (market.venue === "aave") {
    const pool = AAVE_BASE.pool as Hex;
    if (input.action === "supply") {
      const amount = input.max ? await walletUsdc() : amountUsdc;
      if (amount <= 0n) throw badRequest("invalid_amount", "There's no USDC to supply.");
      await needUsdc(amount);
      const approve = await approvalIfNeeded(BASE_USDC, owner, pool, amount, "Approve USDC for Aave");
      return { ...base, asset: "USDC", amount: usdc(amount).toFixed(), calls: [...(approve ? [approve] : []), { to: pool, label: "Supply to Aave", data: encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "supply", args: [BASE_USDC as Hex, amount, owner, 0] }) }] };
    }
    if (input.action === "withdraw") {
      const supplied = await client.readContract({ address: AAVE_BASE.aUsdc as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      if (supplied === 0n) throw conflict("nothing_supplied", "You have nothing in Aave to withdraw.");
      const all = input.max || amountUsdc >= supplied;
      return { ...base, asset: "USDC", amount: usdc(all ? supplied : amountUsdc).toFixed(), calls: [{ to: pool, label: "Withdraw from Aave", data: encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "withdraw", args: [BASE_USDC as Hex, all ? maxUint256 : amountUsdc, owner] }) }] };
    }
    throw badRequest("unsupported", "Aave here is for earning on USDC. Borrow against stocks in a stock market instead.");
  }

  if (market.venue === "morpho_vault") {
    const vault = market.id as Hex;
    if (input.action === "supply") {
      const amount = input.max ? await walletUsdc() : amountUsdc;
      if (amount <= 0n) throw badRequest("invalid_amount", "There's no USDC to deposit.");
      await needUsdc(amount);
      const approve = await approvalIfNeeded(BASE_USDC, owner, vault, amount, `Approve USDC for ${market.name}`);
      return { ...base, asset: "USDC", amount: usdc(amount).toFixed(), calls: [...(approve ? [approve] : []), { to: vault, label: `Deposit to ${market.name}`, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amount, owner] }) }] };
    }
    if (input.action === "withdraw") {
      const [shares, available] = await Promise.all([
        client.readContract({ address: vault, abi: VAULT_ABI, functionName: "balanceOf", args: [owner] }),
        client.readContract({ address: vault, abi: VAULT_ABI, functionName: "maxWithdraw", args: [owner] }),
      ]);
      if (shares === 0n) throw conflict("nothing_supplied", `You have nothing in ${market.name} to withdraw.`);
      if (input.max) return { ...base, asset: "USDC", amount: usdc(available).toFixed(), calls: [{ to: vault, label: `Withdraw from ${market.name}`, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, owner, owner] }) }] };
      if (amountUsdc > available) throw conflict("too_much", `You can withdraw up to $${usdc(available).toFixed(2)} from ${market.name} right now.`);
      return { ...base, asset: "USDC", amount: usdc(amountUsdc).toFixed(), calls: [{ to: vault, label: `Withdraw from ${market.name}`, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [amountUsdc, owner, owner] }) }] };
    }
    throw badRequest("unsupported", "Vaults are for earning on USDC.");
  }

  // A Morpho stock market.
  const def = stockMarketDef(market.id)!;
  const token = stockToken(def.ticker)!;
  const params = marketParamsFor(def);
  const blue = MORPHO_BASE.blue as Hex;
  const [position, state, priceRaw] = await Promise.all([
    client.readContract({ address: blue, abi: MORPHO_ABI, functionName: "position", args: [def.id as Hex, owner] }),
    readMarketState(def.id),
    readOraclePrice(def),
  ]);
  const [supplyShares, borrowShares, collateral] = position;
  const borrowed = sharesToAssetsUp(borrowShares, state.totalBorrowAssets, state.totalBorrowShares);
  const supplied = sharesToAssetsDown(supplyShares, state.totalSupplyAssets, state.totalSupplyShares);
  const liquidity = state.totalSupplyAssets - state.totalBorrowAssets;
  const lltv = Number(params.lltv) / 1e18;
  const price = oraclePriceUsd(priceRaw, token.decimals);
  const collateralQty = Number(fromUnits(collateral, token.decimals).toFixed());
  const borrowedUsd = Number(usdc(borrowed).toFixed());
  const tokenAmount = input.amount ? parseUnits(input.amount, token.decimals) : 0n;

  switch (input.action as LendingAction) {
    case "supply": {
      const amount = input.max ? await walletUsdc() : amountUsdc;
      if (amount <= 0n) throw badRequest("invalid_amount", "There's no USDC to lend.");
      await needUsdc(amount);
      const approve = await approvalIfNeeded(BASE_USDC, owner, blue, amount, "Approve USDC for Morpho");
      return { ...base, asset: "USDC", amount: usdc(amount).toFixed(), calls: [...(approve ? [approve] : []), { to: blue, label: `Lend USDC in ${market.name}`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supply", args: [params, amount, 0n, owner, "0x"] }) }] };
    }
    case "withdraw": {
      if (supplyShares === 0n) throw conflict("nothing_supplied", `You have nothing lent in ${market.name}.`);
      const all = input.max || amountUsdc >= supplied;
      const amount = all ? supplied : amountUsdc;
      if (amount > liquidity) throw conflict("no_liquidity", `Only $${usdc(liquidity).toFixed(2)} is free in ${market.name} right now, because the rest is borrowed. Try a smaller amount or come back later.`);
      return {
        ...base,
        asset: "USDC",
        amount: usdc(amount).toFixed(),
        calls: [{ to: blue, label: `Withdraw USDC from ${market.name}`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdraw", args: all ? [params, 0n, supplyShares, owner, owner] : [params, amount, 0n, owner, owner] }) }],
      };
    }
    case "supply_collateral": {
      const have = await client.readContract({ address: token.address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      const amount = input.max ? have : tokenAmount;
      if (amount <= 0n) throw badRequest("invalid_amount", `You have no ${token.symbol} to post.`);
      if (have < amount) throw conflict("insufficient_balance", `You have ${fromUnits(have, token.decimals).toFixed()} ${token.symbol}.`);
      const approve = await approvalIfNeeded(token.address, owner, blue, amount, `Approve ${token.symbol} for Morpho`);
      return { ...base, asset: token.symbol, amount: fromUnits(amount, token.decimals).toFixed(), calls: [...(approve ? [approve] : []), { to: blue, label: `Post ${token.symbol} as collateral`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supplyCollateral", args: [params, amount, owner, "0x"] }) }] };
    }
    case "withdraw_collateral": {
      if (collateral === 0n) throw conflict("no_collateral", `You have no ${token.symbol} posted here.`);
      const maxOut = lendingMaxCollateralOut(collateralQty, price, borrowedUsd, lltv);
      const maxOutRaw = borrowed === 0n ? collateral : parseUnits(maxOut.toFixed(token.decimals), token.decimals);
      const amount = input.max ? maxOutRaw : tokenAmount;
      if (amount <= 0n) throw conflict("health", `Repay some of the loan first. Taking collateral out now would put it below a ${LENDING_MIN_HEALTH} health factor.`);
      if (amount > maxOutRaw) throw conflict("health", `You can take out up to ${fromUnits(maxOutRaw, token.decimals).toFixed()} ${token.symbol} and keep the loan safe.`);
      return { ...base, asset: token.symbol, amount: fromUnits(amount, token.decimals).toFixed(), calls: [{ to: blue, label: `Take back ${token.symbol}`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [params, amount, owner, owner] }) }] };
    }
    case "borrow": {
      const room = lendingMaxBorrow(collateralQty * price, borrowedUsd, lltv);
      const roomRaw = parseUnits(room.toFixed(6), 6);
      const amount = input.max ? (roomRaw < liquidity ? roomRaw : liquidity) : amountUsdc;
      if (collateral === 0n) throw conflict("no_collateral", `Post ${token.symbol} as collateral first.`);
      if (amount <= 0n) throw conflict("health", "There's no room to borrow more and keep the loan safe.");
      if (amount > roomRaw) throw conflict("health", `You can borrow up to $${room.toFixed(2)} more and keep a ${LENDING_MIN_HEALTH} health factor.`);
      if (amount > liquidity) throw conflict("no_liquidity", `Only $${usdc(liquidity).toFixed(2)} USDC is free to borrow in ${market.name} right now.`);
      return { ...base, asset: "USDC", amount: usdc(amount).toFixed(), calls: [{ to: blue, label: `Borrow USDC against ${token.symbol}`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "borrow", args: [params, amount, 0n, owner, owner] }) }] };
    }
    case "repay": {
      if (borrowShares === 0n) throw conflict("no_debt", `You have no loan in ${market.name}.`);
      const all = input.max || amountUsdc >= borrowed;
      // Interest keeps accruing until the transaction lands, so a full repay approves a hair more than today's debt.
      const amount = all ? borrowed + borrowed / 1000n + 10n : amountUsdc;
      await needUsdc(all ? borrowed : amount);
      const approve = await approvalIfNeeded(BASE_USDC, owner, blue, amount, "Approve USDC for Morpho");
      return {
        ...base,
        asset: "USDC",
        amount: usdc(all ? borrowed : amount).toFixed(),
        calls: [...(approve ? [approve] : []), { to: blue, label: `Repay in ${market.name}`, data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: all ? [params, 0n, borrowShares, owner, "0x"] : [params, amount, 0n, owner, "0x"] }) }],
      };
    }
  }
}

/** Runs one lending move from the user's own wallet, through the gasless path that carries Front Run's Builder Code. */
export async function performLendingAction(userId: string, input: LendingActionInput, opts: { agentReason?: string } = {}): Promise<LendingActionView> {
  if (isPaperMode()) throw conflict("live_only", "Lending works with real USDC only, so it's off in paper mode.");
  if (!serverSigningConfigured() || !(await signerStatus(userId)).active) throw conflict("needs_one_tap", "Turn on one-tap trading first, so lending moves can be signed for you.");
  return withLock(userId, async () => {
    const wallets = await loadSigningWallets(userId);
    const plan = await planAction(wallets, input);
    const [row] = await db()
      .insert(schema.lendingActions)
      .values({ userId, venue: plan.venue, marketId: input.marketId, marketName: plan.marketName, action: input.action, asset: plan.asset, amount: plan.amount, agentReason: opts.agentReason ?? null })
      .returning();
    const tradeId = randomUUID();
    let lastHash: string | null = null;
    try {
      for (const [i, call] of plan.calls.entries()) {
        const result = await performServerStep(wallets, { id: `lend-${i}`, kind: "evm_tx", chain: HOME_CHAIN, label: call.label, to: call.to, data: call.data, waitForReceipt: true }, { userId, tradeId });
        lastHash = result.txHash ?? lastHash;
      }
      const [done] = await db().update(schema.lendingActions).set({ status: "done", txHash: lastHash }).where(eq(schema.lendingActions.id, row!.id)).returning();
      await db().insert(schema.auditLog).values({ userId, action: `lending_${input.action}`, detail: { id: row!.id, market: input.marketId, amount: plan.amount, asset: plan.asset, tx: lastHash } });
      return toView(done!);
    } catch (err) {
      const message = friendlyError(err);
      logger.warn({ userId, action: input.action, err: err instanceof Error ? err.message.slice(0, 300) : err }, "lending action failed");
      const [failed] = await db().update(schema.lendingActions).set({ status: "failed", error: message, txHash: lastHash }).where(eq(schema.lendingActions.id, row!.id)).returning();
      return toView(failed!);
    }
  });
}

/** Checks a move without sending it: the same balance and safety checks, and what it would do. */
export async function previewLendingAction(userId: string, input: LendingActionInput): Promise<{ asset: string; amount: string; steps: string[] }> {
  const wallets = await loadSigningWallets(userId);
  const plan = await planAction(wallets, input);
  return { asset: plan.asset, amount: plan.amount, steps: plan.calls.map((c) => c.label) };
}

