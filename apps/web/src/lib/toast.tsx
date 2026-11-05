"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "neutral" | "good" | "bad" | "pending";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  href?: string;
}

interface ToastOptions {
  tone?: ToastTone;
  href?: string;
  /** Replaces an earlier toast with the same key, so a trade updates in place. */
  key?: string;
  sticky?: boolean;
}

interface ToastApi {
  toast(message: string, options?: ToastOptions): void;
  dismiss(key: string): void;
  /** Hands a showing toast to a new key, so it updates in place once its real id is known. */
  rekey(from: string, to: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, string> = {
  neutral: "bg-raised",
  good: "bg-raised text-up",
  bad: "bg-raised text-down",
  pending: "bg-raised",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const byKey = useRef(new Map<string, number>());

  const toast = useCallback((message: string, options: ToastOptions = {}) => {
    const existing = options.key ? byKey.current.get(options.key) : undefined;
    const id = existing ?? nextId.current++;
    if (options.key) byKey.current.set(options.key, id);
    const item: Toast = { id, message, tone: options.tone ?? "neutral", href: options.href };
    // A keyed toast may already have timed out, and a late update to it still has to show.
    setToasts((list) => (list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? item : t)) : [...list.slice(-2), item]));
    if (!options.sticky) {
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id || t.message !== message)), 4500);
    }
  }, []);

  const dismiss = useCallback((key: string) => {
    const id = byKey.current.get(key);
    if (id === undefined) return;
    byKey.current.delete(key);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const rekey = useCallback((from: string, to: string) => {
    const id = byKey.current.get(from);
    if (id === undefined) return;
    byKey.current.delete(from);
    byKey.current.set(to, id);
  }, []);

  const value = useMemo(() => ({ toast, dismiss, rekey }), [toast, dismiss, rekey]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+10px)]" aria-live="polite">
        {toasts.map((t) => {
          const body = (
            <div className={`animate-toast pointer-events-auto flex max-w-sm items-center gap-2 rounded-full border border-line px-4 py-2.5 text-sm font-medium shadow-lg ${TONE[t.tone]}`}>
              {t.tone === "pending" && <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-signal" />}
              <span>{t.message}</span>
            </div>
          );
          return t.href ? (
            <Link key={t.id} href={t.href}>
              {body}
            </Link>
          ) : (
            <div key={t.id}>{body}</div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast needs ToastProvider");
  return value;
}
