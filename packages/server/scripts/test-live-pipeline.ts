/**
 * Runs the real trade pipeline in live mode, as far as it can go without any money.
 *   pnpm live:test
 *
 * Nothing here can move funds. It uses brand-new empty Privy wallets, so anything they try to send is
 * refused by the chain or the venue, and the gas wallet is never touched. It also reads real swaps made
 * by other people on Arc, which are public, to check the fill parser against reality. Everything it
 * writes goes to a throwaway database, frontrun_livecheck, so your real data stays clean.
 *
 * It can't replace a real trade: nothing here proves a fill lands in your own wallet.
 */
import { randomUUID } from "node:crypto";
import { ARC_USDC, FLASH_ALLOWANCE_ARC, PERMIT2, UNISWAP_ARC, D, resolveSlippage, usdc6ToArcNative } from "@frontrun/core";
import { and, eq, isNull } from "drizzle-orm";
import pg from "pg";
import { decodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbiItem, type Hex } from "viem";
import { closeDb, db, schema } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { env, resetEnvForTests } from "../src/env";
import { AppError } from "../src/errors";
import { getTokenDetail, rememberToken } from "../src/market/service";
import { ARC_SYSTEM_EMITTER, arcUsdcBalance, evmClient, parseSwapReceipt } from "../src/onchain";
import { flashProvider } from "../src/providers/flash";
import type { RouteProvider, RouteRequest } from "../src/providers/types";
import { uniswapProvider } from "../src/providers/uniswap";
import { KEYS, closeRedis, redis } from "../src/redis";
import { applyGuardrails } from "../src/routing/engine";
import { applyStatus, createQuote, executeTrade, isPaperMode, signerStatus, submitWalletSteps, usdcBalance, type QuoteRecord } from "../src/trading/service";
import { performServerStep, privy, type SigningWallets } from "../src/trading/signer";

const ARC_WETH = "0x128cc466b61f542da60c70e3aa11c10e19b84edb";
const DATABASE = "frontrun_livecheck";
const ROUTER = UNISWAP_ARC.universalRouter212.toLowerCase();

let failures = 0;
const section = (name: string) => console.log(`\n${name}`);
const info = (text: string) => console.log(`  INFO  ${text}`);
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
// Arc's public RPC starts refusing at a few requests a second.
const pause = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface RealBuy {
  hash: Hex;
  trader: string;
  token: string;
}

