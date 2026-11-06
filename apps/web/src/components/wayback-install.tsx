"use client";

import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
}

type Platform = "loading" | "installed" | "android" | "ios" | "other";

/**
 * Promotes installing the app to the home screen — the "Wayback" install — reusing the same
 * Progressive Web App flow the in-app InstallHint uses: Android fires `beforeinstallprompt` and
 * gets the native prompt, iOS gets the Share-sheet hint, and an already-installed app is detected
 * through `display-mode: standalone`. No store links, no download: it's the real install path.
 */
export function WaybackInstall() {
  const [platform, setPlatform] = useState<Platform>("loading");
  const [androidEvent, setAndroidEvent] = useState<InstallEvent | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setPlatform("installed");
      return;
    }
    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
    setPlatform(isIos ? "ios" : "other");

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setAndroidEvent(e as InstallEvent);
      setPlatform("android");
    };
    const onInstalled = () => {
      setInstalled(true);
      setAndroidEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const done = platform === "installed" || installed;

  const onClick = () => {
    if (androidEvent) {
      void androidEvent.prompt();
      return;
    }
    // iOS and other browsers can't be triggered programmatically, so reveal the manual steps.
    setShowSteps((s) => !s);
  };

  const steps =
    platform === "ios"
      ? "Tap the Share button, then choose “Add to Home Screen.”"
      : "Open your browser menu and choose “Install app” or “Add to Home Screen.”";

  return (
    <section id="wayback" className="mx-auto w-full max-w-5xl px-4 py-16 md:py-24">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-surface/70 p-8 md:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-20 h-72 w-72 rounded-full bg-signal/15 blur-3xl"
        />
        <div className="relative grid items-center gap-10 md:grid-cols-[1fr_auto]">
          <div className="max-w-xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-bg/60 px-3 py-1 text-xs font-medium text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-signal" />
              Wayback app
            </span>
            <h2 className="font-display mt-4 text-3xl font-semibold tracking-tight md:text-4xl">Take it anywhere. Install Wayback.</h2>
            <p className="mt-3 text-muted">
              Add Front Run to your home screen for price alerts and faster trading. It installs straight from your browser — no app store, no download.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={onClick}
                disabled={done}
                className="inline-flex items-center gap-2 rounded-xl bg-signal px-5 py-3 font-semibold text-signal-ink transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {done ? (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Wayback installed
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                    Install Wayback
                  </>
                )}
              </button>
              {!done && platform !== "android" && (
                <button onClick={() => setShowSteps((s) => !s)} className="text-sm font-medium text-muted hover:text-ink">
                  How it works
                </button>
              )}
            </div>
            {done ? (
              <p className="mt-4 text-sm text-up">You&apos;re all set — open Wayback from your home screen any time.</p>
            ) : (
              (showSteps || platform === "ios") && <p className="mt-4 text-sm text-muted">{steps}</p>
            )}
          </div>

          {/* A small device mock, drawn in CSS so it needs no image asset. */}
          <div aria-hidden className="mx-auto hidden md:block">
            <div className="animate-float relative h-[300px] w-[150px] rounded-[2rem] border border-line bg-bg p-2 shadow-2xl shadow-black/60">
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 rounded-[1.6rem] bg-gradient-to-b from-raised to-bg">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-signal shadow-lg shadow-signal/30">
                  <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden className="text-signal-ink">
                    <path fill="currentColor" d="M13.5 2 4 13.5h6.2L9 22l10-12.5h-6.4L13.5 2Z" />
                  </svg>
                </span>
                <span className="font-display text-sm font-semibold">Front Run</span>
                <span className="h-1 w-10 rounded-full bg-line" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
