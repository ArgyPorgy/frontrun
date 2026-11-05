/**
 * Proves gasless trading works end to end on real chains, using brand-new wallets that hold no funds.
 *   pnpm sponsor:test
 *
 * This sends real sponsored transactions, so it spends a few cents of Pimlico credit. No user funds are
 * involved: the wallets are empty, which is the point, since each step has to land with no gas in the
 * wallet. It covers what can't be checked any other way:
 * - an empty wallet upgrades and sends a transaction, and still holds nothing afterwards
 * - a second transaction works on the upgraded wallet
 * - Flash accepts an order signature from the upgraded wallet, refusing it only for the empty balance
 */
import { randomUUID } from "node:crypto";
import { ARC_USDC, FLASH_ALLOWANCE_ARC } from "@frontrun/core";
import { concat, encodeFunctionData, erc20Abi, formatEther, hashTypedData, parseAbi, type Hex } from "viem";
import { entryPoint07Abi, entryPoint07Address } from "viem/account-abstraction";
import { env } from "../src/env";
import { fetchJson, HttpError } from "../src/http";
import { erc20Allowance, evmClient } from "../src/onchain";
import { assertOrderMatches, flashProvider, type FlashQuoteRaw } from "../src/providers/flash";
import type { RouteRequest } from "../src/providers/types";
import { uniswapProvider } from "../src/providers/uniswap";
import { closeRedis } from "../src/redis";
import { authContext, privy } from "../src/trading/signer";
import { SMART_ACCOUNT_IMPLEMENTATION, sendSponsored, sponsorshipConfigured } from "../src/trading/sponsor";

const BASE_WETH = "0x4200000000000000000000000000000000000006";
const ARC_WETH = "0x128cc466b61f542da60c70e3aa11c10e19b84edb";
const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const FORGED_SIGNATURE = "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
const MAX = 2n ** 256n - 1n;
const DELEGATED = concat(["0xef0100", SMART_ACCOUNT_IMPLEMENTATION]).toLowerCase();

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

