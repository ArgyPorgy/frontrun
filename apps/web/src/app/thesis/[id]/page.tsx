"use client";

import { REPLY_MAX_LENGTH, timeAgo } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ThesisCard } from "@/components/thesis-card";
import { Avatar, Button, EmptyState, RowSkeletons } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

export default function ThesisPage() {
  const { id } = useParams<{ id: string }>();
  const { status, login } = useAuth();
  const me = useMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const thesis = useQuery({ queryKey: ["theses", "one", id], queryFn: () => api.thesis(id) });
  const replies = useQuery({ queryKey: ["theses", "replies", id], queryFn: () => api.replies(id) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["theses", "replies", id] });
    void queryClient.invalidateQueries({ queryKey: ["theses", "one", id] });
  };
  const post = useMutation({
    mutationFn: () => api.reply(id, body),
    onSuccess: () => {
      setBody("");
      refresh();
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const remove = useMutation({
    mutationFn: (replyId: string) => api.deleteReply(id, replyId),
    onSuccess: refresh,
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  if (thesis.isLoading) return <RowSkeletons count={3} />;
  if (!thesis.data) return <EmptyState title="This thesis is gone" body="It may have been deleted or hidden after reports." />;

  return (
    <div>
      <ThesisCard thesis={thesis.data} />
      <div className="border-t border-line/70 px-4 py-3">
        {status === "in" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (body.trim()) post.mutate();
            }}
            className="flex items-center gap-2"
          >
            <input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={REPLY_MAX_LENGTH}
              placeholder="Add a reply"
              aria-label="Reply"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-signal"
            />
            <Button type="submit" disabled={!body.trim() || post.isPending} className="px-3 py-2 text-sm">
              Reply
            </Button>
          </form>
        ) : (
          <Button variant="secondary" className="w-full" onClick={login}>
            Sign in to reply
          </Button>
        )}
      </div>
      <ul className="divide-y divide-line/60">
        {replies.data?.items.map((r) => (
          <li key={r.id} className="flex gap-2.5 px-4 py-3">
            <Link href={`/u/${r.author.username}`} aria-label={r.author.username}>
              <Avatar user={r.author} size={28} />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <Link href={`/u/${r.author.username}`} className="font-semibold">
                  {r.author.username}
                </Link>{" "}
                <span className="text-xs text-faint">{timeAgo(r.createdAt)}</span>
              </p>
              <p className="break-words whitespace-pre-wrap">{r.body}</p>
            </div>
            {me.data?.id === r.author.id && (
              <button onClick={() => remove.mutate(r.id)} className="self-start text-xs text-faint">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
