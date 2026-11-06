/**
 * Deploys PositionLedger and ReputationRegistry to Arc mainnet from the gas wallet, and prints their addresses.
 *   pnpm proof:deploy
 *
 * Run `forge build` in onchain/ first. Addresses go in packages/core/src/chains.ts. They're public, so they
 * live in the code rather than in the environment. Refuses to run once those are set, so a second run can't
 * leave stray contracts behind. Costs a fraction of a cent in USDC gas.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSITION_LEDGER_ARC, REPUTATION_REGISTRY_ARC } from "@frontrun/core";
import { createWalletClient, formatUnits, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import { env } from "../src/env";
import { arcUsdcBalance, evmClient } from "../src/onchain";
import { normalizePrivateKey } from "../src/trading/signer";

async function main() {
  const e = env();
  if (POSITION_LEDGER_ARC || REPUTATION_REGISTRY_ARC) throw new Error("Already deployed. Clear the addresses in chains.ts to deploy again.");
  if (!e.GAS_TOPUP_PRIVATE_KEY) throw new Error("GAS_TOPUP_PRIVATE_KEY is needed to pay for the deployment.");

  const here = dirname(fileURLToPath(import.meta.url));
  const account = privateKeyToAccount(normalizePrivateKey(e.GAS_TOPUP_PRIVATE_KEY));
  const client = evmClient("arc");
  const chainId = await client.getChainId();
  if (chainId !== arc.id) throw new Error(`RPC is on chain ${chainId}, not Arc mainnet.`);
  const balance = await arcUsdcBalance(account.address);
  console.log(`Deployer ${account.address}, ${formatUnits(balance, 6)} USDC on Arc mainnet`);
  if (balance < 100_000n) throw new Error("Under $0.10 of USDC, which is too thin to deploy safely.");

  const wallet = createWalletClient({ account, chain: arc, transport: http(e.ARC_RPC_URL, { timeout: 60_000 }) });
  for (const name of ["PositionLedger", "ReputationRegistry"]) {
    const artifact = JSON.parse(readFileSync(join(here, `../../../onchain/out/${name}.sol/${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account.address, account.address] });
    console.log(`${name} sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment failed: ${receipt.status}`);
    const read = (functionName: string) => client.readContract({ address: receipt.contractAddress!, abi: artifact.abi, functionName, args: [] });
    const [owner, relayer] = await Promise.all([read("owner"), read("relayer")]);
    if (owner !== account.address || relayer !== account.address) throw new Error(`${name} deployed, but its owner or relayer doesn't match.`);
    console.log(`${name}=${receipt.contractAddress}`);
  }
  const after = await arcUsdcBalance(account.address);
  console.log(`Gas cost: ${formatUnits(balance - after, 6)} USDC`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
