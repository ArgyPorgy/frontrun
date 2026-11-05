"use client";

import { D, formatUsd, isPositiveDecimal, shortAddress, type ExecStep } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar, Button, CopyButton, EmptyState, LinkButton, PageTitle, Sheet } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { evmAddressOf, solanaAddressOf, useBalance, useConfig, useMe } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 px-4">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{title}</h2>
      <div className="divide-y divide-line/60 rounded-2xl bg-surface">{children}</div>
    </section>
  );
}

function Row({ label, value, action }: { label: string; value?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {value && <div className="truncate text-xs text-muted">{value}</div>}
      </div>
      {action}
    </div>
  );
}

function OneTapSection() {
  const { wallet } = useAuth();
  const config = useConfig();
  const me = useMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [perTrade, setPerTrade] = useState("");
  const [daily, setDaily] = useState("");
  const signer = me.data?.signer;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["me"] });
  const onError = (err: unknown) => toast(errorMessage(err), { tone: "bad" });

  useEffect(() => {
    if (signer) {
      setPerTrade(signer.perTradeCapUsd);
      setDaily(signer.dailyCapUsd);
    }
  }, [signer]);

  const renew = useMutation({
    mutationFn: async () => {
      if (config.signerId) await wallet.addSigner();
      await api.grantSigner({});
      // One-tap is on by now. If this can't go through yet, say with no USDC, the first trade sends it.
      await api.approveFlash().catch(() => {});
    },
    onSuccess: () => {
      void refresh();
      toast("One-tap trading is on", { tone: "good" });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (config.signerId) await wallet.removeSigner();
      await api.revokeSigner();
    },
    onSuccess: () => {
      void refresh();
      toast("Signer removed. Trades will ask you to confirm.");
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async () => {
      const result = await api.revokeApprovals();
      // With no live signer the backend hands the reset to the wallet, so it still works after removal.
      for (const step of result.steps as ExecStep[]) await wallet.runStep(step);
    },
    onSuccess: () => {
      void refresh();
      toast("Approvals reset to zero");
    },
    onError,
  });
  const caps = useMutation({
    mutationFn: () => api.updateCaps({ perTradeCapUsd: perTrade, dailyCapUsd: daily }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
      toast("Limits updated");
    },
    onError,
  });

  if (!signer) return null;
  const expires = signer.expiresAt ? new Date(signer.expiresAt) : null;
  const daysLeft = expires ? Math.ceil((expires.getTime() - Date.now()) / 86_400_000) : 0;
  const unavailable = config.tradingMode === "live" && !config.signerId;
  const capsValid = isPositiveDecimal(perTrade) && isPositiveDecimal(daily);

  return (
    <Section title="One-tap trading">
      {signer.active ? (
        <>
          <Row
            label="On"
            value={daysLeft <= 7 ? `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : `Renews by ${expires?.toLocaleDateString()}`}
            action={
              daysLeft <= 7 ? (
                <Button className="px-3 py-1.5 text-sm" disabled={renew.isPending} onClick={() => renew.mutate()}>
                  Renew
                </Button>
              ) : undefined
            }
          />
          <Row
            label="Limits"
            value={
              <span className="num">
                {formatUsd(signer.perTradeCapUsd)} per trade · {formatUsd(signer.dailyCapUsd)} per day · {formatUsd(signer.spentTodayUsd)} used today
              </span>
            }
            action={
              <Button variant="secondary" className="px-3 py-1.5 text-sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            }
          />
          <Row
            label="Remove app signer"
            value="The app can no longer sign for you."
            action={
              <Button variant="danger" className="px-3 py-1.5 text-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Remove
              </Button>
            }
          />
        </>
      ) : (
        <Row
          label="Off"
          value={unavailable ? "Not available on this server yet." : signer.expiresAt ? "Your grant has ended. Trades ask you to confirm." : "Trades ask you to confirm."}
          action={
            <Button className="px-3 py-1.5 text-sm" disabled={renew.isPending || unavailable} onClick={() => renew.mutate()}>
              Enable
            </Button>
          }
        />
      )}
      <Row
        label="Revoke approvals"
        value="Resets USDC allowances to zero."
        action={
          <Button variant="secondary" className="px-3 py-1.5 text-sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke
          </Button>
        }
      />
      <Sheet open={editing} onClose={() => setEditing(false)} title="One-tap limits">
        <label className="block text-sm text-muted">
          Per trade (USD)
          <input value={perTrade} inputMode="decimal" onChange={(e) => setPerTrade(e.target.value)} className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-signal" />
        </label>
        <label className="mt-3 block text-sm text-muted">
          Per day (USD)
          <input value={daily} inputMode="decimal" onChange={(e) => setDaily(e.target.value)} className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-signal" />
        </label>
        <p className="mt-2 text-xs text-faint">Anything above these asks you to confirm first.</p>
        <Button onClick={() => caps.mutate()} disabled={!capsValid || caps.isPending} className="mt-3 w-full">
          Save
        </Button>
      </Sheet>
    </Section>
  );
}

function WithdrawSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const { wallet } = useAuth();
  const config = useConfig();
  const balance = useBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to);
  const validAmount = isPositiveDecimal(amount) && (!balance.data || D(amount).lte(balance.data.withdrawable));

  const send = useMutation({
    mutationFn: async () => {
      if (config.tradingMode === "paper") await api.paperWithdraw({ to, amountUsd: amount });
      else await wallet.sendUsdc(to, amount);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      setTo("");
      setAmount("");
      onClose();
      toast("Withdrawal sent", { tone: "good" });
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  return (
    <Sheet open={open} onClose={onClose} title="Withdraw USDC">
      <label className="block text-sm text-muted">
        To address on Arc
        <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" autoCapitalize="none" autoCorrect="off" className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-signal" />
      </label>
      <label className="mt-3 block text-sm text-muted">
        <span className="flex justify-between">
          Amount (USDC)
          <button type="button" className="text-signal" onClick={() => balance.data && setAmount(D(balance.data.withdrawable).toDecimalPlaces(6).toFixed())}>
            Max {formatUsd(balance.data?.withdrawable)}
          </button>
        </span>
        <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-signal" />
      </label>
      {to && !validTo && <p className="mt-2 text-sm text-down">That isn&apos;t a valid Arc address.</p>}
      {amount && !validAmount && <p className="mt-2 text-sm text-down">That&apos;s more than you can withdraw. A few cents stay back to send it.</p>}
      <p className="mt-2 text-xs text-faint">Only send to an address that accepts USDC on Arc. This can&apos;t be undone.</p>
      <Button onClick={() => send.mutate()} disabled={!validTo || !validAmount || send.isPending} className="mt-3 w-full">
        {send.isPending ? "Sending…" : "Withdraw"}
      </Button>
    </Sheet>
  );
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function NotificationsRow() {
  const config = useConfig();
  const { toast } = useToast();
  const [state, setState] = useState<"loading" | "on" | "off" | "unsupported" | "needs_install">("loading");

  useEffect(() => {
    void (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const installed = window.matchMedia("(display-mode: standalone)").matches;
      if (ios && !installed) return setState("needs_install");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !config.vapidPublicKey) return setState("unsupported");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })();
  }, [config.vapidPublicKey]);

  const toggle = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (state === "on") {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api.pushUnsubscribe(sub.endpoint);
          await sub.unsubscribe();
        }
        setState("off");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast("Notifications are blocked in your browser settings.", { tone: "bad" });
        return;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey!) });
      const json = sub.toJSON();
      await api.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! } });
      setState("on");
    } catch (err) {
      toast(errorMessage(err), { tone: "bad" });
    }
  };

  const description = {
    loading: "",
    on: "Fills, deposits and thesis posts from people you follow.",
    off: "Get alerts on this device.",
    unsupported: "Not available on this device.",
    needs_install: "On iPhone, add the app to your Home Screen first.",
  }[state];

  return (
    <Row
      label="Push notifications"
      value={description}
      action={
        state === "on" || state === "off" ? (
          <Button variant={state === "on" ? "secondary" : "primary"} className="px-3 py-1.5 text-sm" onClick={() => void toggle()}>
            {state === "on" ? "Turn off" : "Turn on"}
          </Button>
        ) : undefined
      }
    />
  );
}

export default function SettingsPage() {
  const { status, login, logout, wallet, mode } = useAuth();
  const config = useConfig();
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [withdraw, setWithdraw] = useState(false);
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: () => api.blocks(), enabled: status === "in" });
  const unblock = useMutation({
    mutationFn: (username: string) => api.unblock(username),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["blocks"] }),
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  if (status === "out") return <EmptyState title="Settings" body="Sign in to manage your account." action={<Button onClick={login}>Sign in</Button>} />;
  if (!me.data) return null;
  const evm = evmAddressOf(me.data);
  const sol = solanaAddressOf(me.data);

  const exportKeys = (chainType: "evm" | "solana") => {
    wallet.exportWallet(chainType).catch((err: unknown) => toast(errorMessage(err), { tone: "bad" }));
  };

  return (
    <div className="pb-6">
      <PageTitle>Settings</PageTitle>
      <div className="flex items-center gap-3 px-4">
        <Avatar user={me.data} size={44} />
        <Link href={`/u/${me.data.username}`} className="font-semibold">
          {me.data.username}
        </Link>
      </div>

      <OneTapSection />

      <Section title="Funds">
        <Row label="Add USDC" action={<LinkButton href="/deposit" variant="secondary" className="px-3 py-1.5 text-sm">Add</LinkButton>} />
        <Row
          label="Withdraw USDC"
          value="Send your balance to any address on Arc."
          action={
            <Button variant="secondary" className="px-3 py-1.5 text-sm" onClick={() => setWithdraw(true)}>
              Withdraw
            </Button>
          }
        />
      </Section>

      <Section title="Wallets">
        {config.authMode === "dev" && <Row label="Paper wallets" value="Stand-ins for testing. No real key controls them, so never send real funds to them." />}
        {evm && <Row label="EVM wallet" value={<span className="num">{shortAddress(evm, 6)}</span>} action={config.authMode === "privy" ? <CopyButton text={evm} /> : undefined} />}
        {sol && <Row label="Solana wallet" value={<span className="num">{shortAddress(sol, 6)}</span>} action={config.authMode === "privy" ? <CopyButton text={sol} /> : undefined} />}
        {me.data.wallets
          .filter((w) => !w.isEmbedded)
          .map((w) => (
            <Row key={w.address} label={`Connected ${w.chainType === "evm" ? "EVM" : "Solana"} wallet`} value={<span className="num">{shortAddress(w.address, 6)}</span>} action={<CopyButton text={w.address} />} />
          ))}
        <Row
          label="Export private keys"
          value="Your keys are yours. Keep them secret: anyone with them controls your funds."
          action={
            <div className="flex shrink-0 gap-1">
              <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => exportKeys("evm")}>
                EVM
              </Button>
              <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => exportKeys("solana")}>
                Solana
              </Button>
            </div>
          }
        />
      </Section>

      <Section title="Notifications">
        <NotificationsRow />
      </Section>

      {!!blocks.data?.items.length && (
        <Section title="Blocked">
          {blocks.data.items.map((b) => (
            <Row
              key={b.id}
              label={b.username}
              action={
                <Button variant="secondary" className="px-3 py-1.5 text-sm" onClick={() => unblock.mutate(b.username)}>
                  Unblock
                </Button>
              }
            />
          ))}
        </Section>
      )}

      <Section title="Legal">
        <Row label="Terms of Service" action={<Link href="/legal/terms" className="text-sm text-muted">Open</Link>} />
        <Row label="Privacy Policy" action={<Link href="/legal/privacy" className="text-sm text-muted">Open</Link>} />
        <Row label="Risk Disclosure" action={<Link href="/legal/risk" className="text-sm text-muted">Open</Link>} />
      </Section>

      <div className="mt-6 px-4">
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            void logout().then(() => {
              queryClient.clear();
              router.replace("/");
            });
          }}
        >
          Sign out
        </Button>
        {mode === "dev" && <p className="mt-2 text-center text-xs text-faint">Dev sign-in. Not available in production.</p>}
      </div>
      <WithdrawSheet open={withdraw} onClose={() => setWithdraw(false)} />
    </div>
  );
}
