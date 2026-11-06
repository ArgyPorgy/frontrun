"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoMark } from "@/components/brand";
import { Landing } from "@/components/landing";
import { useAuth } from "@/lib/auth";

/** A quiet branded splash shown while the session resolves, or while an authenticated user is
 *  being sent on to the app — so neither the marketing page nor the app ever flashes first. */
function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <LogoMark width={48} className="animate-shimmer" />
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