async function useThrowawayDatabase() {
  const url = new URL(process.env.DATABASE_URL!);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = $1", [DATABASE]);
  if (!exists.rowCount) await admin.query(`create database ${DATABASE}`);
  await admin.end();
  url.pathname = `/${DATABASE}`;
  process.env.DATABASE_URL = url.toString();
  resetEnvForTests();
  await runMigrations();
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const PERMIT = parseAbiItem("event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)");
const LOG_CHUNK = 2_000n;

/**
 * Finds real swaps without an index. A buy sends native USDC into the router. A sell signs a Permit2
 * permit naming the router, which is the same path the app's own sells take.
 */
async function recentRouterSwaps(direction: "buy" | "sell", wanted: number): Promise<Hex[]> {
  const client = evmClient("arc");
  const router = UNISWAP_ARC.universalRouter212 as Hex;
  const hashes = new Set<Hex>();
  let toBlock = await client.getBlockNumber();
  for (let i = 0; i < 60 && hashes.size < wanted; i++) {
    const fromBlock = toBlock - LOG_CHUNK + 1n;
    await pause();
    const logs =
      direction === "buy"
        ? await client.getLogs({ address: ARC_SYSTEM_EMITTER, event: TRANSFER, args: { to: router }, fromBlock, toBlock })
        : await client.getLogs({ address: PERMIT2, event: PERMIT, args: { spender: router }, fromBlock, toBlock });
    for (const log of logs.reverse()) hashes.add(log.transactionHash);
    toBlock = fromBlock - 1n;
  }
  return [...hashes].slice(0, wanted);
}

/**
 * The fill parser, on real swaps by real people. A wrong amount here means wrong PnL for everyone, so
 * it's held against something it doesn't read: the wallet's actual balance before and after.
 */
async function checkRealSwaps(): Promise<RealBuy | null> {
  section("Real Uniswap swaps on Arc, checked against real balance changes");
  const client = evmClient("arc");
  let realBuy: RealBuy | null = null;
  for (const side of ["buy", "sell"] as const) {
    const hashes = await recentRouterSwaps(side, side === "buy" ? 3 : 6);
    if (!hashes.length) {
      check(false, `Found no recent ${side}s through the router`);
      continue;
    }
    for (const hash of hashes) {
      await pause();
      const tx = await client.getTransaction({ hash });
      await pause();
      const receipt = await client.getTransactionReceipt({ hash });
      if (tx.to?.toLowerCase() !== ROUTER) {
        info(`Skipped ${hash.slice(0, 12)}: it reached the router through another contract`);
        continue;
      }
      const buying = side === "buy";
      const trader = tx.from.toLowerCase();
      const tokenLog = receipt.logs.find((log) => {
        const emitter = log.address.toLowerCase();
        if (emitter === ARC_SYSTEM_EMITTER.toLowerCase() || emitter === ARC_USDC.toLowerCase() || log.topics[0] !== TRANSFER_TOPIC) return false;
        const party = log.topics[buying ? 2 : 1];
        return !!party && `0x${party.slice(26)}`.toLowerCase() === trader;
      });
      if (!tokenLog) {
        info(`Skipped ${hash.slice(0, 12)}: no token moved to or from the sender`);
        continue;
      }
      const token = getAddress(tokenLog.address);
      const fill = parseSwapReceipt(receipt, tx.from, buying ? ARC_USDC : token, buying ? token : ARC_USDC);
      const usdc6 = buying ? fill.amountIn : fill.amountOut;
      if (usdc6 === 0n) {
        info(`Skipped ${hash.slice(0, 12)}: it swapped between two other tokens`);
        continue;
      }
      await pause();
      const before = await client.getBalance({ address: tx.from, blockNumber: receipt.blockNumber - 1n });
      await pause();
      const after = await client.getBalance({ address: tx.from, blockNumber: receipt.blockNumber });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      // What really left or arrived, with gas taken back out.
      const actual18 = buying ? before - after - gas : after - before + gas;
      const difference = usdc6ToArcNative(usdc6) - actual18;
      const matches = (difference < 0n ? -difference : difference) <= 10n ** 12n;
      const label = `${side} ${hash.slice(0, 12)}: parsed $${formatUnits(usdc6, 6)}, balance actually moved $${formatUnits(actual18, 18)}, gas $${formatUnits(gas, 18)}`;
      check(matches && (buying ? fill.amountOut : fill.amountIn) > 0n, label);
      if (buying && tx.value > 0n && matches) realBuy ??= { hash, trader: tx.from, token };
    }
  }
  return realBuy;
}

async function makeUser() {
  const e = env();
  const wallet = await privy()
    .wallets()
    .create({ chain_type: "ethereum", owner_id: e.PRIVY_SIGNER_ID!, policy_ids: [e.PRIVY_POLICY_IDS!.split(",")[0]!.trim()], external_id: `livetest${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  const address = wallet.address.toLowerCase();
  const [user] = await db()
    .insert(schema.users)
    .values({ privyId: `livetest:${randomUUID()}`, username: `lt${randomUUID().slice(0, 10)}` })
    .returning();
  if (!user) throw new Error("Couldn't create the test user.");
  await db().insert(schema.wallets).values({ userId: user.id, chainType: "evm", address, privyWalletId: wallet.id, isEmbedded: true });
  return { userId: user.id, address, walletId: wallet.id };
}

/** A venue being slow for a moment isn't what this test is about. */
async function quoteWithRetry(provider: RouteProvider, request: RouteRequest) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.quote(request);
    } catch (err) {
      if (attempt === 3) throw err;
      await pause(1_500);
    }
  }
}

/** Stands in for createQuote past its balance check, which an empty wallet can never pass. */
async function storeQuote(userId: string, address: string, provider: RouteProvider, amount: string): Promise<QuoteRecord> {
  const detail = await getTokenDetail("arc", ARC_WETH);
  if (!detail?.priceUsd) throw new Error("No live price for Arc WETH.");
  const request: RouteRequest = {
    side: "buy",
    chain: "arc",
    address: ARC_WETH,
    decimals: detail.decimals,
    usdcIn: amount,
    evmAddress: address,
    solanaAddress: null,
    priceUsd: detail.priceUsd,
    notionalUsd: amount,
  };
  const winner = await quoteWithRetry(provider, request);
  const tokenSafety = { liquidityUsd: detail.liquidityUsd, riskFlagged: detail.riskFlagged, denylisted: false };
  const token = { chain: "arc" as const, address: ARC_WETH, symbol: detail.symbol, name: detail.name, imageUrl: detail.imageUrl };
  await rememberToken(token, detail.decimals);
  const now = Date.now();
  const record: QuoteRecord = {
    id: randomUUID(),
    userId,
    request,
    winner,
    alternatives: [],
    guardrails: applyGuardrails(request, winner, tokenSafety),
    token,
    tokenSafety,
    copy: null,
    slippage: resolveSlippage(!winner.crossChain),
    createdAt: now,
    expiresAt: now + 30_000,
  };
  await redis().set(KEYS.quote(record.id), JSON.stringify(record), "EX", 180);
  return record;
}

async function runTrade(userId: string, quoteId: string, confirmed: boolean) {
  return executeTrade(userId, { quoteId, idempotencyKey: randomUUID(), confirmed });
}

async function checkEmptyWalletIsRefused(userId: string, address: string) {
  section("An empty wallet, through the normal quote path");
  const balance = await usdcBalance(userId);
  check(D(balance.usdc).eq(0) && D(balance.spendable).eq(0), `Reads the real balance from Arc: $${balance.usdc}`);
  const status = await signerStatus(userId);
  check(!status.active && !status.flashApproved, "Reads the real Flash allowance: none, and no one-tap yet");
  try {
    await createQuote(userId, { chain: "arc", address: ARC_WETH, side: "buy", amountUsd: "5" });
    check(false, "A $5 buy with no money should be refused");
  } catch (err) {
    check(err instanceof AppError && err.code === "insufficient_balance", `A $5 buy with no money is refused: "${err instanceof Error ? err.message : err}"`);
  }
  info(`Test wallet ${address}`);
}

async function checkUniswapBuy(userId: string, address: string, realBuy: RealBuy | null) {
  section("Uniswap buy, signed in the wallet");
  const record = await storeQuote(userId, address, uniswapProvider, "5");
  const trade = await runTrade(userId, record.id, true);
  check(trade.status === "awaiting_signature", `Waits for the wallet (status: ${trade.status})`);
  const step = trade.pendingSteps?.[0];
  if (step?.kind !== "evm_tx") return check(false, "The first step should be a transaction");
  check(step.id === "swap" && trade.pendingSteps!.length === 1, "Goes straight to the swap, with no approval and no permit");
  check(step.to.toLowerCase() === ROUTER, "Targets the Universal Router");
  check(BigInt(step.value ?? 0) === 5n * 10n ** 18n, "Pays exactly $5 as native value, at 18 decimals");

  // A dry run on Arc with the balance filled in for this one call: the real calldata against real pools.
  await pause();
  try {
    await evmClient("arc").call({
      account: address as Hex,
      to: step.to as Hex,
      data: step.data as Hex,
      value: BigInt(step.value ?? 0),
      stateOverride: [{ address: address as Hex, balance: 20n * 10n ** 18n }],
    });
    check(true, "Dry run with $20 of pretend balance succeeds, so the swap would execute today");
  } catch (err) {
    check(false, `Dry run reverted: ${err instanceof Error ? err.message.slice(0, 220) : err}`);
  }

  if (!realBuy) return info("Skipped the fill check: no real native buy was found");
  const update = await uniswapProvider.status({
    request: { ...record.request, address: realBuy.token, decimals: null, evmAddress: realBuy.trader },
    quote: record.winner,
    providerOrderId: null,
    srcTx: realBuy.hash,
  });
  check(update.status === "filled" && D(update.usdIn ?? 0).gt(0), `A real buy's receipt reads as filled, spending $${update.usdIn}`);
  await applyStatus(trade.id, update);
  const position = await db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, userId), eq(schema.positions.tokenAddr, ARC_WETH), isNull(schema.positions.closedAt)),
  });
  const expectedCost = D(update.usdIn!).add(update.extraCostUsd ?? 0);
  check(!!position && D(position.qty).eq(update.qty!), `That fill opens a position of ${position?.qty} tokens`);
  check(!!position && D(position.costBasisUsd).sub(expectedCost).abs().lt("0.000001"), `Cost basis is what was spent plus gas: $${position?.costBasisUsd}`);
}

