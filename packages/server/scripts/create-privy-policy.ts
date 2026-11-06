/**
 * Creates or updates the two Privy policies that limit what the app signer can do, and prints their ids.
 *   pnpm privy:policy
 * If a policy id is already in .env, that policy's rules are replaced, so re-running never duplicates.
 * Put any newly printed ids in PRIVY_POLICY_IDS and PRIVY_SOLANA_POLICY_IDS.
 *
 * Privy denies anything no rule allows, and DENY beats ALLOW. These rules are the enclave-side half
 * of the guardrails. The other half runs on our server before anything gets signed: caps, expiry,
 * and matching each payload against its quote. Both have to hold.
 *
 * `pnpm signer:test` checks these rules against Privy with a wallet that holds no funds.
 */
import { FLASH_ALLOWANCE_ARC, LIFI_CONTRACTS, PERMIT2, UNISWAP_ARC } from "@frontrun/core";
import { env } from "../src/env";
import { privy } from "../src/trading/signer";
import { SMART_ACCOUNT_IMPLEMENTATION } from "../src/trading/sponsor";

/** Privy's docs don't say how addresses are compared, so both spellings are listed. */
const anyCase = (addresses: string[]) => [...new Set(addresses.flatMap((a) => [a, a.toLowerCase()]))];

const LIFI = Object.values(LIFI_CONTRACTS);
const ROUTERS = anyCase([UNISWAP_ARC.universalRouter212, UNISWAP_ARC.v3SwapRouter02, ...LIFI]);
const APPROVABLE_SPENDERS = anyCase([FLASH_ALLOWANCE_ARC, PERMIT2, UNISWAP_ARC.v3SwapRouter02, ...LIFI]);

const APPROVE_ABI = [
  {
    type: "function" as const,
    name: "approve",
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/** We sign and broadcast through our own RPC, except sponsored sends, so both methods are covered. */
const EVM_TX_METHODS = ["eth_signTransaction", "eth_sendTransaction", "eth_signUserOperation"] as const;
/** Sponsored delegation is sign-only, and setup transactions are signed and sent. */
const SOLANA_TX_METHODS = ["signAndSendTransaction", "signTransaction"] as const;

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

const evmRules = () => [
  {
    name: "Cancel Flash orders",
    method: "personal_sign" as const,
    action: "ALLOW" as const,
    conditions: [{ field_source: "message" as const, field: "content" as const, operator: "starts_with" as const, value: "Definitive Flash v1 \u2014 Cancel Order\nOrder: " }],
  },
  {
    // Gasless wallets upgrade to this one contract, and nothing else.
    name: "Upgrade to the known account only",
    method: "eth_sign7702Authorization" as const,
    action: "ALLOW" as const,
    conditions: [{ field_source: "ethereum_7702_authorization" as const, field: "contract" as const, operator: "in" as const, value: anyCase([SMART_ACCOUNT_IMPLEMENTATION]) }],
  },
  {
    name: "Sign Flash orders",
    method: "eth_signTypedData_v4" as const,
    action: "ALLOW" as const,
    conditions: [{ field_source: "ethereum_typed_data_domain" as const, field: "verifyingContract" as const, operator: "in" as const, value: anyCase([FLASH_ALLOWANCE_ARC]) }],
  },
  {
    name: "Sign Permit2 approvals",
    method: "eth_signTypedData_v4" as const,
    action: "ALLOW" as const,
    conditions: [{ field_source: "ethereum_typed_data_domain" as const, field: "verifyingContract" as const, operator: "in" as const, value: anyCase([PERMIT2]) }],
  },
  ...EVM_TX_METHODS.map((method) => ({
    name: `Approve known spenders (${method})`,
    method,
    action: "ALLOW" as const,
    conditions: [
      {
        field_source: "ethereum_calldata" as const,
        field: "approve.spender",
        abi: APPROVE_ABI,
        operator: "in" as const,
        value: APPROVABLE_SPENDERS,
      },
    ],
  })),
  ...EVM_TX_METHODS.map((method) => ({
    name: `Call known routers (${method})`,
    method,
    action: "ALLOW" as const,
    conditions: [{ field_source: "ethereum_transaction" as const, field: "to" as const, operator: "in" as const, value: ROUTERS }],
  })),
];

const solanaRules = () => [
  // Moves out of the wallet are refused outright. Flash pulls through its own delegation.
  ...SOLANA_TX_METHODS.map((method) => ({
    name: `No direct token moves (${method})`,
    method,
    action: "DENY" as const,
    conditions: [
      {
        field_source: "solana_token_program_instruction" as const,
        field: "instructionName" as const,
        operator: "in" as const,
        value: ["Transfer", "TransferChecked", "Burn", "CloseAccount"],
      },
    ],
  })),
  ...SOLANA_TX_METHODS.map((method) => ({
    name: `No direct SOL sends (${method})`,
    method,
    action: "DENY" as const,
    conditions: [{ field_source: "solana_system_program_instruction" as const, field: "instructionName" as const, operator: "in" as const, value: ["Transfer"] }],
  })),
  ...SOLANA_TX_METHODS.map((method) => ({
    name: `Allow token setup (${method})`,
    method,
    action: "ALLOW" as const,
    conditions: [
      {
        field_source: "solana_program_instruction" as const,
        field: "programId" as const,
        operator: "in" as const,
        value: [SPL_TOKEN, SPL_TOKEN_2022, ASSOCIATED_TOKEN, COMPUTE_BUDGET],
      },
    ],
  })),
  {
    name: "Sign Flash order messages only",
    method: "signMessage" as const,
    action: "ALLOW" as const,
    conditions: [{ field_source: "message" as const, field: "content" as const, operator: "starts_with" as const, value: "DFS|" }],
  },
];

async function main() {
  const e = env();
  if (!e.PRIVY_SIGNER_ID) throw new Error("Set PRIVY_SIGNER_ID in .env first.");
  if (!e.PRIVY_AUTHORIZATION_KEY) throw new Error("Set PRIVY_AUTHORIZATION_KEY in .env first.");
  const client = privy();
  // Owned by the signer, as Privy recommends, so the app secret alone can't loosen these rules.
  const owner_id = e.PRIVY_SIGNER_ID;
  const authorization_context = { authorization_private_keys: [e.PRIVY_AUTHORIZATION_KEY] };

  if (e.PRIVY_POLICY_IDS) {
    const id = e.PRIVY_POLICY_IDS.split(",")[0]!.trim();
    const updated = await client.policies().update(id, { rules: evmRules(), authorization_context });
    console.log(`Updated EVM policy: ${updated.rules.length} rules.`);
  } else {
    const created = await client.policies().create({ version: "1.0", name: "Front Run app signer (EVM)", chain_type: "ethereum", owner_id, rules: evmRules() });
    console.log(`PRIVY_POLICY_IDS=${created.id}`);
  }

  if (e.PRIVY_SOLANA_POLICY_IDS) {
    const id = e.PRIVY_SOLANA_POLICY_IDS.split(",")[0]!.trim();
    const updated = await client.policies().update(id, { rules: solanaRules(), authorization_context });
    console.log(`Updated Solana policy: ${updated.rules.length} rules.`);
  } else {
    const created = await client.policies().create({ version: "1.0", name: "Front Run app signer (Solana)", chain_type: "solana", owner_id, rules: solanaRules() });
    console.log(`PRIVY_SOLANA_POLICY_IDS=${created.id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
