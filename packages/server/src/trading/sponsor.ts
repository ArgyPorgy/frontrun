import type { ChainKey } from "@frontrun/core";
import { concat, encodeFunctionData, parseAbi, type Hex } from "viem";
import { entryPoint07Abi, entryPoint07Address } from "viem/account-abstraction";
import { env } from "../env";
import { AppError } from "../errors";
import { fetchJson, HttpError } from "../http";
import { logger } from "../logger";
import { evmClient } from "../onchain";
import { authContext, privy } from "./signer";

/**
 * Gasless on-chain steps, the way FOMO does it: the user's wallet is upgraded in place with EIP-7702, and
 * Pimlico's paymaster pays for each user operation. The address and the funds stay where they are.
 *
 * Why this account contract, Alchemy's SMA-7702 v1.1.0, and not Pimlico's default:
 * - Privy's secure signing of user operations only supports a short list of contracts, and it's on it.
 *   Privy's policy engine then reads inside each operation, so the signer policy still blocks a drain.
 *   Signing the operation as plain typed data would have hidden the inner call from the policy.
 * - It accepts a plain ECDSA signature for ERC-1271. Flash and Permit2 check upgraded wallets that way,
 *   so orders keep the same signing code and the same policy rules.
 * - It's deployed on every EVM chain the app trades on.
 */
export const SMART_ACCOUNT_IMPLEMENTATION = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";

/** HyperEVM has the contract, but Pimlico doesn't list EIP-7702 support there. It keeps the gas top-up. */
const SPONSORED_CHAINS: ReadonlySet<ChainKey> = new Set<ChainKey>(["arc", "robinhood", "base", "arbitrum", "ethereum", "bsc"]);

const CHAIN_IDS: Partial<Record<ChainKey, number>> = { arc: 5042, robinhood: 4663, base: 8453, arbitrum: 42161, ethereum: 1, bsc: 56 };

/** The account's owner signs through its fallback validation, which this nonce key and prefix select. */
const FALLBACK_NONCE_KEY = 1n;
const SIGNATURE_PREFIX = "0xff00";
const STUB_SIGNATURE = "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 1_000;

const ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data) returns (bytes)"]);

export function sponsorshipConfigured(chain: ChainKey): boolean {
  return !!env().PIMLICO_API_KEY && SPONSORED_CHAINS.has(chain);
}

/** Whether every trade can run gasless, which is what the app assumes when it hides gas from people. */
export function gaslessEnabled(): boolean {
  return sponsorshipConfigured("arc");
}

class PimlicoError extends Error {}

async function pimlico<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const url = `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${env().PIMLICO_API_KEY}`;
  let res: { result?: T; error?: { message?: string } };
  try {
    res = await fetchJson(url, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params }, timeoutMs: 15_000 });
  } catch (err) {
    // Never pass the raw error on: the URL holds the API key.
    const detail = err instanceof HttpError ? `HTTP ${err.status}: ${err.body.slice(0, 200)}` : "request failed";
    throw new PimlicoError(`${method}: ${detail}`);
  }
  if (res.error) throw new PimlicoError(`${method}: ${res.error.message ?? "unknown error"}`);
  return res.result as T;
}