async function checkFlashWalletFlow(userId: string, address: string, walletId: string) {
  section("Flash buy, signed in the wallet, up to the real venue");
  const wallets: SigningWallets = { evmWalletId: walletId, evmAddress: address, solanaWalletId: null, solanaAddress: null };
  const record = await storeQuote(userId, address, flashProvider, "5");
  let trade = await runTrade(userId, record.id, true);
  let step = trade.pendingSteps?.[0];
  check(trade.status === "awaiting_signature" && step?.id === "approve", "Starts with the one-time USDC approval");
  if (step?.kind !== "evm_tx") return;
  const decoded = decodeFunctionData({ abi: erc20Abi, data: step.data as Hex });
  check(step.to.toLowerCase() === ARC_USDC.toLowerCase() && decoded.functionName === "approve" && (decoded.args[0] as string).toLowerCase() === FLASH_ALLOWANCE_ARC.toLowerCase(), "That approval is for Flash's allowance contract, on USDC");

  // The wallet can't pay gas for the approval, so that one result is pretended. Flash re-checks for real.
  trade = await submitWalletSteps(userId, trade.id, [{ id: "approve", txHash: `0x${"0".repeat(64)}` }]);
  step = trade.pendingSteps?.[0];
  check(step?.kind === "evm_typed_data", `Then asks for the order signature (status: ${trade.status})`);
  if (step?.kind !== "evm_typed_data") return info(`Stopped with: ${trade.error}`);

  const signed = await performServerStep(wallets, step, { userId, tradeId: trade.id });
  check(!!signed.signature, "Privy signs it under the policy");
  trade = await submitWalletSteps(userId, trade.id, [signed]);
  check(trade.status === "failed" && /balance|allowance/i.test(trade.error ?? ""), `Flash reads the signed order and refuses it because the wallet is empty: "${trade.error?.slice(0, 120)}"`);
}

