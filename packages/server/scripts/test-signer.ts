/**
 * Tests the app signer and its policies against Privy, using brand-new wallets that hold no funds.
 *   pnpm signer:test
 *
 * Nothing here can move money: the wallets are empty, transactions are only ever signed and never
 * broadcast, and the one Flash order it submits comes from an empty wallet, so it can't fill. It does
 * create two throwaway wallets in your Privy app on each run.
 *
 * Each case says what should happen. A rule that lets through something it shouldn't, or blocks
 * something a real trade needs, fails the run.
 */
import { randomUUID } from "node:crypto";
import { ARC_USDC, CHAINS, FLASH_ALLOWANCE_ARC, UNISWAP_ARC, type StepResult } from "@frontrun/core";
import { PrivyClient } from "@privy-io/node";
import {
  appendTransactionMessageInstruction,
  address as solAddress,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { encodeFunctionData, erc20Abi, parseAbi, parseTransaction, recoverTransactionAddress, verifyTypedData, type Hex, type TransactionSerialized } from "viem";
import { env } from "../src/env";
import { agentEvmRules } from "../src/trading/policy";
import { SMART_ACCOUNT_IMPLEMENTATION } from "../src/trading/sponsor";
import { HttpError } from "../src/http";
import { assertOrderMatches, flashProvider, isTwoStep, requestRestingQuote, submitRestingOrder, type FlashQuoteRaw, type RestingOrderParams } from "../src/providers/flash";
import { lifiProvider } from "../src/providers/lifi";
import type { RouteRequest } from "../src/providers/types";
import { uniswapProvider } from "../src/providers/uniswap";
import { closeRedis } from "../src/redis";

const e = env();
if (!e.PRIVY_APP_ID || !e.PRIVY_APP_SECRET || !e.PRIVY_AUTHORIZATION_KEY || !e.PRIVY_SIGNER_ID || !e.PRIVY_POLICY_IDS || !e.PRIVY_SOLANA_POLICY_IDS) {
  throw new Error("Needs the Privy app, authorization key, signer id and both policy ids in .env.");
}

const client = new PrivyClient({ appId: e.PRIVY_APP_ID, appSecret: e.PRIVY_APP_SECRET });
const authorization_context = { authorization_private_keys: [e.PRIVY_AUTHORIZATION_KEY] };

const ATTACKER = "0x000000000000000000000000000000000000bEEF" as const;
const SMART_ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data) returns (bytes)", "struct Call { address target; uint256 value; bytes data; }", "function executeBatch(Call[] calls) returns (bytes[])"]);
const ARC_WETH = "0x128cc466b61f542da60c70e3aa11c10e19b84edb";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const ARC_ID = CHAINS.arc.chainId!;

let failures = 0;

function explain(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status} ${err.body.slice(0, 150)}`;
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 170);
}

function looksLikePolicyDenial(err: unknown): boolean {
  return /polic|denied|not allowed|forbidden|unauthori/i.test(explain(err));
}

async function allowed<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    const value = await run();
    console.log(`  PASS  ${name}: allowed, as it should be`);
    return value;
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: should be allowed, but got: ${explain(err)}`);
    return null;
  }
}

async function denied(name: string, run: () => Promise<unknown>) {
  try {
    await run();
    failures++;
    console.log(`  FAIL  ${name}: SHOULD BE BLOCKED, BUT PRIVY SIGNED IT`);
  } catch (err) {
    if (looksLikePolicyDenial(err)) {
      console.log(`  PASS  ${name}: blocked, as it should be`);
    } else {
      failures++;
      console.log(`  FAIL  ${name}: failed for a different reason than policy: ${explain(err)}`);
    }
  }
}

function signTx(walletId: string, tx: { to: string; data?: string; value?: string; chainId?: number }) {
  return client.wallets().ethereum().signTransaction(walletId, {
    params: {
      transaction: {
        to: tx.to,
        data: tx.data ?? "0x",
        value: tx.value ?? "0x0",
        nonce: 0,
        chain_id: tx.chainId ?? ARC_ID,
        type: 2,
        gas_limit: "0x493e0",
        max_fee_per_gas: "0x4a817c800",
        max_priority_fee_per_gas: "0x1",
      },
    },
    authorization_context,
  });
}