/** A simulated revert means this exact trade won't work right now. Anything else is on our side. */
function toUserError(err: unknown): Error {
  if (err instanceof PimlicoError) {
    if (/AA\d\d|revert|simulation/i.test(err.message)) {
      logger.warn({ err: err.message.slice(0, 300) }, "sponsored operation would revert");
      return new AppError(422, "trade_would_fail", "This trade would fail right now, so nothing was sent.");
    }
    logger.error({ err: err.message.slice(0, 300) }, "ALERT: gas sponsorship is failing");
    return new AppError(503, "sponsorship_unavailable", "Trading is briefly unavailable. Nothing was sent, so try again in a moment.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Upgrades the wallet the first time it's used on a chain. Later operations don't need this. */
async function authorizationFor(walletId: string, sender: Hex, chain: ChainKey, chainId: number) {
  const client = evmClient(chain);
  const code = await client.getCode({ address: sender });
  if (code?.toLowerCase() === concat(["0xef0100", SMART_ACCOUNT_IMPLEMENTATION]).toLowerCase()) return null;
  const nonce = await client.getTransactionCount({ address: sender });
  const signed = await privy()
    .wallets()
    .ethereum()
    .sign7702Authorization(walletId, {
      params: { chain_id: chainId, contract: SMART_ACCOUNT_IMPLEMENTATION, nonce },
      authorization_context: authContext(),
    });
  const auth = signed.authorization;
  return {
    address: SMART_ACCOUNT_IMPLEMENTATION,
    chainId: `0x${chainId.toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    r: auth.r,
    s: auth.s,
    yParity: `0x${Number(auth.y_parity).toString(16)}`,
  };
}

/**
 * Runs the call for free first. An operation whose inner call reverts still lands, and the paymaster still
 * pays for it, so a trade that can't work would otherwise cost real credit, and could be repeated on purpose.
 * A step right after an approval can reach a node that hasn't seen it yet, so a revert gets one more try.
 */
async function assertCallWorks(chain: ChainKey, sender: Hex, call: { to: string; data: string; value?: string }) {
  const run = () => evmClient(chain).call({ account: sender, to: call.to as Hex, data: call.data as Hex, value: BigInt(call.value ?? 0) });
  try {
    await run();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/revert|insufficient funds|exceeds the balance/i.test(message)) throw new PimlicoError(`simulation: reverted: ${message.slice(0, 160)}`);
      throw err;
    }
  }
}

interface SponsorResult {
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  paymaster: string;
  paymasterData: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
}

/**
 * Sends one call from the user's wallet, with the gas paid for them, and waits for it to land. Returns
 * the hash of the transaction that carried it.
 */
export async function sendSponsored(args: { walletId: string; sender: string; chain: ChainKey; to: string; data: string; value?: string }): Promise<Hex> {
  const { walletId, chain } = args;
  const sender = args.sender as Hex;
  const chainId = CHAIN_IDS[chain];
  if (!chainId) throw new Error(`Gas sponsorship doesn't cover ${chain}.`);
  try {
    await assertCallWorks(chain, sender, args);
    const [authorization, sequence, gasPrice] = await Promise.all([
      authorizationFor(walletId, sender, chain, chainId),
      evmClient(chain).readContract({ address: entryPoint07Address, abi: entryPoint07Abi, functionName: "getNonce", args: [sender, FALLBACK_NONCE_KEY] }),
      pimlico<{ fast: { maxFeePerGas: string; maxPriorityFeePerGas: string } }>(chainId, "pimlico_getUserOperationGasPrice", []),
    ]);
    const callData = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [args.to as Hex, BigInt(args.value ?? 0), args.data as Hex] });
    const operation = {
      sender,
      nonce: `0x${sequence.toString(16)}`,
      callData,
      maxFeePerGas: gasPrice.fast.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
      ...(authorization ? { eip7702Auth: authorization } : {}),
    };
    const policyId = env().PIMLICO_SPONSORSHIP_POLICY_ID;
    const sponsored = await pimlico<SponsorResult>(chainId, "pm_sponsorUserOperation", [
      { ...operation, signature: concat([SIGNATURE_PREFIX, STUB_SIGNATURE]) },
      entryPoint07Address,
      ...(policyId ? [{ sponsorshipPolicyId: policyId }] : []),
    ]);
    // Privy's policy engine decodes this operation's inner call before it will sign.
    const { signature } = await privy()
      .wallets()
      .ethereum()
      .signUserOperation(walletId, {
        params: {
          chain_id: chainId,
          contract: SMART_ACCOUNT_IMPLEMENTATION,
          user_operation: {
            sender,
            nonce: operation.nonce,
            call_data: callData,
            call_gas_limit: sponsored.callGasLimit,
            verification_gas_limit: sponsored.verificationGasLimit,
            pre_verification_gas: sponsored.preVerificationGas,
            max_fee_per_gas: operation.maxFeePerGas,
            max_priority_fee_per_gas: operation.maxPriorityFeePerGas,
            paymaster: sponsored.paymaster,
            paymaster_data: sponsored.paymasterData,
            paymaster_verification_gas_limit: sponsored.paymasterVerificationGasLimit,
            paymaster_post_op_gas_limit: sponsored.paymasterPostOpGasLimit,
          },
        },
        authorization_context: authContext(),
      });
    const hash = await pimlico<Hex>(chainId, "eth_sendUserOperation", [
      { ...operation, ...sponsored, signature: concat([SIGNATURE_PREFIX, signature as Hex]) },
      entryPoint07Address,
    ]);
    return await waitForOperation(chainId, hash);
  } catch (err) {
    throw toUserError(err);
  }
}

async function waitForOperation(chainId: number, operationHash: Hex): Promise<Hex> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await pimlico<{ success: boolean; receipt: { transactionHash: Hex } } | null>(chainId, "eth_getUserOperationReceipt", [operationHash]).catch(() => null);
    if (receipt) {
      if (!receipt.success) throw new Error("The transaction reverted on-chain.");
      return receipt.receipt.transactionHash;
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  throw new Error(`Sponsored operation ${operationHash} hasn't landed yet.`);
}
