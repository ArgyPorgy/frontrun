/**
 * Deploys ThesisRegistry to Arc mainnet from the gas wallet, and prints its address.
 *   pnpm registry:deploy
 *
 * Run `forge build` in onchain/ first. Refuses to run if THESIS_REGISTRY_ADDRESS is already set, so a
 * second run can't leave a stray contract behind. Costs a fraction of a cent in USDC gas.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, formatUnits, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import { env } from "../src/env";
import { arcUsdcBalance, evmClient } from "../src/onchain";
import { normalizePrivateKey } from "../src/trading/signer";

async function main() {
  const e = env();
  if (e.THESIS_REGISTRY_ADDRESS) throw new Error(`Already deployed at ${e.THESIS_REGISTRY_ADDRESS}. Clear THESIS_REGISTRY_ADDRESS to redeploy.`);
  if (!e.GAS_TOPUP_PRIVATE_KEY) throw new Error("GAS_TOPUP_PRIVATE_KEY is needed to pay for the deployment.");

  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = JSON.parse(readFileSync(join(here, "../../../onchain/out/ThesisRegistry.sol/ThesisRegistry.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

  const account = privateKeyToAccount(normalizePrivateKey(e.GAS_TOPUP_PRIVATE_KEY));
  const client = evmClient("arc");
  const chainId = await client.getChainId();
  if (chainId !== arc.id) throw new Error(`RPC is on chain ${chainId}, not Arc mainnet.`);
  const balance = await arcUsdcBalance(account.address);
  console.log(`Deployer ${account.address}, ${formatUnits(balance, 6)} USDC on Arc mainnet`);
  if (balance < 100_000n) throw new Error("Under $0.10 of USDC, which is too thin to deploy safely.");

  const wallet = createWalletClient({ account, chain: arc, transport: http(e.ARC_RPC_URL) });
  const args = [account.address, account.address] as const;
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  console.log(`Sent: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${receipt.status}`);

  const read = (functionName: string) => client.readContract({ address: receipt.contractAddress!, abi: artifact.abi, functionName }) as Promise<string>;
  const [owner, relayer] = await Promise.all([read("owner"), read("relayer")]);
  if (owner !== account.address || relayer !== account.address) throw new Error("Deployed, but owner or relayer doesn't match.");

  const after = await arcUsdcBalance(account.address);
  console.log(`Gas cost: ${formatUnits(balance - after, 6)} USDC`);
  console.log(`THESIS_REGISTRY_ADDRESS=${receipt.contractAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
