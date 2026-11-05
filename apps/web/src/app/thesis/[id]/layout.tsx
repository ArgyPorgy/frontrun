import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Gives shared links a preview card on X and elsewhere. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const image = `/api/og/thesis/${id}`;
  return {
    title: "Thesis",
    openGraph: { images: [image] },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default function ThesisLayout({ children }: { children: ReactNode }) {
  return children;
}