async function makeWallet() {
  const e = env();
  const wallet = await privy()
    .wallets()
    .create({ chain_type: "ethereum", owner_id: e.PRIVY_SIGNER_ID!, policy_ids: [e.PRIVY_POLICY_IDS!.split(",")[0]!.trim()], external_id: `gasless${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  return { id: wallet.id, address: wallet.address.toLowerCase() };
}

const approve = (spender: string, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] });

/** The first sell on another chain, which is what blocked real trading. */
async function checkFirstSellApproval(chain: "base" | "arbitrum", token: string) {
  console.log(`\nFirst-sell approval on ${chain}, from an empty wallet`);
  const wallet = await makeWallet();
  const client = evmClient(chain);
  const before = await client.getBalance({ address: wallet.address as Hex });
  check(before === 0n, `The wallet holds no ${chain} gas token`);
  const tx = await sendSponsored({ walletId: wallet.id, sender: wallet.address, chain, to: token, data: approve(FLASH_ALLOWANCE_ARC, MAX) });
  console.log(`  INFO  Landed: ${tx}`);
  const allowance = await erc20Allowance(chain, token, wallet.address, FLASH_ALLOWANCE_ARC);
  check(allowance > 0n, "The approval is on-chain");
  const code = await client.getCode({ address: wallet.address as Hex });
  check(code?.toLowerCase() === DELEGATED, "The wallet upgraded in place, at the same address");
  const after = await client.getBalance({ address: wallet.address as Hex });
  check(after === 0n, `It still holds nothing, so it paid no gas (${formatEther(after)})`);
}

async function checkArc() {
  console.log("\nArc, from an empty wallet");
  const wallet = await makeWallet();
  const client = evmClient("arc");
  const tx = await sendSponsored({ walletId: wallet.id, sender: wallet.address, chain: "arc", to: ARC_USDC, data: approve(FLASH_ALLOWANCE_ARC, MAX) });
  console.log(`  INFO  Upgrade and approval landed: ${tx}`);
  check((await erc20Allowance("arc", ARC_USDC, wallet.address, FLASH_ALLOWANCE_ARC)) > 0n, "The USDC approval to Flash is on-chain");
  check((await client.getBalance({ address: wallet.address as Hex })) === 0n, "It still holds nothing, so it paid no gas");

  const second = await sendSponsored({ walletId: wallet.id, sender: wallet.address, chain: "arc", to: ARC_USDC, data: approve(FLASH_ALLOWANCE_ARC, 0n) });
  console.log(`  INFO  Second operation landed: ${second}`);
  check((await erc20Allowance("arc", ARC_USDC, wallet.address, FLASH_ALLOWANCE_ARC)) === 0n, "A later operation works without upgrading again");
  await sendSponsored({ walletId: wallet.id, sender: wallet.address, chain: "arc", to: ARC_USDC, data: approve(FLASH_ALLOWANCE_ARC, MAX) });

  // The real question for Flash: does it accept this signature now that the wallet has code?
  const request: RouteRequest = { side: "buy", chain: "base", address: BASE_WETH, decimals: 18, usdcIn: "1", evmAddress: wallet.address, solanaAddress: null, priceUsd: "2400", notionalUsd: "1" };
  const quote = await flashProvider.quote(request);
  const raw = quote.raw as FlashQuoteRaw;
  check(!raw.evm?.approveTx, "Flash sees the approval, and asks for no more setup");
  const typed = raw.evm?.orderTypedData;
  if (!typed) return check(false, "Flash returned an order to sign");
  assertOrderMatches(typed, { funder: wallet.address, spentToken: ARC_USDC, chainId: 5042, fromAmount: 1_000_000n });
  const parsed = JSON.parse(typed) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };
  const { signature } = await privy()
    .wallets()
    .ethereum()
    .signTypedData(wallet.id, { params: { typed_data: { domain: parsed.domain, types: parsed.types, message: parsed.message, primary_type: parsed.primaryType } }, authorization_context: authContext() });
  // The check that doesn't depend on Flash's error order: the wallet's own contract, on-chain.
  const hash = hashTypedData({ domain: parsed.domain, types: parsed.types, primaryType: parsed.primaryType, message: parsed.message } as Parameters<typeof hashTypedData>[0]);
  const magic = await client.readContract({ address: wallet.address as Hex, abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, signature as Hex] });
  check(magic === "0x1626ba7e", "The upgraded wallet's contract validates the order signature on-chain");
  const forged = await client.readContract({ address: wallet.address as Hex, abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, FORGED_SIGNATURE] }).catch(() => "reverted");
  check(forged !== "0x1626ba7e", "It rejects a forged signature");

  const submit = async (candidate: string) => {
    try {
      await flashProvider.advance({ tradeId: randomUUID(), userId: "test", request, quote, completed: [{ id: "order", signature: candidate }] });
      return "accepted";
    } catch (err) {
      return err instanceof HttpError ? err.body : String(err);
    }
  };
  const real = await submit(signature);
  console.log(`  INFO  Flash on the real signature: ${real.slice(0, 150)}`);
  const fake = await submit(FORGED_SIGNATURE);
  console.log(`  INFO  Flash on a forged signature: ${fake.slice(0, 150)}`);
  check(/balance/i.test(real), "Flash refuses the real signature only for the empty balance");
  if (fake === real || /balance/i.test(fake)) console.log("  INFO  Flash checks the balance first, so its answer alone doesn't prove the signature. The on-chain check above does.");
  else check(true, "Flash tells a forged signature apart from the real one");

  await checkUniswapThroughAccount(wallet.address);
}

/** A real swap through an upgraded wallet, with a pretend balance, so nothing is spent. */
async function checkUniswapThroughAccount(sender: string) {
  const request: RouteRequest = { side: "buy", chain: "arc", address: ARC_WETH, decimals: 18, usdcIn: "5", evmAddress: sender, solanaAddress: null, priceUsd: "2300", notionalUsd: "5" };
  const quote = await uniswapProvider.quote(request);
  const next = await uniswapProvider.advance({ tradeId: randomUUID(), userId: "test", request, quote, completed: [] });
  const step = "steps" in next ? next.steps[0] : null;
  if (step?.kind !== "evm_tx") return check(false, "Uniswap returned a swap to send");
  const client = evmClient("arc");
  const sequence = await client.readContract({ address: entryPoint07Address, abi: entryPoint07Abi, functionName: "getNonce", args: [sender as Hex, 1n] });
  const callData = encodeFunctionData({ abi: parseAbi(["function execute(address,uint256,bytes)"]), functionName: "execute", args: [step.to as Hex, BigInt(step.value ?? 0), step.data as Hex] });
  const res = await fetchJson<{ result?: unknown; error?: { message?: string } }>(`https://api.pimlico.io/v2/5042/rpc?apikey=${env().PIMLICO_API_KEY}`, {
    method: "POST",
    timeoutMs: 20_000,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_estimateUserOperationGas",
      params: [
        { sender, nonce: `0x${sequence.toString(16)}`, callData, maxFeePerGas: "0x6c2eb3c00", maxPriorityFeePerGas: "0xa7d8c0", signature: concat(["0xff00", FORGED_SIGNATURE]) },
        entryPoint07Address,
        { [sender]: { balance: "0x1158e460913d00000" } },
      ],
    },
  });
  check(!res.error, res.error ? `A $5 Uniswap buy through the upgraded wallet: ${res.error.message?.slice(0, 200)}` : "A real $5 Uniswap buy simulates successfully through the upgraded wallet, with its gas estimated");
}

async function main() {
  if (!sponsorshipConfigured("arc")) throw new Error("Set PIMLICO_API_KEY in .env first.");
  await checkArc();
  await checkFirstSellApproval("base", BASE_WETH);
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. Trading is gasless on these chains.");
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    process.exitCode = 1;
    console.error(err instanceof Error ? err.message.slice(0, 400) : err);
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    process.exit();
  });
