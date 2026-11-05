import { CHAINS, D, fromBaseUnits, type ChainKey, type ExecStep, type StepResult } from "@frontrun/core";
import { PrivyClient } from "@privy-io/node";
import { getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, schema } from "../db/client";
import { env } from "../env";
import { AppError } from "../errors";
import { logger } from "../logger";
import { fetchTokens } from "../market/dexscreener";
import { evmClient, viemChain } from "../onchain";
import { sendSponsored, sponsorshipConfigured } from "./sponsor";

let client: PrivyClient | undefined;

export function privy(): PrivyClient {
  const e = env();
  if (!e.PRIVY_APP_ID || !e.PRIVY_APP_SECRET) throw new Error("Privy is not configured.");
  if (!client) {
    client = new PrivyClient({
      appId: e.PRIVY_APP_ID,
      appSecret: e.PRIVY_APP_SECRET,
      // PEM keys pasted into .env usually arrive as one line with literal \n in them.
      ...(e.PRIVY_JWT_VERIFICATION_KEY ? { jwtVerificationKey: e.PRIVY_JWT_VERIFICATION_KEY.replace(/\\n/g, "\n") } : {}),
    });
  }
  return client;
}

/** Whether this deployment can sign for users at all. Grants still get checked per user. */
export function serverSigningConfigured(): boolean {
  const e = env();
  // The policy is required: this deployment must never hold an unrestricted signer.
  return !!(e.PRIVY_APP_ID && e.PRIVY_APP_SECRET && e.PRIVY_AUTHORIZATION_KEY && e.PRIVY_SIGNER_ID && e.PRIVY_POLICY_IDS);
}

export function solanaSigningConfigured(): boolean {
  return serverSigningConfigured() && !!env().PRIVY_SOLANA_POLICY_IDS;
}

export function authContext() {
  const key = env().PRIVY_AUTHORIZATION_KEY;
  if (!key) throw new Error("PRIVY_AUTHORIZATION_KEY is not set.");
  return { authorization_private_keys: [key] };
}

export interface SigningWallets {
  evmWalletId: string | null;
  evmAddress: string;
  solanaWalletId: string | null;
  solanaAddress: string | null;
}

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

async function waitForEvmReceipt(chain: ChainKey, hash: Hex) {
  const receipt = await evmClient(chain).waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status === "reverted") throw new Error("The transaction reverted on-chain.");
}

async function signAndBroadcast(wallets: SigningWallets, step: Extract<ExecStep, { kind: "evm_tx" }>): Promise<Hex> {
  const chain = step.chain;
  const public_ = evmClient(chain);
  const from = wallets.evmAddress as Hex;
  const to = step.to as Hex;
  const data = step.data as Hex;
  const value = step.value ? BigInt(step.value) : 0n;
  const [nonce, fees, gas] = await Promise.all([
    public_.getTransactionCount({ address: from, blockTag: "pending" }),
    public_.estimateFeesPerGas(),
    public_.estimateGas({ account: from, to, data, value }),
  ]);
  const { signed_transaction } = await privy()
    .wallets()
    .ethereum()
    .signTransaction(wallets.evmWalletId!, {
      params: {
        transaction: {
          to,
          data,
          value: `0x${value.toString(16)}`,
          nonce,
          chain_id: CHAINS[chain].chainId!,
          type: 2,
          gas_limit: `0x${((gas * 130n) / 100n).toString(16)}`,
          max_fee_per_gas: `0x${fees.maxFeePerGas.toString(16)}`,
          max_priority_fee_per_gas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
        },
      },
      authorization_context: authContext(),
    });
  return public_.sendRawTransaction({ serializedTransaction: signed_transaction as Hex });
}