async function checkOneTap(userId: string, address: string) {
  section("One-tap: the server signs, within your limits");
  await db().insert(schema.signerGrants).values({ userId, perTradeCapUsd: "50", dailyCapUsd: "200", expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  const status = await signerStatus(userId);
  check(status.active, "A grant turns one-tap on");

  const overCap = await storeQuote(userId, address, uniswapProvider, "60");
  try {
    await runTrade(userId, overCap.id, false);
    check(false, "A $60 buy over the $50 limit should ask for confirmation");
  } catch (err) {
    check(err instanceof AppError && err.code === "needs_confirm", `A $60 buy over the $50 limit asks you to confirm: "${err instanceof Error ? err.message : err}"`);
  }

  const record = await storeQuote(userId, address, uniswapProvider, "5");
  const trade = await runTrade(userId, record.id, false);
  // An empty wallet stops at the gas estimate, before signing. pnpm signer:test covers the signature.
  check(trade.status === "failed" && /nothing was sent|not enough balance/i.test(trade.error ?? ""), `Goes to the server path, and an empty wallet stops before anything is sent: "${trade.error}"`);
  const audit = await db().query.auditLog.findMany({ where: and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.action, "trade_created")) });
  check(audit.some((row) => (row.detail as { tradeId?: string; mode?: string }).tradeId === trade.id && (row.detail as { mode?: string }).mode === "server"), "The audit log records it as server-signed");
}

