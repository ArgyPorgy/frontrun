import { ARC_USDC, FLASH_ALLOWANCE_ARC, PERMIT2, UNISWAP_ARC } from "@frontrun/core";
import { SMART_ACCOUNT_IMPLEMENTATION } from "./sponsor";

/** LI.FI's contract on Arc, read from a live quote. Add others here if the route's contract changes. */
const LIFI_ARC = "0xA4072583658Fae592A3506A42431cb6316a8d40b";

/** Privy's docs don't say how addresses are compared, so both spellings are listed. */
const anyCase = (addresses: string[]) => [...new Set(addresses.flatMap((a) => [a, a.toLowerCase()]))];

const ROUTERS = anyCase([UNISWAP_ARC.universalRouter212, UNISWAP_ARC.v3SwapRouter02, LIFI_ARC]);
const APPROVABLE_SPENDERS = anyCase([FLASH_ALLOWANCE_ARC, PERMIT2, UNISWAP_ARC.v3SwapRouter02, LIFI_ARC]);

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

export const evmRules = () => [
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

export const solanaRules = () => [
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

const TRANSFER_ABI = [
  {
    type: "function" as const,
    name: "transfer",
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/**
 * An agent's wallet follows the same rules, plus one: USDC can go back to its owner, and nowhere else. So
 * the worst a misbehaving agent can do is trade badly with what it was given. It can't send funds away.
 */
export const agentEvmRules = (owner: string) => [
  ...evmRules(),
  ...EVM_TX_METHODS.map((method) => ({
    name: `Return USDC to owner (${method})`,
    method,
    action: "ALLOW" as const,
    conditions: [
      { field_source: "ethereum_transaction" as const, field: "to" as const, operator: "in" as const, value: anyCase([ARC_USDC]) },
      { field_source: "ethereum_calldata" as const, field: "transfer.to", abi: TRANSFER_ABI, operator: "in" as const, value: anyCase([owner]) },
    ],
  })),
];
