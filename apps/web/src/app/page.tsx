"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Landing } from "@/components/landing";
import { useAuth } from "@/lib/auth";

/** A quiet branded splash shown while the session resolves, or while an authenticated user is
 *  being sent on to the app — so neither the marketing page nor the app ever flashes first. */
function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden className="animate-shimmer text-signal">
        <path fill="currentColor" d="M13.5 2 4 13.5h6.2L9 22l10-12.5h-6.4L13.5 2Z" />
      </svg>
      <span className="sr-only">Loading</span>
    </div>
  );
}

export default function HomePage() {
  const { status } = useAuth();
  const router = useRouter();

  // A signed-in Privy session lands straight in the app; it never has to log in again here.
  useEffect(() => {
    if (status === "in") router.replace("/discovery");
  }, [status, router]);

  if (status === "out") return <Landing />;
  return <Splash />;
}
