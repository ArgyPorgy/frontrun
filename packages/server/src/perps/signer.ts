import { HOME_CHAIN } from "@frontrun/core";
import type { Address, Hex } from "viem";
import { Veranta, type VerantaSigner } from "veranta-sdk";
import { env } from "../env";
import {
  loadSigningWallets,
  performServerStep,
  type SigningWallets,
} from "../trading/signer";

type TypedDataPayload = Parameters<VerantaSigner["signTypedData"]>[0];

/**
 * Veranta's SDK signs through this, so a perp trade is signed the same way as every other trade here: by
 * Privy, under the app's policy, with nothing but the user's own wallet. Transactions go out through the
 * gasless path, which carries Front Run's Builder Code. It never signs an EIP-7702 authorization, because
 * that would point the wallet away from the smart account the gasless path relies on.
 */
export class PrivyVerantaSigner implements VerantaSigner {
  readonly canSignAuthorization = false;
  readonly canSendTransaction = true;

  constructor(
    private readonly wallets: SigningWallets,
    private readonly ctx: { userId: string; tradeId: string },
  ) {}

  get address(): Address {
    return this.wallets.evmAddress as Address;
  }

  async signTypedData(payload: TypedDataPayload): Promise<Hex> {
    // Privy takes viem-shaped typed data, with the domain's own type left out, as the other signing paths here send it.
    const { EIP712Domain: _domain, ...types } = payload.types as Record<
      string,
      unknown
    >;
    const typedData = {
      domain: payload.domain,
      types,
      primaryType: payload.primaryType,
      message: payload.message,
    };
    // Typed data can carry bigints, which JSON can't, so they travel as decimal strings.
    const json = JSON.stringify(typedData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const result = await performServerStep(
      this.wallets,
      {
        id: "perp-sign",
        kind: "evm_typed_data",
        chain: HOME_CHAIN,
        label: "Sign perp order",
        typedData: json,
      },
      this.ctx,
    );
    if (!result.signature) throw new Error("Privy returned no signature.");
    return result.signature as Hex;
  }

  async signAuthorization(): Promise<never> {
    throw new Error(
      "Perp trades here never delegate the wallet to another contract.",
    );
  }

  async signTransaction(): Promise<never> {
    throw new Error(
      "Perp transactions go out through the gasless path, not a raw signed transaction.",
    );
  }

  async sendTransaction(tx: {
    to: Address;
    data: Hex;
    value?: bigint;
  }): Promise<Hex> {
    const result = await performServerStep(
      this.wallets,
      {
        id: "perp-tx",
        kind: "evm_tx",
        chain: HOME_CHAIN,
        label: "Perp transaction",
        to: tx.to,
        data: tx.data,
        value: tx.value ? `0x${tx.value.toString(16)}` : undefined,
        waitForReceipt: true,
      },
      this.ctx,
    );
    if (!result.txHash)
      throw new Error("The transaction didn't return a hash.");
    return result.txHash as Hex;
  }
}

/** A Veranta client that trades for this user, through their own wallet. */
export async function verantaFor(
  userId: string,
  tradeId: string,
): Promise<{ client: Veranta; address: string }> {
  const wallets = await loadSigningWallets(userId);
  const signer = new PrivyVerantaSigner(wallets, { userId, tradeId });
  const client = new Veranta({
    network: "mainnet",
    signer,
    trader: wallets.evmAddress as Address,
    execution: "direct",
    rpcUrl: env().BASE_RPC_URL ?? "https://mainnet.base.org",
  });
  return { client, address: wallets.evmAddress };
}
