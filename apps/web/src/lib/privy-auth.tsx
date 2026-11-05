"use client";

import { ARC_USDC, CHAINS, toBaseUnits, type ExecStep, type StepResult } from "@frontrun/core";
import {
  PrivyProvider,
  useExportWallet,
  useLogin,
  usePrivy,
  useSendTransaction,
  useSigners,
  useSignTypedData,
  useWallets,
} from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useExportWallet as useExportSolanaWallet,
  useSignAndSendTransaction,
  useSignMessage as useSignSolanaMessage,
  useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, getBase58Decoder } from "@solana/kit";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeFunctionData, erc20Abi } from "viem";
import { arbitrum, arc, base, bsc, hyperEvm, mainnet, robinhood } from "viem/chains";
import { setTokenGetter } from "./api";
import { AuthContextProvider, type AuthValue, type WalletActions } from "./auth";

// This runs in the browser, so it can't be the server's SOLANA_RPC_URL, which may carry a private key.
const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const solanaRpcs = {
  "solana:mainnet": {
    rpc: createSolanaRpc(SOLANA_RPC),
    rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_RPC.replace(/^http/, "ws")),
  },
};
const solanaConnectors = toSolanaWalletConnectors();

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function Bridge({ signerId, policyIds, solanaPolicyIds, children }: { signerId: string | null; policyIds: string[]; solanaPolicyIds: string[]; children: ReactNode }) {
  const { ready, authenticated, logout, getAccessToken, user } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { addSigners, removeSigners } = useSigners();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const { exportWallet } = useExportWallet();
  const { exportWallet: exportSolanaWallet } = useExportSolanaWallet();
  const { signMessage: signSolanaMessage } = useSignSolanaMessage();
  const { signTransaction: signSolanaTransaction } = useSignSolanaTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const [tokenReady, setTokenReady] = useState(false);

  const getTokenRef = useRef(getAccessToken);
  getTokenRef.current = getAccessToken;

  useEffect(() => {
    setTokenGetter(() => getTokenRef.current());
    setTokenReady(true);
  }, []);

  const embeddedEvm = wallets.find((w) => w.walletClientType === "privy");
  const embeddedSolana = solanaWallets[0];
  const evmAddress = embeddedEvm?.address ?? user?.wallet?.address;
  const linkedAccounts = user?.linkedAccounts;

  const wallet = useMemo<WalletActions>(
    () => ({
      async addSigner() {
        if (!evmAddress) throw new Error("Your wallet isn't ready yet.");
        if (!signerId) throw new Error("One-tap trading isn't available on this server.");
        // A signer without a policy could do anything, so one-tap refuses to go on without them.
        if (!policyIds.length) throw new Error("One-tap trading isn't fully set up on this server.");
        // Renewing, or retrying a half-finished setup, finds the signer already on the wallet.
        const hasSigner = (address: string) =>
          !!linkedAccounts?.some((a) => a.type === "wallet" && a.address.toLowerCase() === address.toLowerCase() && "delegated" in a && a.delegated);
        if (!hasSigner(evmAddress)) await addSigners({ address: evmAddress, signers: [{ signerId, policyIds }] });
        // The Solana wallet signs Solana-origin sells. Same rule: no policy, no signer there.
        if (embeddedSolana?.address && solanaPolicyIds.length && !hasSigner(embeddedSolana.address)) {
          await addSigners({ address: embeddedSolana.address, signers: [{ signerId, policyIds: solanaPolicyIds }] });
        }
      },
      async removeSigner() {
        if (!evmAddress) return;
        await removeSigners({ address: evmAddress });
        if (embeddedSolana?.address) await removeSigners({ address: embeddedSolana.address }).catch(() => {});
      },
      async exportWallet(chainType) {
        const address = chainType === "evm" ? evmAddress : embeddedSolana?.address;
        if (!address) throw new Error("Your wallet isn't ready yet.");
        if (chainType === "evm") await exportWallet({ address });
        else await exportSolanaWallet({ address });
      },
      async runStep(step: ExecStep): Promise<StepResult> {
        switch (step.kind) {
          case "evm_typed_data": {
            const typed = JSON.parse(step.typedData);
            const { signature } = await signTypedData(typed, { address: evmAddress, uiOptions: { showWalletUIs: true } });
            return { id: step.id, signature };
          }
          case "evm_tx": {
            const { hash } = await sendTransaction(
              {
                to: step.to,
                data: step.data,
                ...(step.value ? { value: BigInt(step.value) } : {}),
                chainId: CHAINS[step.chain].chainId!,
              },
              { address: evmAddress, uiOptions: { showWalletUIs: true } },
            );
            return { id: step.id, txHash: hash };
          }
          case "svm_message": {
            if (!embeddedSolana) throw new Error("Your Solana wallet isn't ready yet.");
            const { signature } = await signSolanaMessage({ message: new TextEncoder().encode(step.message), wallet: embeddedSolana });
            return { id: step.id, signature: getBase58Decoder().decode(signature) };
          }
          case "svm_tx": {
            if (!embeddedSolana) throw new Error("Your Solana wallet isn't ready yet.");
            const transaction = fromBase64(step.transactionBase64);
            if (step.broadcast) {
              const { signature } = await signAndSendTransaction({ transaction, wallet: embeddedSolana });
              return { id: step.id, txHash: getBase58Decoder().decode(signature) };
            }
            const { signedTransaction } = await signSolanaTransaction({ transaction, wallet: embeddedSolana });
            return { id: step.id, signedTransaction: toBase64(signedTransaction) };
          }
        }
      },
      async sendUsdc(to, amountUsd) {
        // Always the 6-decimal ERC-20 interface. Arc's native 18-decimal side is only for gas.
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to as `0x${string}`, toBaseUnits(amountUsd, CHAINS.arc.usdcDecimals)],
        });
        const { hash } = await sendTransaction(
          { to: ARC_USDC, data, chainId: CHAINS.arc.chainId! },
          { address: evmAddress, uiOptions: { showWalletUIs: true } },
        );
        return hash;
      },
    }),
    [
      addSigners,
      embeddedSolana,
      evmAddress,
      exportSolanaWallet,
      exportWallet,
      linkedAccounts,
      policyIds,
      removeSigners,
      solanaPolicyIds,
      sendTransaction,
      signAndSendTransaction,
      signSolanaMessage,
      signSolanaTransaction,
      signTypedData,
      signerId,
    ],
  );

  const value = useMemo<AuthValue>(
    () => ({
      status: !ready || !tokenReady ? "loading" : authenticated ? "in" : "out",
      mode: "privy",
      login: () => login(),
      logout: () => logout(),
      wallet,
    }),
    [authenticated, login, logout, ready, tokenReady, wallet],
  );

  return <AuthContextProvider value={value}>{children}</AuthContextProvider>;
}

export function PrivyAuth({
  appId,
  signerId,
  policyIds,
  solanaPolicyIds,
  children,
}: {
  appId: string;
  signerId: string | null;
  policyIds: string[];
  solanaPolicyIds: string[];
  children: ReactNode;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["google", "email", "wallet"],
        appearance: { theme: "dark", accentColor: "#c8f135", walletChainType: "ethereum-and-solana" },
        defaultChain: arc,
        supportedChains: [arc, robinhood, base, arbitrum, mainnet, bsc, hyperEvm],
        solana: { rpcs: solanaRpcs },
        externalWallets: { solana: { connectors: solanaConnectors } },
        embeddedWallets: {
          // Everyone gets both wallets, including people who sign in with an external wallet,
          // since one-tap trading and Solana sells both run on the embedded ones.
          ethereum: { createOnLogin: "all-users" },
          solana: { createOnLogin: "all-users" },
          showWalletUIs: false,
        },
      }}
    >
      <Bridge signerId={signerId} policyIds={policyIds} solanaPolicyIds={solanaPolicyIds}>
        {children}
      </Bridge>
    </PrivyProvider>
  );
}