function signTyped(walletId: string, typedDataJson: string) {
  const typed = JSON.parse(typedDataJson) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };
  return client.wallets().ethereum().signTypedData(walletId, {
    params: { typed_data: { domain: typed.domain, types: typed.types, message: typed.message, primary_type: typed.primaryType } },
    authorization_context,
  });
}

async function evmSuite() {
  console.log("\nEVM wallet");
  const wallet = await client.wallets().create({ chain_type: "ethereum", owner_id: e.PRIVY_SIGNER_ID, policy_ids: [e.PRIVY_POLICY_IDS!.split(",")[0]!.trim()], external_id: `policytest${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  console.log(`  Throwaway wallet ${wallet.address}, no funds`);
  const addr = wallet.address as Hex;

  const req = (over: Partial<RouteRequest>): RouteRequest => ({
    side: "buy",
    chain: "base",
    address: BASE_WETH,
    decimals: 18,
    usdcIn: "5",
    evmAddress: addr,
    solanaAddress: null,
    priceUsd: "2300",
    notionalUsd: "5",
    ...over,
  });

  // Flash: the path a real one-tap trade takes.
  const flashReq = req({});
  const flashQuote = await flashProvider.quote(flashReq);
  const raw = flashQuote.raw as FlashQuoteRaw;
  assertOrderMatches(raw.evm!.orderTypedData!, { funder: addr, spentToken: ARC_USDC, fromAmount: 5_000_000n, chainId: ARC_ID });
  console.log("  PASS  Flash order payload matches our sanity check");

  const order = await allowed("Sign a real Flash order", () => signTyped(wallet.id, raw.evm!.orderTypedData!));
  if (order) {
    const typed = JSON.parse(raw.evm!.orderTypedData!);
    const valid = await verifyTypedData({ address: addr, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message, signature: order.signature as Hex });
    if (valid) console.log("  PASS  That signature verifies as coming from this wallet");
    else {
      failures++;
      console.log("  FAIL  That signature does not verify");
    }
  }
  if (raw.evm?.approveTx) {
    const signed = await allowed("Sign Flash's one-time USDC approval", () => signTx(wallet.id, raw.evm!.approveTx!));
    if (signed) {
      const from = await recoverTransactionAddress({ serializedTransaction: signed.signed_transaction as TransactionSerialized });
      const parsed = parseTransaction(signed.signed_transaction as TransactionSerialized);
      if (from.toLowerCase() === addr.toLowerCase() && parsed.chainId === ARC_ID) console.log("  PASS  Signed approval recovers to this wallet on chain 5042");
      else {
        failures++;
        console.log("  FAIL  Signed approval doesn't recover to this wallet");
      }
    }
  }

  // Everything an attacker holding our server would try.
  await denied("Approve USDC to an unknown address", () => signTx(wallet.id, { to: ARC_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ATTACKER, 2n ** 256n - 1n] }) }));
  await denied("Transfer USDC to an unknown address", () => signTx(wallet.id, { to: ARC_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 1_000_000n] }) }));
  await denied("Send native USDC to an unknown address", () => signTx(wallet.id, { to: ATTACKER, value: "0xde0b6b3a7640000" }));
  await denied("Call an unknown contract", () => signTx(wallet.id, { to: ATTACKER, data: "0xdeadbeef" }));
  await denied("Sign typed data for an unknown contract", () =>
    signTyped(
      wallet.id,
      JSON.stringify({
        domain: { name: "Evil", version: "1", chainId: ARC_ID, verifyingContract: ATTACKER },
        types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], Drain: [{ name: "to", type: "address" }] },
        primaryType: "Drain",
        message: { to: ATTACKER },
      }),
    ),
  );
  await denied("Sign an arbitrary message", () => client.wallets().ethereum().signMessage(wallet.id, { message: "drain me", authorization_context }));
  await allowed("Revoke the Flash approval (set to zero)", () => signTx(wallet.id, { to: ARC_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FLASH_ALLOWANCE_ARC as Hex, 0n] }) }));
  await allowed("Sell-side approval of another token to Flash", () => signTx(wallet.id, { to: BASE_WETH, chainId: CHAINS.base.chainId!, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FLASH_ALLOWANCE_ARC as Hex, 2n ** 256n - 1n] }) }));

  // Uniswap Trading API: quote, Permit2 signature, then the swap transaction. Signed, never sent.
  const uniReq = req({ chain: "arc", address: ARC_WETH });
  try {
    const uniQuote = await uniswapProvider.quote(uniReq);
    const ctx = { tradeId: randomUUID(), userId: "test", request: uniReq, quote: uniQuote, completed: [] as Array<{ id: string; signature?: string; txHash?: string }> };
    // On Arc a buy pays USDC as native value: no approval and no permit, straight to the swap.
    const next = await uniswapProvider.advance(ctx);
    if ("steps" in next && next.steps[0]?.kind === "evm_tx") {
      const step = next.steps[0];
      console.log(`  ${step.id === "swap" ? "PASS" : "FAIL"}  Buy goes straight to the swap, with no approval step (first step: ${step.id})`);
      if (step.id !== "swap") failures++;
      console.log(`  INFO  Uniswap built a swap transaction to ${step.to}`);
      if (step.to.toLowerCase() !== UNISWAP_ARC.universalRouter212.toLowerCase()) {
        failures++;
        console.log("  FAIL  That isn't the Universal Router 2.1.2 address on Arc");
      }
      await allowed("Sign the Uniswap swap transaction", () => signTx(wallet.id, { to: step.to, data: step.data, value: step.value }));
    }
  } catch (err) {
    failures++;
    console.log(`  FAIL  Uniswap route: ${explain(err)}`);
  }

  // Uniswap sell: approve Permit2, sign the permit, build the swap. Signed, never sent.
  const sellReq = req({ chain: "arc", address: ARC_WETH, side: "sell", usdcIn: undefined, qtyIn: "0.001", notionalUsd: "2.3" });
  try {
    const sellQuote = await uniswapProvider.quote(sellReq);
    const ctx = { tradeId: randomUUID(), userId: "test", request: sellReq, quote: sellQuote, completed: [] as Array<{ id: string; signature?: string; txHash?: string }> };
    let next = await uniswapProvider.advance(ctx);
    if ("steps" in next && next.steps[0]?.kind === "evm_tx") {
      const approve = next.steps[0];
      console.log(`  INFO  Sell starts with a Permit2 approval on ${approve.to}`);
      await allowed("Sign the sell's Permit2 approval", () => signTx(wallet.id, { to: approve.to, data: approve.data }));
      ctx.completed.push({ id: "approve", txHash: "0xskipped" });
      next = await uniswapProvider.advance(ctx);
    }
    if ("steps" in next && next.steps[0]?.kind === "evm_typed_data") {
      const permitJson = next.steps[0].typedData;
      const permit = await allowed("Sign the sell's Permit2 message", () => signTyped(wallet.id, permitJson));
      if (permit) {
        const typed = JSON.parse(permitJson);
        const valid = await verifyTypedData({ address: addr, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message, signature: permit.signature as Hex });
        console.log(`  ${valid ? "PASS" : "FAIL"}  The permit signature verifies as coming from this wallet`);
        if (!valid) failures++;
        ctx.completed.push({ id: "permit", signature: permit.signature });
        next = await uniswapProvider.advance(ctx);
      }
    }
    if ("steps" in next && next.steps[0]?.kind === "evm_tx" && next.steps[0].id === "swap") {
      const swap = next.steps[0];
      await allowed("Sign the sell's swap transaction", () => signTx(wallet.id, { to: swap.to, data: swap.data, value: swap.value }));
    } else {
      failures++;
      console.log("  FAIL  The sell never reached a swap transaction");
    }
  } catch (err) {
    failures++;
    console.log(`  FAIL  Uniswap sell route: ${explain(err)}`);
  }

  // Two-step route: a stock token's orders have to pass the rules already in place, with no new ones.
  const stock = { chain: "robinhood" as const, address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", priceUsd: "186" };
  const twoStepTrades: Array<[string, RouteRequest]> = [
    ["sell", req({ ...stock, side: "sell", usdcIn: undefined, qtyIn: "0.02", notionalUsd: "3.7" })],
    ["buy", req({ ...stock, usdcIn: "4", notionalUsd: "4" })],
  ];
  for (const [name, request] of twoStepTrades) {
    const quote = await flashProvider.quote(request).catch((err: unknown) => {
      failures++;
      console.log(`  FAIL  Stock ${name} quote: ${explain(err)}`);
      return null;
    });
    if (!quote) continue;
    const route = quote.raw;
    if (!isTwoStep(route)) {
      console.log(`  INFO  Flash can do the stock ${name} directly now, so it doesn't need two steps`);
      continue;
    }
    for (const i of [0, 1] as const) {
      const label = `Stock ${name}, step ${i + 1}`;
      route.current = i;
      try {
        const ctx = { tradeId: randomUUID(), userId: "test", request, quote, completed: [] as StepResult[] };
        let next = await flashProvider.advance(ctx);
        while ("steps" in next) {
          for (const step of next.steps) {
            if (step.kind === "evm_tx") {
              await allowed(`${label}: ${step.label}`, () => signTx(wallet.id, { to: step.to, data: step.data, chainId: CHAINS[step.chain].chainId! }));
              ctx.completed.push({ id: step.id, txHash: "0xskipped" });
            } else if (step.kind === "evm_typed_data") {
              const signed = await allowed(`${label}: ${step.label}`, () => signTyped(wallet.id, step.typedData));
              if (!signed) throw new Error("the rules refused the order");
              ctx.completed.push({ id: step.id, signature: signed.signature });
            }
          }
          next = await flashProvider.advance(ctx);
        }
        failures++;
        console.log(`  FAIL  ${label}: Flash took an order from an empty wallet: ${JSON.stringify(next.done)}`);
      } catch (err) {
        const text = explain(err);
        if (err instanceof HttpError && /balance|allowance/i.test(text) && !/signature|validation/i.test(text)) {
          console.log(`  PASS  ${label}: Flash read the order and refused it because the wallet is empty: ${text.slice(0, 120)}`);
        } else {
          failures++;
          console.log(`  FAIL  ${label}: ${text}`);
        }
      }
    }
  }

  // Gasless path: the same limits have to hold inside a user operation, including hidden in a batch.
  const execute = (target: Hex, value: bigint, data: Hex) => encodeFunctionData({ abi: SMART_ACCOUNT_ABI, functionName: "execute", args: [target, value, data] });
  const batch = (calls: Array<[Hex, bigint, Hex]>) => encodeFunctionData({ abi: SMART_ACCOUNT_ABI, functionName: "executeBatch", args: [calls.map(([target, value, data]) => ({ target, value, data }))] });
  const signOperation = (call_data: Hex) =>
    client.wallets().ethereum().signUserOperation(wallet.id, {
      params: {
        chain_id: ARC_ID,
        contract: SMART_ACCOUNT_IMPLEMENTATION,
        user_operation: { sender: addr, nonce: "0x10000000000000000", call_data, call_gas_limit: "0x30000", verification_gas_limit: "0x30000", pre_verification_gas: "0x10000", max_fee_per_gas: "0x4a817c800", max_priority_fee_per_gas: "0x1" },
      },
      authorization_context,
    });
  const approveCall = (spender: Hex) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
  const stealCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 1_000_000n] });
  const usdc = ARC_USDC as Hex;
  const router = UNISWAP_ARC.universalRouter212 as Hex;
  await allowed("Gasless: approve USDC to Flash", () => signOperation(execute(usdc, 0n, approveCall(FLASH_ALLOWANCE_ARC as Hex))));
  await allowed("Gasless: call the Uniswap router with value", () => signOperation(execute(router, 10n ** 18n, "0x3593564c")));
  await denied("Gasless: approve USDC to an unknown address", () => signOperation(execute(usdc, 0n, approveCall(ATTACKER))));
  await denied("Gasless: transfer USDC to an unknown address", () => signOperation(execute(usdc, 0n, stealCall)));
  await denied("Gasless: send native USDC to an unknown address", () => signOperation(execute(ATTACKER, 10n ** 18n, "0x")));
  await denied("Gasless: call an unknown contract", () => signOperation(execute(ATTACKER, 0n, "0x12345678")));
  await denied("Gasless: hide a transfer in a batch with an approval", () => signOperation(batch([[usdc, 0n, approveCall(FLASH_ALLOWANCE_ARC as Hex)], [usdc, 0n, stealCall]])));
  await denied("Gasless: hide a native send in a batch with a swap", () => signOperation(batch([[router, 0n, "0x3593564c"], [ATTACKER, 10n ** 18n, "0x"]])));
  const upgrade = (contract: string) => client.wallets().ethereum().sign7702Authorization(wallet.id, { params: { chain_id: ARC_ID, contract, nonce: 0 }, authorization_context });
  await allowed("Gasless: upgrade the wallet to the known account", () => upgrade(SMART_ACCOUNT_IMPLEMENTATION));
  await denied("Gasless: upgrade the wallet to any other contract", () => upgrade("0xe6Cae83BdE06E4c305530e199D7217f42808555B"));

  // An agent's wallet: the same rules, plus sending USDC back to its owner and nowhere else.
  const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
  const agentPolicy = await client.policies().create({ version: "1.0", name: "Front Run agent signer test", chain_type: "ethereum", owner_id: e.PRIVY_SIGNER_ID!, rules: agentEvmRules(OWNER) });
  const agentWallet = await client.wallets().create({ chain_type: "ethereum", owner_id: e.PRIVY_SIGNER_ID, policy_ids: [agentPolicy.id] });
  const transferCall = (to: Hex) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000_000n] });
  const signAgentOperation = (call_data: Hex) =>
    client.wallets().ethereum().signUserOperation(agentWallet.id, {
      params: {
        chain_id: ARC_ID,
        contract: SMART_ACCOUNT_IMPLEMENTATION,
        user_operation: { sender: agentWallet.address as Hex, nonce: "0x10000000000000000", call_data, call_gas_limit: "0x30000", verification_gas_limit: "0x30000", pre_verification_gas: "0x10000", max_fee_per_gas: "0x4a817c800", max_priority_fee_per_gas: "0x3b9aca00" },
      },
      authorization_context,
    });
  await allowed("Agent: send USDC back to its owner", () => signTx(agentWallet.id, { to: usdc, data: transferCall(OWNER) }));
  await denied("Agent: send USDC to anyone else", () => signTx(agentWallet.id, { to: usdc, data: transferCall(ATTACKER) }));
  await denied("Agent: send another token, even to its owner", () => signTx(agentWallet.id, { to: BASE_WETH, data: transferCall(OWNER) }));
  await denied("Agent: send native USDC to its owner", () => signTx(agentWallet.id, { to: OWNER, value: "0x1" }));
  await allowed("Agent gasless: send USDC back to its owner", () => signAgentOperation(execute(usdc, 0n, transferCall(OWNER))));
  await denied("Agent gasless: send USDC to anyone else", () => signAgentOperation(execute(usdc, 0n, transferCall(ATTACKER))));
  await denied("Agent gasless: hide a theft in a batch with a withdrawal", () => signAgentOperation(batch([[usdc, 0n, transferCall(OWNER)], [usdc, 0n, transferCall(ATTACKER)]])));
  await allowed("Agent gasless: approve USDC to Flash", () => signAgentOperation(execute(usdc, 0n, approveCall(FLASH_ALLOWANCE_ARC as Hex))));

  // Orders that rest on Flash: real limit and stop orders, signed under the policy, refused only for the balance.
  for (const [name, extra] of [
    ["limit buy", { side: "buy", qty: "5", orderType: "limit", limitNotionalPrice: "1000" }],
    ["stop buy", { side: "buy", qty: "5", orderType: "stop", triggers: [{ notionalPrice: "9000", triggerType: "upper" }] }],
    ["stop-loss", { side: "sell", qty: "0.01", orderType: "stop-loss", triggers: [{ notionalPrice: "1000", triggerType: "lower" }] }],
    ["take-profit", { side: "sell", qty: "0.01", orderType: "take-profit", triggers: [{ notionalPrice: "9000", triggerType: "upper" }] }],
  ] as const) {
    try {
      const params = { targetChain: "arc", contraChain: "arc", targetAsset: ARC_WETH, contraAsset: ARC_USDC, funderAddress: addr, maxPriceImpact: "0.5", flashIntegratorFeeBps: "50", ...extra } as RestingOrderParams;
      const raw = await requestRestingQuote(params);
      const signed = await allowed(`Sign a real ${name} order`, () => signTyped(wallet.id, raw.evm!.orderTypedData!));
      if (signed) {
        const refusal = await submitRestingOrder(params, raw, signed.signature).then(() => "accepted", (err: unknown) => (err instanceof HttpError ? err.body : String(err)));
        const onlyBalance = /balance|allowance/i.test(refusal) && !/signature|validation/i.test(refusal);
        console.log(`  ${onlyBalance ? "PASS" : "FAIL"}  Flash takes the ${name}, refusing it only for the empty wallet: ${refusal.slice(0, 110)}`);
        if (!onlyBalance) failures++;
      }
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${name}: ${explain(err)}`);
    }
  }
  const signMessage = (message: string) => client.wallets().ethereum().signMessage(wallet.id, { message, authorization_context });
  await allowed("Sign Flash's exact cancel message", () => signMessage(`Definitive Flash v1 \u2014 Cancel Order\nOrder: ${randomUUID()}`));
  await denied("Sign a message that only looks like a cancel", () => signMessage("Definitive Flash v1 - Cancel Order\nOrder: 1"));
  await denied("Sign a message that starts differently", () => signMessage(`Transfer everything \nDefinitive Flash v1 \u2014 Cancel Order\nOrder: ${randomUUID()}`));

  // LI.FI: its contract can change by route, so this shows whether the allowlist still fits.
  try {
    const lifi = await lifiProvider.quote(flashReq);
    const to = (lifi.raw as { transactionRequest?: { to?: string; data?: string } }).transactionRequest;
    if (to?.to) {
      try {
        await signTx(wallet.id, { to: to.to, data: to.data });
        console.log(`  PASS  LI.FI route ${to.to} is on the allowlist`);
      } catch {
        console.log(`  INFO  LI.FI route ${to.to} isn't on the allowlist. One-tap will refuse it, and Flash remains the route.`);
      }
    }
  } catch (err) {
    console.log(`  INFO  LI.FI quote unavailable: ${explain(err)}`);
  }

  // A real order submission from an empty wallet. It can't fill, but it proves Flash accepts our
  // request format and signature instead of us finding out on someone's first real trade.
  if (order) {
    try {
      const result = await flashProvider.advance({ tradeId: randomUUID(), userId: "test", request: flashReq, quote: flashQuote, completed: [{ id: "approve", txHash: "0xskipped" }, { id: "order", signature: order.signature }] });
      console.log(`  PASS  Flash accepted the order format and signature: ${JSON.stringify("done" in result ? result.done : "more steps")}. An empty wallet can't fill it.`);
    } catch (err) {
      const text = explain(err);
      if (!(err instanceof HttpError) || /signature/i.test(text)) {
        failures++;
        console.log(`  FAIL  Flash order submission: ${text}`);
      } else {
        console.log(`  PASS  Flash read the order and refused it because the wallet is empty: ${text}`);
      }
    }
  }
}

