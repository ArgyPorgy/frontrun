/**
 * Deploys the three proof contracts to Base mainnet from the gas wallet, and prints their addresses:
 * ThesisRegistry, PositionLedger and ReputationRegistry.
 *   pnpm proof:deploy
 *
 * Run `forge build` in onchain/ first. Addresses go in packages/core/src/chains.ts. They're public, so they
 * live in the code rather than in the environment. Refuses to run once those are set, so a second run can't
 * leave stray contracts behind. Every deployment carries Front Run's Builder Code. Costs well under a cent in ETH.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSITION_LEDGER_BASE, REPUTATION_REGISTRY_BASE, THESIS_REGISTRY_BASE, builderCodeSuffix } from "@frontrun/core";
import { createWalletClient, formatEther, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { env } from "../src/env";
import { evmClient } from "../src/onchain";
import { normalizePrivateKey } from "../src/trading/signer";

async function main() {
  const e = env();
  if (THESIS_REGISTRY_BASE || POSITION_LEDGER_BASE || REPUTATION_REGISTRY_BASE) throw new Error("Already deployed. Clear the Base addresses in chains.ts to deploy again.");
  if (!e.GAS_TOPUP_PRIVATE_KEY) throw new Error("GAS_TOPUP_PRIVATE_KEY is needed to pay for the deployment.");

  const here = dirname(fileURLToPath(import.meta.url));
  const account = privateKeyToAccount(normalizePrivateKey(e.GAS_TOPUP_PRIVATE_KEY));
  const client = evmClient("base");
  const chainId = await client.getChainId();
  if (chainId !== base.id) throw new Error(`RPC is on chain ${chainId}, not Base mainnet.`);
  const balance = await client.getBalance({ address: account.address });
  console.log(`Deployer ${account.address}, ${formatEther(balance)} ETH on Base mainnet`);
  if (balance < 100_000_000_000_000n) throw new Error("Under 0.0001 ETH, which is too thin to deploy safely.");

  const wallet = createWalletClient({ account, chain: base, transport: http(e.BASE_RPC_URL, { timeout: 60_000 }) });
  for (const name of ["ThesisRegistry", "PositionLedger", "ReputationRegistry"]) {
    const artifact = JSON.parse(readFileSync(join(here, `../../../onchain/out/${name}.sol/${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account.address, account.address], dataSuffix: builderCodeSuffix() });
    console.log(`${name} sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment failed: ${receipt.status}`);
    const read = (functionName: string) => client.readContract({ address: receipt.contractAddress!, abi: artifact.abi, functionName, args: [] });
    const [owner, relayer] = await Promise.all([read("owner"), read("relayer")]);
    if (owner !== account.address || relayer !== account.address) throw new Error(`${name} deployed, but its owner or relayer doesn't match.`);
    console.log(`${name}=${receipt.contractAddress}`);
  }
  const after = await client.getBalance({ address: account.address });
  console.log(`Gas cost: ${formatEther(balance - after)} ETH`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
