"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button, EmptyState, RowSkeletons } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";

export default function MyProfilePage() {
  const { status, login } = useAuth();
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (me.data) router.replace(`/u/${me.data.username}`);
  }, [me.data, router]);
  if (status === "out") {
    return <EmptyState title="Your profile" body="Sign in to post theses and build a track record." action={<Button onClick={login}>Sign in</Button>} />;
  }
  return <RowSkeletons count={4} />;
}
