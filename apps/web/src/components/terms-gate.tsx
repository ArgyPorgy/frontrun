"use client";

import { ELIGIBILITY_CONFIRMATIONS, TERMS_VERSION } from "@frontrun/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";
import { Button, Sheet } from "./ui";

/** Asks once, before anyone can trade, that they agree to the terms and confirm they're eligible. */
export function TermsGate() {
  const { status, logout } = useAuth();
  const me = useMe();
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState(false);
  const accept = useMutation({
    mutationFn: () => api.acceptTerms(TERMS_VERSION),
    onSuccess: (updated) => queryClient.setQueryData(["me"], updated),
  });
  const open = status === "in" && !!me.data && !me.data.termsAccepted;

  return (
    <Sheet open={open} onClose={() => {}} title="Before you trade">
      <p className="text-sm text-muted">Front Run is for people outside the United States. Please confirm each of these:</p>
      <ul className="mt-3 space-y-2 text-sm">
        {ELIGIBILITY_CONFIRMATIONS.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="text-signal">•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-signal)]" />
        <span>
          All of the above is true, and I agree to the{" "}
          <Link href="/legal/terms" target="_blank" className="text-signal underline underline-offset-2">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/legal/privacy" target="_blank" className="text-signal underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </span>
      </label>
      {accept.isError && <p className="mt-2 text-sm text-down">{errorMessage(accept.error)}</p>}
      <Button className="mt-4 w-full" disabled={!checked || accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending ? "One moment…" : "Agree and continue"}
      </Button>
      <button className="mt-2 w-full py-2 text-sm text-muted" onClick={() => logout()}>
        I'm not eligible, sign me out
      </button>
    </Sheet>
  );
}