/** Wallets export private keys both with and without the 0x prefix, and viem needs it. */
export function normalizePrivateKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/** Where to read each native coin's USD price, used to size top-up costs. */
const NATIVE_PRICE_REF: Record<string, { chain: ChainKey; address: string }> = {
  ETH: { chain: "base", address: "0x4200000000000000000000000000000000000006" },
  BNB: { chain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  HYPE: { chain: "hyperevm", address: "0x5555555555555555555555555555555555555555" },
};

async function nativePriceUsd(chain: ChainKey): Promise<string> {
  const ref = NATIVE_PRICE_REF[CHAINS[chain].nativeSymbol];
  if (!ref) return "0";
  const snaps = await fetchTokens(ref.chain, [ref.address]);
  return snaps.get(ref.address.toLowerCase())?.priceUsd ?? "0";
}

/**
 * Plan fallback for a sell's first approval when Privy can't sponsor the chain: send the wallet just
 * enough native gas. The cost is recorded here and recovered from that sell's proceeds by Flash's
 * integrator fee, so the backend never takes a separate transfer from the user.
 */
export async function ensureGasForSetup(args: { chain: ChainKey; address: string; userId: string; tradeId: string }): Promise<boolean> {
  const { chain, address, userId, tradeId } = args;
  const key = env().GAS_TOPUP_PRIVATE_KEY;
  const topup = CHAINS[chain].gasTopupWei;
  if (!key || !topup || CHAINS[chain].type !== "evm") return false;
  const public_ = evmClient(chain);
  const balance = await public_.getBalance({ address: address as Hex });
  if (balance >= BigInt(topup) / 2n) return false;

  const account = privateKeyToAccount(normalizePrivateKey(key));
  const wallet = createWalletClient({ account, chain: viemChain(chain), transport: http() });
  const hash = await wallet.sendTransaction({ to: address as Hex, value: BigInt(topup) });
  await public_.waitForTransactionReceipt({ hash, timeout: 60_000 });

  const price = await nativePriceUsd(chain).catch(() => "0");
  const costUsd = D(fromBaseUnits(BigInt(topup), 18)).mul(price).toFixed();
  await db().insert(schema.gasTopups).values({ userId, chain, amountWei: topup, costUsd, txHash: hash, tradeId });
  await db()
    .insert(schema.auditLog)
    .values({ userId, action: "gas_topup", detail: { chain, amountWei: topup, costUsd, txHash: hash, tradeId } });
  return true;
}

/** Runs one signing step with the backend's policy-limited signer. Never used without a live grant. */
export async function performServerStep(wallets: SigningWallets, step: ExecStep, ctx: { userId: string; tradeId: string }): Promise<StepResult> {
  switch (step.kind) {
    case "evm_typed_data": {
      if (!wallets.evmWalletId) throw new Error("This wallet can't be signed for server-side.");
      const typed = JSON.parse(step.typedData) as {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const { signature } = await privy()
        .wallets()
        .ethereum()
        .signTypedData(wallets.evmWalletId, {
          params: {
            typed_data: {
              domain: typed.domain,
              types: typed.types,
              message: typed.message,
              primary_type: typed.primaryType,
            },
          },
          authorization_context: authContext(),
        });
      return { id: step.id, signature };
    }
    case "evm_tx": {
      if (!wallets.evmWalletId) throw new Error("This wallet can't be signed for server-side.");
      if (sponsorshipConfigured(step.chain)) {
        // This has already landed by the time it returns.
        const hash = await sendSponsored({ walletId: wallets.evmWalletId, sender: wallets.evmAddress, chain: step.chain, to: step.to, data: step.data, value: step.value });
        return { id: step.id, txHash: hash };
      }
      if (step.chain !== "arc") {
        try {
          await ensureGasForSetup({ chain: step.chain, address: wallets.evmAddress, userId: ctx.userId, tradeId: ctx.tradeId });
        } catch (err) {
          logger.error({ chain: step.chain, err: err instanceof Error ? err.message.slice(0, 200) : err }, "ALERT: the gas wallet can't cover a first sell");
          throw new AppError(503, "gas_unavailable", `The first sell on ${CHAINS[step.chain].name} needs a little gas, and the app can't cover it right now. Your tokens are safe.`);
        }
      }
      const hash = await signAndBroadcast(wallets, step);
      if (step.waitForReceipt) await waitForEvmReceipt(step.chain, hash);
      return { id: step.id, txHash: hash };
    }
    case "svm_message": {
      if (!wallets.solanaWalletId) throw new Error("This Solana wallet can't be signed for server-side.");
      const { signature } = await privy()
        .wallets()
        .solana()
        .signMessage(wallets.solanaWalletId, {
          message: new TextEncoder().encode(step.message),
          authorization_context: authContext(),
        });
      // Privy returns base64; Flash wants the signature in base58.
      const bytes = Uint8Array.from(Buffer.from(signature, "base64"));
      return { id: step.id, signature: getBase58Decoder().decode(bytes) };
    }
    case "svm_tx": {
      if (!wallets.solanaWalletId) throw new Error("This Solana wallet can't be signed for server-side.");
      if (step.broadcast) {
        const { hash } = await privy()
          .wallets()
          .solana()
          .signAndSendTransaction(wallets.solanaWalletId, {
            caip2: SOLANA_MAINNET_CAIP2,
            transaction: step.transactionBase64,
            ...(step.sponsor ? { sponsor: true } : {}),
            authorization_context: authContext(),
          });
        return { id: step.id, txHash: hash };
      }
      const { signed_transaction } = await privy()
        .wallets()
        .solana()
        .signTransaction(wallets.solanaWalletId, {
          transaction: step.transactionBase64,
          authorization_context: authContext(),
        });
      return { id: step.id, signedTransaction: signed_transaction };
    }
  }
}

/** Fetches a user's wallets from Privy. Wallet ids must come from Privy, never from the client. */
export async function fetchPrivyWallets(privyId: string) {
  const user = await privy().users()._get(privyId);
  const wallets: Array<{
    chainType: "evm" | "solana";
    address: string;
    isEmbedded: boolean;
    privyWalletId: string | null;
    delegated: boolean;
  }> = [];
  for (const account of user.linked_accounts) {
    if (account.type !== "wallet") continue;
    const chainType = account.chain_type === "solana" ? "solana" : account.chain_type === "ethereum" ? "evm" : null;
    if (!chainType) continue;
    const embedded = "wallet_client_type" in account && account.wallet_client_type === "privy";
    wallets.push({
      chainType,
      address: chainType === "evm" ? account.address.toLowerCase() : account.address,
      isEmbedded: embedded,
      privyWalletId: "id" in account && account.id ? account.id : null,
      delegated: "delegated" in account && account.delegated === true,
    });
  }
  return wallets;
}

export async function loadSigningWallets(userId: string): Promise<SigningWallets> {
  const rows = await db().select().from(schema.wallets).where(eq(schema.wallets.userId, userId));
  const evm = rows.find((w) => w.chainType === "evm" && w.isEmbedded) ?? rows.find((w) => w.chainType === "evm");
  const sol = rows.find((w) => w.chainType === "solana" && w.isEmbedded) ?? rows.find((w) => w.chainType === "solana");
  // Privy creates wallets just after first login, so this is a normal moment rather than a fault.
  if (!evm) throw new AppError(409, "wallet_not_ready", "Your wallet is still being set up. Try again in a moment.");
  return {
    evmWalletId: evm.privyWalletId,
    evmAddress: evm.address,
    solanaWalletId: sol?.privyWalletId ?? null,
    solanaAddress: sol?.address ?? null,
  };
}
