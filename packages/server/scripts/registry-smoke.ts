/**
 * Proves the app's anchoring code works against the real contract on Arc mainnet.
 *   pnpm registry:smoke
 *
 * Sends one real anchor of a clearly labelled test hash, using the same code as the worker, costing a
 * fraction of a cent. That entry stays on-chain permanently, since the registry is append-only. The
 * failure cases are only simulated, so they cost nothing.
 *
 * Pass the hash of an earlier smoke transaction to re-run the checks without sending another anchor:
 *   pnpm registry:smoke 0xabc...
 */
import { randomUUID } from "node:crypto";
import { formatUnits, parseEventLogs, type Address, type Hex } from "viem";
import { THESIS_REGISTRY_ABI, anchorArgs, canonicalThesis, findAnchorTx, sendAnchor, thesisHash } from "../src/anchoring";
import { env } from "../src/env";
import { arcUsdcBalance, evmClient } from "../src/onchain";
import { closeRedis } from "../src/redis";
import { privateKeyToAccount } from "viem/accounts";
import { normalizePrivateKey } from "../src/trading/signer";

// Arc's public RPC starts refusing at a few requests a second.
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_000));

async function main() {
  const e = env();
  const registry = e.THESIS_REGISTRY_ADDRESS as Address;
  const key = e.ANCHOR_RELAYER_PRIVATE_KEY ?? e.GAS_TOPUP_PRIVATE_KEY;
  if (!registry || !key) throw new Error("Needs THESIS_REGISTRY_ADDRESS and a relayer key.");
  const relayer = privateKeyToAccount(normalizePrivateKey(key));
  const client = evmClient("arc");

  const input = {
    id: randomUUID(),
    author: relayer.address,
    chain: "arc",
    token: "0x128cc466b61f542da60c70e3aa11c10e19b84edb",
    body: "Front Run registry smoke test. Not a real thesis.",
    priceAtPost: "2284.319869114141878374",
    positionUsdAtPost: "25.000000000000000000",
    postedAt: Math.floor(Date.now() / 1000),
  };
  const existingTx = process.argv[2] as Hex | undefined;
  const txHash = existingTx ?? (await sendAnchor(anchorArgs(input)));
  console.log(`${existingTx ? "INFO  Re-checking" : "PASS  Anchored:"} tx ${txHash}`);

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const [event] = parseEventLogs({ abi: THESIS_REGISTRY_ABI, logs: receipt.logs, eventName: "ThesisAnchored" });
  if (!event) throw new Error("No ThesisAnchored event in the receipt.");
  const hash = existingTx ? event.args.thesisHash : thesisHash(canonicalThesis(input));
  const args = [hash, event.args.author, event.args.postedAt, event.args.priceAtPostE18, event.args.positionUsdAtPostE6] as const;
  const matches =
    event.args.thesisHash === hash &&
    event.args.author === relayer.address &&
    (existingTx ? true : event.args.postedAt === BigInt(input.postedAt)) &&
    event.args.priceAtPostE18 === 2284319869114141878374n &&
    event.args.positionUsdAtPostE6 === 25_000_000n;
  console.log(`${matches ? "PASS" : "FAIL"}  Event fields match what we sent, in the right decimals`);
  if (!matches) process.exitCode = 1;

  const anchoredAt = await client.readContract({ address: registry, abi: THESIS_REGISTRY_ABI, functionName: "anchoredAt", args: [hash] });
  console.log(`${anchoredAt > 0n ? "PASS" : "FAIL"}  anchoredAt reads back: ${new Date(Number(anchoredAt) * 1000).toISOString()}`);

  await pause();
  const recovered = await findAnchorTx(hash);
  console.log(`${recovered === txHash ? "PASS" : "FAIL"}  Recovery finds the same transaction from the hash alone`);
  if (recovered !== txHash) process.exitCode = 1;
  await pause();
  const unknown = await findAnchorTx(thesisHash(canonicalThesis({ ...input, id: randomUUID() })));
  console.log(`${unknown === null ? "PASS" : "FAIL"}  A hash that was never anchored reads as not anchored`);
  if (unknown !== null) process.exitCode = 1;

  const expectRevert = async (name: string, errorName: string, run: () => Promise<unknown>) => {
    try {
      await run();
      process.exitCode = 1;
      console.log(`FAIL  ${name}: should have reverted`);
    } catch (err) {
      const text = String(err);
      const ok = text.includes(errorName);
      if (!ok) process.exitCode = 1;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${ok ? `reverts with ${errorName}` : text.slice(0, 160)}`);
    }
  };
  await pause();
  await expectRevert("The same hash twice (simulated)", "AlreadyAnchored", () =>
    client.simulateContract({ account: relayer, address: registry, abi: THESIS_REGISTRY_ABI, functionName: "anchor", args }),
  );
  await pause();
  const fresh = anchorArgs({ ...input, id: randomUUID() });
  await expectRevert("A caller that isn't the relayer (simulated)", "NotRelayer", () =>
    client.simulateContract({ account: "0x000000000000000000000000000000000000dEaD", address: registry, abi: THESIS_REGISTRY_ABI, functionName: "anchor", args: fresh }),
  );

  const after = await arcUsdcBalance(relayer.address);
  console.log(`Cost: ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} USDC. Wallet now holds ${formatUnits(after, 6)} USDC.`);
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
