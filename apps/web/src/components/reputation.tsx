"use client";

import { API_URL } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { CHAINS, REPUTATION_WEIGHTS, SCORE_OF_SELECTOR, explorerTxUrl, formatPct, shortAddress, timeAgo, type ReputationComponents, type ReputationView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";

const PARTS: Array<{ key: keyof ReputationComponents; label: string; detail: (r: ReputationView) => string }> = [
  { key: "win", label: "Win rate", detail: (r) => `${r.wins} of ${r.closed} closed in profit` },
  { key: "return", label: "Return", detail: (r) => `${formatPct(r.avgReturnPct)} average` },
  { key: "risk", label: "Risk taken", detail: (r) => `${formatPct(r.avgDrawdownPct, { sign: false })} average dip` },
  { key: "hold", label: "Holding time", detail: (r) => holdLabel(r.avgHoldSeconds) },
  { key: "fees", label: "Fees", detail: (r) => `${formatPct(r.feePct, { sign: false })} of volume` },
];

export function holdLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(Math.round(seconds / 60), 1)}m average`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h average`;
  return `${Math.round(seconds / 86_400)}d average`;
}

export function ScoreGauge({ score, size = 76 }: { score: number; size?: number }) {
  const radius = 42;
  const length = Math.PI * 2 * radius * 0.75;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Score ${score} out of 100`} className="shrink-0">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--color-line)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${length} 1000`} transform="rotate(135 50 50)" />
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--color-signal)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(length * score) / 100} 1000`} transform="rotate(135 50 50)" />
      <text x="50" y="58" textAnchor="middle" className="num" fontSize="28" fontWeight="600" fill="var(--color-ink)">
        {score}
      </text>
    </svg>
  );
}

/** Reads the score straight from Arc in this browser, so it isn't our word for it. */
async function readScoreFromArc(registry: string, wallet: string): Promise<{ score: number; attestedAt: number }> {
  const data = `${SCORE_OF_SELECTOR}${wallet.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(CHAINS.arc.defaultRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: registry, data }, "latest"] }),
  });
  const { result } = (await res.json()) as { result?: string };
  if (!result || result.length < 130) throw new Error("No answer from Arc");
  return { score: Number(BigInt(`0x${result.slice(2, 66)}`)), attestedAt: Number(BigInt(`0x${result.slice(66, 130)}`)) };
}

function Copyable({ label, text }: { label: string; text: string }) {
  const { toast } = useToast();
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        <button
          className="text-xs text-signal"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast("Copied");
          }}
        >
          Copy
        </button>
      </div>
      <pre className="num mt-1 overflow-x-auto rounded-lg bg-bg p-2 text-[11px] leading-relaxed text-muted">{text}</pre>
    </div>
  );
}

export function ReputationCard({ reputation: r }: { reputation: ReputationView }) {
  const onChain = useQuery({
    queryKey: ["arc-score", r.wallet],
    queryFn: () => readScoreFromArc(r.registry, r.wallet!),
    enabled: !!r.wallet && !!r.attestTx,
    staleTime: 30_000,
    retry: 1,
  });
  const cast = r.wallet ? `cast call ${r.registry} "scoreOf(address)(uint16,uint64)" ${r.wallet} --rpc-url ${CHAINS.arc.defaultRpc}` : null;
  const solidity = r.wallet ? `(uint16 score, uint64 attestedAt) = IReputationRegistry(${r.registry}).scoreOf(trader);` : null;

  return (
    <section className="mt-3 rounded-2xl bg-surface p-3">
      <div className="flex items-center gap-3">
        <ScoreGauge score={r.score} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            Reputation score
            {r.provisional && <span className="ml-1.5 rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted">Provisional</span>}
          </h2>
          <p className="text-xs text-muted">
            From {r.closed} closed {r.closed === 1 ? "position" : "positions"} with a verified thesis. {r.provisional ? "A short record is pulled toward the middle." : ""}
          </p>
          {r.attestTx ? (
            <a href={explorerTxUrl("arc", r.attestTx)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-signal underline underline-offset-2">
              Attested on Arc{r.attestedAt ? ` ${timeAgo(r.attestedAt)}` : ""}
            </a>
          ) : (
            <p className="mt-1 text-xs text-faint">Writing to Arc</p>
          )}
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {PARTS.map((part) => {
          const max = REPUTATION_WEIGHTS[part.key];
          const value = r.components[part.key];
          return (
            <li key={part.key}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{part.label}</span>
                <span className="num text-muted">
                  {part.detail(r)} · {Math.round(value)}/{max}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-signal" style={{ width: `${Math.min((value / max) * 100, 100)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      {r.wallet && r.attestTx && (
        <details className="mt-3 border-t border-line/70 pt-2">
          <summary className="cursor-pointer text-sm font-medium">Read it yourself</summary>
          <div className="mt-2 space-y-3">
            <p className="text-xs text-muted">
              {onChain.data ? (
                <>
                  Just read from Arc in your browser: <span className="num font-semibold text-signal">{onChain.data.score}</span> for wallet {shortAddress(r.wallet)}.
                </>
              ) : onChain.isError ? (
                "Couldn't reach Arc from here just now. The commands below read the same record."
              ) : (
                "Reading from Arc in your browser…"
              )}
            </p>
            {cast && <Copyable label="From a terminal" text={cast} />}
            {solidity && <Copyable label="From a contract" text={solidity} />}
            <Copyable label="From an app or bot, no account needed" text={`${API_URL}/v1/reputation/${r.wallet}`} />
          </div>
        </details>
      )}
    </section>
  );
}
