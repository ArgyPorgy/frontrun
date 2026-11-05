"use client";

import { CHAINS, CHAIN_KEYS, type ChainKey } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TokenRow } from "@/components/token-row";
import { EmptyState, PillFilter, RowSkeletons } from "@/components/ui";
import { api } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";

const CHAIN_OPTIONS: Array<{ value: ChainKey | "all"; label: string }> = [
  { value: "all", label: "All chains" },
  ...CHAIN_KEYS.map((k) => ({ value: k as ChainKey | "all", label: CHAINS[k].name })),
];

export default function SearchPage() {
  const [text, setText] = useState("");
  const [chain, setChain] = useState<ChainKey | "all">("all");
  const q = useDebounced(text.trim(), 300);
  const results = useQuery({
    queryKey: ["search", q, chain],
    queryFn: () => api.search(q, chain === "all" ? undefined : chain),
    enabled: q.length >= 2,
  });
  return (
    <div>
      <div className="px-4 pt-3">
        <input
          autoFocus
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, ticker or contract address"
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Search tokens"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 outline-none focus:border-signal"
        />
      </div>
      <PillFilter className="mt-2 px-4 pb-2" value={chain} onChange={setChain} options={CHAIN_OPTIONS} />
      {q.length < 2 ? (
        <EmptyState title="Find any token" body="Across Arc, Robinhood Chain, Base, Arbitrum, Ethereum, BNB Chain, HyperEVM and Solana." />
      ) : results.isLoading ? (
        <RowSkeletons count={6} />
      ) : results.data?.items.length ? (
        <div className="divide-y divide-line/60">
          {results.data.items.map((t, i) => (
            <TokenRow key={`${t.chain}:${t.address}`} token={t} live={i < 10} />
          ))}
        </div>
      ) : (
        <EmptyState title="No matches" body="Check the spelling, or paste the contract address. Tokens flagged as high risk are left out." />
      )}
    </div>
  );
}