async function checkGasless() {
  section("Gasless mode");
  const { userId, address } = await makeUser();
  const balance = await usdcBalance(userId);
  check(D(balance.spendable).eq(balance.usdc), "A trade can use the whole balance, with nothing held back");
  const quote = await storeQuote(userId, address, uniswapProvider, "5");
  check(D(quote.winner.gasUsd).eq(0), "A Uniswap quote charges the user no gas");
  try {
    await runTrade(userId, quote.id, true);
    check(false, "A trade without one-tap should be refused");
  } catch (err) {
    check(err instanceof AppError && err.code === "needs_one_tap", `Without one-tap, it asks for it: "${err instanceof Error ? err.message : err}"`);
  }
  await db().insert(schema.signerGrants).values({ userId, perTradeCapUsd: "50", dailyCapUsd: "200", expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  const signed = await storeQuote(userId, address, uniswapProvider, "5");
  const trade = await runTrade(userId, signed.id, false);
  // Nothing lands: Pimlico simulates it first, and an empty wallet can't pay the $5.
  check(trade.status === "failed" && /nothing was sent/i.test(trade.error ?? ""), `With one-tap, it goes through sponsorship, and an empty wallet stops at the simulation: "${trade.error}"`);
}

async function main() {
  await useThrowawayDatabase();
  // The wallet-signed path below only runs with gasless off. Gasless gets its own section at the end.
  const pimlicoKey = process.env.PIMLICO_API_KEY;
  process.env.PIMLICO_API_KEY = "";
  resetEnvForTests();
  if (isPaperMode()) throw new Error("TRADING_MODE is paper. This test only means something in live mode.");
  const before = await arcUsdcBalance(await gasWalletAddress());
  const realBuy = await checkRealSwaps();
  const wallet = await makeUser();
  await checkEmptyWalletIsRefused(wallet.userId, wallet.address);
  await checkUniswapBuy(wallet.userId, wallet.address, realBuy);
  const flashUser = await makeUser();
  await checkFlashWalletFlow(flashUser.userId, flashUser.address, flashUser.walletId);
  const oneTapUser = await makeUser();
  await checkOneTap(oneTapUser.userId, oneTapUser.address);

  if (pimlicoKey) {
    process.env.PIMLICO_API_KEY = pimlicoKey;
    resetEnvForTests();
    await checkGasless();
  }

  section("Afterwards");
  const after = await arcUsdcBalance(await gasWalletAddress());
  check(after === before, `The gas wallet wasn't touched: still ${formatUnits(after, 6)} USDC`);
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exitCode = failures ? 1 : 0;
}

async function gasWalletAddress(): Promise<Hex> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { normalizePrivateKey } = await import("../src/trading/signer");
  return privateKeyToAccount(normalizePrivateKey(env().GAS_TOPUP_PRIVATE_KEY!)).address;
}

main()
  .catch((err) => {
    process.exitCode = 1;
    console.error(err instanceof Error ? err.message.slice(0, 500) : err);
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeDb().catch(() => {});
    process.exit();
  });
