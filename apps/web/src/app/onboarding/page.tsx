"use client";

import { formatUsd, usernameSchema } from "@frontrun/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AVATAR_CHOICES, Avatar, Button, EmptyState, LinkButton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConfig, useMe } from "@/lib/hooks";

function ProfileStep() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATAR_CHOICES[0]!);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.updateMe({ username: name, avatarUrl: avatar }),
    onSuccess: (fresh) => queryClient.setQueryData(["me"], fresh),
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = () => {
    const parsed = usernameSchema.safeParse(name);
    if (!parsed.success) {
      setError("Use 3 to 20 letters, numbers or underscores.");
      return;
    }
    setError(null);
    save.mutate();
  };

  return (
    <div className="px-4 pt-6">
      <p className="text-xs font-medium text-muted">Step 1 of 3</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Pick a name and avatar</h1>
      <p className="mt-1 text-muted">This is who people see on your theses and on the chart.</p>
      <div className="mt-5 grid grid-cols-6 gap-3">
        {AVATAR_CHOICES.map((choice) => (
          <button key={choice} onClick={() => setAvatar(choice)} aria-label={`Avatar ${choice}`} aria-pressed={avatar === choice} className={`rounded-full p-0.5 ${avatar === choice ? "ring-2 ring-signal" : ""}`}>
            <Avatar user={{ username: name || me.data?.username || "?", avatarUrl: choice }} size={44} />
          </button>
        ))}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Username"
        autoCapitalize="none"
        autoCorrect="off"
        aria-label="Username"
        className="mt-5 w-full rounded-xl border border-line bg-surface px-4 py-3 outline-none focus:border-signal"
      />
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <Button onClick={submit} disabled={save.isPending || !name} className="mt-4 w-full">
        Continue
      </Button>
      <p className="mt-3 text-center text-xs text-faint">
        By continuing you agree to the{" "}
        <Link href="/legal/terms" className="underline">
          Terms
        </Link>
        ,{" "}
        <Link href="/legal/privacy" className="underline">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/legal/risk" className="underline">
          Risk Disclosure
        </Link>
        .
      </p>
    </div>
  );
}

function DepositStep({ onSkip }: { onSkip(): void }) {
  return (
    <div className="px-4 pt-6">
      <p className="text-xs font-medium text-muted">Step 2 of 3</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Add USDC</h1>
      <p className="mt-1 text-muted">One balance on Arc covers every trade on every chain. You never need another token.</p>
      <LinkButton href="/deposit" className="mt-5 block w-full">
        Add funds
      </LinkButton>
      <Button variant="ghost" onClick={onSkip} className="mt-2 w-full">
        Look around first
      </Button>
    </div>
  );
}

function OneTapStep() {
  const { wallet } = useAuth();
  const config = useConfig();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const enable = useMutation({
    mutationFn: async () => {
      // Paper mode may not have a signer yet, and live mode can't get here without one.
      if (config.signerId) await wallet.addSigner();
      await api.grantSigner({});
      // One-tap is on by now. If this can't go through yet, the first trade sends it.
      await api.approveFlash().catch(() => {});
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      router.replace("/");
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const unavailable = config.tradingMode === "live" && !config.signerId;

  return (
    <div className="px-4 pt-6">
      <p className="text-xs font-medium text-muted">Step 3 of 3</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Trade in one tap</h1>
      <p className="mt-1 text-muted">Approve once, then every trade goes through with no pop-ups. You stay in control of the wallet.</p>
      <ul className="mt-5 space-y-3 rounded-2xl bg-surface p-4 text-sm">
        <li className="flex justify-between gap-4">
          <span className="text-muted">Each trade up to</span>
          <span className="num font-medium">{formatUsd(config.caps.perTradeUsd)}</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-muted">Per day up to</span>
          <span className="num font-medium">{formatUsd(config.caps.dailyUsd)}</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-muted">Renews every</span>
          <span className="num font-medium">{config.caps.grantDays} days</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-muted">Above your limits</span>
          <span className="font-medium">You confirm it</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="text-muted">Funds can only go to</span>
          <span className="font-medium">Your own wallets</span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-faint">
        This adds a limited app signer to your wallet and approves USDC for the Flash trading contract, which then trusts it with your USDC balance. A compromised app could place trades from your wallet, but the signer can't send your funds to anyone. You can change limits, remove the signer and reset approvals in Settings at any time.
      </p>
      {unavailable && <p className="mt-2 text-sm text-warn">One-tap isn&apos;t set up on this server yet, so trades will ask you to confirm in your wallet.</p>}
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <Button onClick={() => enable.mutate()} disabled={enable.isPending || unavailable} className="mt-4 w-full">
        {enable.isPending ? "Setting up…" : "Enable one-tap trading"}
      </Button>
      <Link href="/" className="mt-3 block text-center text-sm text-muted">
        Not now
      </Link>
    </div>
  );
}

export default function OnboardingPage() {
  const { status, login } = useAuth();
  const me = useMe();
  const router = useRouter();
  const [skippedDeposit, setSkippedDeposit] = useState(false);

  useEffect(() => {
    if (me.data?.onboarding === "done") router.replace("/");
  }, [me.data?.onboarding, router]);

  useEffect(() => {
    if (skippedDeposit) router.replace("/");
  }, [skippedDeposit, router]);

  if (status === "out") return <EmptyState title="Sign in to get started" action={<Button onClick={login}>Sign in</Button>} />;
  if (!me.data) return null;
  switch (me.data.onboarding) {
    case "profile":
      return <ProfileStep />;
    case "deposit":
      return <DepositStep onSkip={() => setSkippedDeposit(true)} />;
    case "enable_one_tap":
      return <OneTapStep />;
    default:
      return null;
  }
}
