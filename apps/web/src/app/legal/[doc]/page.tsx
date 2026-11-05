import type { Metadata } from "next";
import { notFound } from "next/navigation";

type Doc = { title: string; sections: Array<{ heading: string; body: string[] }> };

const DOCS: Record<string, Doc> = {
  terms: {
    title: "Terms of Service",
    sections: [
      {
        heading: "What this service is",
        body: [
          "Front Run is software for trading tokens from a wallet you control, and for sharing opinions about those tokens. We don't hold your funds, don't pool them, and don't approve withdrawals. Trades execute through third-party routing services and decentralized venues.",
        ],
      },
      {
        heading: "Your wallet and the app signer",
        body: [
          "Your wallet is created and secured with our wallet provider, and you can export its keys at any time. If you enable one-tap trading, you add a limited signer that lets our servers place trades for you within limits you set. You can change those limits or remove the signer at any time in Settings.",
          "You're responsible for keeping your account and any exported keys secure.",
        ],
      },
      {
        heading: "Eligibility",
        body: [
          "You must be of legal age where you live, and using this service must be lawful there. It isn't available in sanctioned regions or to sanctioned persons.",
        ],
      },
      {
        heading: "Content you post",
        body: [
          "Thesis posts and replies are your own opinions. You keep ownership of them and allow us to display them in the app and in share cards. Don't post scams, wallet-drainer links, spam or illegal content. We may hide content and suspend accounts that break these rules. A thesis's price and position lock when you post it. You can delete a thesis, but not edit it.",
        ],
      },
      {
        heading: "No advice, no warranty",
        body: [
          "Nothing in the app is financial, investment, legal or tax advice. The service is provided as is. To the extent the law allows, we aren't liable for trading losses, failed or delayed trades, or the actions of third-party services and blockchains.",
        ],
      },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    sections: [
      {
        heading: "What we collect",
        body: [
          "Your login identity through our authentication provider, the username and avatar you choose, your wallet addresses, your trades and positions, what you post, and basic technical data such as IP address for rate limiting, regional restrictions and security.",
        ],
      },
      {
        heading: "What's public",
        body: [
          "Your username, avatar, thesis posts, replies, positions, PnL and thesis accuracy are visible to anyone. Wallet addresses and on-chain activity are public on their blockchains regardless of this app.",
        ],
      },
      {
        heading: "Who we share with",
        body: [
          "Service providers that make the app work: authentication and wallet infrastructure, trade routing, market data, hosting, and error monitoring. We don't sell personal data.",
        ],
      },
      {
        heading: "Your choices",
        body: [
          "You can delete thesis posts and replies, turn notifications off, remove the app signer and export your keys. To ask for your account data to be deleted, contact us. On-chain records can't be erased by anyone.",
        ],
      },
    ],
  },
  risk: {
    title: "Risk Disclosure",
    sections: [
      {
        heading: "You can lose everything you trade",
        body: [
          "Tokens listed here include extremely volatile, thinly traded and newly launched assets. Many lose most or all of their value. Only trade what you can afford to lose.",
        ],
      },
      {
        heading: "A thesis is an opinion",
        body: [
          "A thesis is one person's view and is not advice. Showing a verified position means the author held the token when posting, not that they still hold it or that they are right. Authors may sell at any time, including to people copying them. Past accuracy doesn't predict future results.",
        ],
      },
      {
        heading: "One-tap trading",
        body: [
          "One-tap trading lets our servers sign trades for you within your limits, and approves the trading contract to spend your USDC. If our systems or that contract were compromised, you could lose funds up to those limits or, through the approval, your USDC balance. You can remove the signer and reset approvals in Settings at any time.",
        ],
      },
      {
        heading: "Cross-chain trades",
        body: [
          "Trades that cross chains rely on bridges and third parties. They can be delayed, can fill at a worse price within the slippage limit, or can fail and refund on the chain they started from. Selling tokens on some chains can need a small amount of network gas that we try to cover for you.",
        ],
      },
      {
        heading: "Risk flags aren't guarantees",
        body: [
          "Risk flags and limits are best-effort signals from third-party data. A token with no flags can still be a scam or lose its value.",
        ],
      },
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  return { title: DOCS[doc]?.title ?? "Legal" };
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const content = DOCS[doc];
  if (!content) notFound();
  return (
    <article className="mx-auto max-w-2xl px-4 py-5">
      <h1 className="text-2xl font-semibold tracking-tight">{content.title}</h1>
      <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">Draft for the hackathon. This needs review by a lawyer before a public launch.</p>
      {content.sections.map((section) => (
        <section key={section.heading} className="mt-5">
          <h2 className="font-semibold">{section.heading}</h2>
          {section.body.map((p) => (
            <p key={p.slice(0, 32)} className="mt-1.5 text-muted">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
