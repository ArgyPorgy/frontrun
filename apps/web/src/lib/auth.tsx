"use client";

import type { ExecStep, PublicConfig, StepResult } from "@frontrun/core";
import dynamic from "next/dynamic";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setTokenGetter } from "./api";

/** What the app needs from a wallet, whichever auth backend is running. */
export interface WalletActions {
  /** Adds the app's policy-limited signer to the embedded wallet. Needs the user's consent. */
  addSigner(): Promise<void>;
  removeSigner(): Promise<void>;
  exportWallet(chainType: "evm" | "solana"): Promise<void>;
  /** Signs one step in the wallet, with a visible prompt. */
  runStep(step: ExecStep): Promise<StepResult>;
  sendUsdc(to: string, amountUsd: string): Promise<string>;
}

export interface AuthValue {
  status: "loading" | "out" | "in";
  mode: "privy" | "dev";
  login(): void;
  logout(): Promise<void>;
  wallet: WalletActions;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth needs AuthProvider");
  return value;
}

export function AuthContextProvider({ value, children }: { value: AuthValue; children: ReactNode }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Privy loads only when configured, so dev mode never pulls its bundle or needs an app id.
const PrivyAuth = dynamic(() => import("./privy-auth").then((m) => m.PrivyAuth), { ssr: false });

const DEV_TOKEN_KEY = "frontrun.devToken";

const noWallet: WalletActions = {
  addSigner: async () => {},
  removeSigner: async () => {},
  exportWallet: async () => {
    throw new Error("Paper wallets have no keys to export.");
  },
  runStep: async () => {
    throw new Error("Paper trades don't need a wallet signature.");
  },
  sendUsdc: async () => {
    throw new Error("Paper mode has no real USDC to send.");
  },
};

function readDevToken(): string | null {
  try {
    return localStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
}

function DevAuth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthValue["status"]>("loading");
  const [promptOpen, setPromptOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTokenGetter(async () => readDevToken());
    setStatus(readDevToken() ? "in" : "out");
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      mode: "dev",
      login: () => setPromptOpen(true),
      logout: async () => {
        localStorage.removeItem(DEV_TOKEN_KEY);
        setStatus("out");
      },
      wallet: noWallet,
    }),
    [status],
  );

  const submit = async () => {
    setError(null);
    try {
      const { token } = await api.devLogin(handle.trim());
      localStorage.setItem(DEV_TOKEN_KEY, token);
      setTokenGetter(async () => token);
      setPromptOpen(false);
      setStatus("in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    }
  };

  return (
    <AuthContextProvider value={value}>
      {children}
      {promptOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/70 md:items-center md:justify-center" onClick={() => setPromptOpen(false)}>
          <form
            className="animate-sheet w-full rounded-t-[20px] border-t border-line bg-surface p-5 pad-bottom md:max-w-sm md:rounded-[20px] md:border"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <h2 className="text-lg font-semibold">Dev sign-in</h2>
            <p className="mt-1 text-sm text-muted">Privy isn&apos;t configured here, so this stands in for Google login. It only works outside production.</p>
            <input
              autoFocus
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="Pick any handle"
              autoCapitalize="none"
              autoCorrect="off"
              className="mt-4 w-full rounded-xl border border-line bg-bg px-4 py-3 outline-none focus:border-signal"
            />
            {error && <p className="mt-2 text-sm text-down">{error}</p>}
            <button type="submit" className="mt-4 mb-4 w-full rounded-xl bg-signal py-3 font-semibold text-signal-ink">
              Continue
            </button>
          </form>
        </div>
      )}
    </AuthContextProvider>
  );
}

export function AuthProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  if (config.authMode === "privy" && config.privyAppId) {
    return (
      <PrivyAuth appId={config.privyAppId} signerId={config.signerId} policyIds={config.policyIds} solanaPolicyIds={config.solanaPolicyIds}>
        {children}
      </PrivyAuth>
    );
  }
  return <DevAuth>{children}</DevAuth>;
}
