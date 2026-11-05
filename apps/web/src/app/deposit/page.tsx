"use client";

import { formatUsd, PAPER_STARTING_BALANCE_USD } from "@frontrun/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button, CopyButton, EmptyState, PageTitle } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { evmAddressOf, useBalance, useConfig, useMe } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

function AddressQr({ address }: { address: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toString(address, { type: "svg", margin: 1, color: { dark: "#0a0c0b", light: "#ffffff" } }).then(setSvg);
  }, [address]);
  if (!svg) return <div className="h-44 w-44 rounded-2xl bg-raised" />;
  // The SVG is generated locally from the wallet address, so there's no outside markup to escape.
  return <div className="h-44 w-44 overflow-hidden rounded-2xl" role="img" aria-label="QR code for your Arc address" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Option({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface p-3">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted">{body}</p>
      </div>
      {children}
    </div>
  );
}

export default function DepositPage() {
  const { status, login } = useAuth();
  const config = useConfig();
  const me = useMe();
  const balance = useBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const address = evmAddressOf(me.data);

  const paper = useMutation({
    mutationFn: () => api.paperDeposit(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["balance"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      toast(`Added $${PAPER_STARTING_BALANCE_USD} paper USDC`, { tone: "good" });
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  if (status === "out") return <EmptyState title="Add funds" body="Sign in to get your wallet." action={<Button onClick={login}>Sign in</Button>} />;
  if (!address) return null;

  return (
    <div>
      <PageTitle>Add USDC</PageTitle>
      <p className="px-4 text-sm text-muted">
        Balance: <span className="num text-ink">{formatUsd(balance.data?.usdc)}</span>
      </p>

      {config.tradingMode === "paper" && (
        <div className="mx-4 mt-3 rounded-2xl border border-warn/30 bg-warn/10 p-3">
          <p className="font-semibold text-warn">Paper mode</p>
          <p className="text-sm text-muted">Nothing here is real. Add test balance to try the full flow.</p>
          <Button onClick={() => paper.mutate()} disabled={paper.isPending} className="mt-2 w-full">
            Add ${PAPER_STARTING_BALANCE_USD} paper USDC
          </Button>
        </div>
      )}

      {/* Paper wallets are stand-ins that no real key controls. Showing one as a deposit address
          could cost someone real money, so a live address only ever appears in live mode. */}
      {config.tradingMode === "live" && (
        <>
          <section className="mt-4 flex flex-col items-center px-4">
            <AddressQr address={address} />
            <p className="num mt-3 text-center text-xs break-all text-muted">{address}</p>
            <CopyButton text={address} label="Copy address" className="mt-2 px-3 py-1.5 text-sm" />
            <p className="mt-3 max-w-xs text-center text-sm text-warn">Send only USDC, and only on the Arc network. Funds sent on other networks may not arrive here.</p>
            <p className="mt-1 text-center text-xs text-muted">We&apos;ll let you know as soon as it lands.</p>
          </section>

          <section className="mt-5 space-y-2 px-4">
            <Option title="From another chain" body="Bridge USDC or any token to your Arc address.">
              <a
                href={config.bridgeUrlTemplate.replace("{address}", address)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-xl bg-raised px-3 py-2 text-sm font-semibold"
              >
                Bridge
              </a>
            </Option>
            <Option title="Buy with card" body="Buy USDC on Arc through Circle's portal. Paste your address there.">
              <a href="https://portal.arc.io/deposit/fiat" target="_blank" rel="noreferrer" className="shrink-0 rounded-xl bg-raised px-3 py-2 text-sm font-semibold">
                Buy
              </a>
            </Option>
            <Option title="From an exchange" body="Withdraw USDC to your address and pick Arc, if your exchange supports it.">
              <CopyButton text={address} label="Copy" className="shrink-0 px-3 py-2 text-sm" />
            </Option>
          </section>
        </>
      )}
    </div>
  );
}