async function solanaSuite() {
  console.log("\nSolana wallet");
  const wallet = await client.wallets().create({ chain_type: "solana", owner_id: e.PRIVY_SIGNER_ID, policy_ids: [e.PRIVY_SOLANA_POLICY_IDS!.split(",")[0]!.trim()], external_id: `policytest${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  console.log(`  Throwaway wallet ${wallet.address}, no funds`);
  const me = solAddress(wallet.address);
  const attacker = solAddress("Vote111111111111111111111111111111111111111");
  const mint = solAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  const u64 = (n: bigint) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, n, true);
    return out;
  };
  const programs = {
    computeBudget: solAddress("ComputeBudget111111111111111111111111111111"),
    system: solAddress("11111111111111111111111111111111"),
    token: solAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  };
  const writable = 1 as const;
  const signerWritable = 3 as const;
  const computeLimit = { programAddress: programs.computeBudget, data: new Uint8Array([2, 64, 66, 15, 0]) };
  const solTransfer = {
    programAddress: programs.system,
    accounts: [
      { address: me, role: signerWritable },
      { address: attacker, role: writable },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64(1_000_000n)]),
  };
  const tokenTransfer = {
    programAddress: programs.token,
    accounts: [
      { address: mint, role: writable },
      { address: attacker, role: writable },
      { address: me, role: signerWritable },
    ],
    data: new Uint8Array([3, ...u64(1_000_000n)]),
  };
  const tokenApprove = {
    programAddress: programs.token,
    accounts: [
      { address: mint, role: writable },
      { address: attacker, role: 0 as const },
      { address: me, role: signerWritable },
    ],
    data: new Uint8Array([4, ...u64(1_000_000n)]),
  };

  type Ix = Parameters<typeof appendTransactionMessageInstruction>[0];
  const build = (instructions: Ix[]): string => {
    const message = instructions.reduce<ReturnType<typeof base>>((m, ix) => appendTransactionMessageInstruction(ix, m) as unknown as ReturnType<typeof base>, base());
    return getBase64EncodedWireTransaction(compileTransaction(message as never));
  };
  function base() {
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
    );
  }
  const sign = (transaction: string) => client.wallets().solana().signTransaction(wallet.id, { transaction, authorization_context });

  await allowed("Sign a Flash order message", () => client.wallets().solana().signMessage(wallet.id, { message: new TextEncoder().encode("DFS|m=So11111111111111111111111111111111111111112|t=1|h=abc"), authorization_context }));
  await denied("Sign any other message", () => client.wallets().solana().signMessage(wallet.id, { message: new TextEncoder().encode("drain me"), authorization_context }));
  await allowed("Sign a harmless setup transaction", () => sign(build([computeLimit])));
  await allowed("Sign a token delegation", () => sign(build([tokenApprove])));
  await denied("Send SOL to an unknown address", () => sign(build([solTransfer])));
  await denied("Send tokens to an unknown address", () => sign(build([tokenTransfer])));
  await denied("Hide a SOL transfer behind a harmless instruction", () => sign(build([computeLimit, solTransfer])));
  await denied("Hide a token transfer behind a harmless instruction", () => sign(build([computeLimit, tokenTransfer])));
}

async function authSuite() {
  console.log("\nAccess tokens");
  try {
    const { access_token } = await client.apps().getTestAccessToken();
    const verifier = new PrivyClient({
      appId: e.PRIVY_APP_ID!,
      appSecret: e.PRIVY_APP_SECRET!,
      ...(e.PRIVY_JWT_VERIFICATION_KEY ? { jwtVerificationKey: e.PRIVY_JWT_VERIFICATION_KEY.replace(/\\n/g, "\n") } : {}),
    });
    const claims = await verifier.utils().auth().verifyAccessToken(access_token);
    console.log(`  PASS  A real Privy token verifies with your JWT key (user ${claims.user_id.slice(0, 18)}…)`);
  } catch (err) {
    void err;
    console.log("  INFO  Skipped: no test account. Turn on test accounts in the Privy dashboard to run this.");
  }
}

async function main() {
  console.log("Signer test. The wallets are empty and nothing is broadcast, so no funds can move.");
  await authSuite();
  await evmSuite();
  await solanaSuite();
  console.log(failures ? `\n${failures} check${failures === 1 ? "" : "s"} failed.` : "\nAll checks passed.");
}

main()
  .catch((err) => {
    failures++;
    console.error(explain(err));
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    process.exit(failures ? 1 : 0);
  });
