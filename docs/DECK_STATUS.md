# Deck coverage

Status of every section of the production plan.

- **Verified**: run for real, by a test or in the browser.
- **Built, unverified**: written and type-checked against the real SDK, but it needs your keys or real funds to run.
- **Not built**: left out, with the reason.

## Where this departs from the deck

| Deck says | What I did | Why |
|---|---|---|
| Quote race has a 1.5s timeout | 1.5s only applies once a quote is in, with a 4.5s ceiling | Flash took over 4s once and LI.FI took 1.5s in testing. A hard cutoff can fail a trade that has a route. |
| Reject over 5% impact, over 2% of pool, and flagged tokens | Hard stop on buys. On sells these become a visible confirm | A token can turn bad after you buy it, and users must always be able to get out. |
| `createOnLogin: users-without-wallets` | `all-users` | The deck also says both wallets are created on login. External-wallet users otherwise get no embedded wallet, so no one-tap or Solana sells. |
| Signer policy allows "only the user's own address as recipient" | Pinned in the server's quote request, not in the policy | A live cross-chain `FlashOrder.recipient` is Flash's bridge address, not the user's. The field can't be used for this. |
| Holders via Moralis, Birdeye or Codex, "Unverified for Arc" | GeckoTerminal's token info | It returns real holder counts and top-10 share on Arc, with no extra vendor. |
| "Solana setup: sponsored by Definitive" | Tries Privy sponsorship | Flash's docs now say sponsorship is "off for new accounts" and rent is never sponsored. See GO_LIVE.md. |
| Uniswap Trading API on Arc "Unverified", UniswapX "pending" | Built for Trading API, AMM routes only, with a direct v3 fallback | Confirmed with a live key: `/quote` serves Arc and returns an AMM route. The real calldata for a $5 buy succeeds in a dry run against live pools, and the fill parser matches real swaps by other people to the cent. A real swap from our own wallet is still untested. |
| 1-second price feed | Evenly spaced calls, so about every 2 seconds across all chains | DexScreener limits per IP and also refuses bursts. Sending every chain at once got refused, which left token pages without data. |
| Preset trade amounts | Presets plus an amount field, for any dollar amount or sell percent | You asked for this in testing. The app has no minimum of its own, but routes can still refuse a very small amount. |
| Use Flash's suggested slippage | 20% cross-chain and 5% on Arc, sent on every order, with Flash's own impact cap at 50% | You asked for orders to execute in one tap after talking to Definitive. The app's own impact checks still run on the quote first. |
| Show trade status as it happens | "Buying" with a spinner, then "Bought" about 3 seconds before the expected fill | You asked for this in testing. A failure after that corrects the toast and receipt. |
| "Server tops up ETH and deducts it from sell proceeds" | Pimlico's paymaster pays gas for upgraded wallets, the way FOMO does. The top-up remains only for HyperEVM | You asked for trading to be entirely gasless. `pnpm sponsor:test` proves it on Arc and Base: empty wallets upgrade and send real sponsored transactions, and Flash accepts their signatures. No funded trade has run through it yet. |
| Trades above a one-tap limit confirm in the wallet | With gasless on, they confirm in the app and the server signs them | The gas is paid through the server's signer. The signer policy still limits what can be signed, but a stolen session could now pass a cap. |
| Reject over 5% impact on buys | Under $10, a confirm that states the percentage lost. From $10 up, still a hard stop | You chose this in testing. On small buys it's mostly a route's fixed costs. The 2% of pool stop still applies at any size. |
| Buy with card through Circle Onramp Kit | Links to `portal.arc.io/deposit/fiat` | Works today with no key. Embedding the widget needs a Circle API key. |
| "Server tops up ETH and deducts it from sell proceeds" | Recovered through Flash's integrator fee on that sell | Avoids giving the signer permission to transfer the user's funds. |

## Sections

| Section | Status | Notes |
|---|---|---|
| Build scope and hard rules | Verified | Market orders only. A test fails if the banned endpoint appears anywhere in the code. |
| Mobile-first PWA | Verified in dev | Checked at 375px and desktop. The service worker and install prompt only run in production builds. |
| Web Push | Built, unverified | Needs VAPID keys and a device. |
| Arc gotchas | Verified | Checked against mainnet RPC. USDC decimals are kept apart, and a test replays the real double-log receipt shape. |
| Login and wallets (Privy) | Partly verified | Real app connected, login window loads with email, Google and wallet at phone width, with no console errors. A full sign-in and wallet creation haven't run yet, since they need your Google account. Dev login is off and refuses to run in production. |
| Deposits and gas | Partly verified | Paper flow verified. The real Arc balance read is verified on an empty wallet. Live address and QR, bridge link and card link are built, but only show once signed in. Balance-change deposit detection is unverified. |
| Market data | Verified | Live: DexScreener prices, GeckoTerminal candles, tape, holders, trending and new. Both budgets are shared through Redis, and a token page shows the last known price under a rate limit. Trades and thesis prices refuse a stale price. |
| Routing engine | Verified | Live quotes from Uniswap on Arc, Flash and LI.FI. Scoring, guardrails and tolerance are unit-tested. |
| One-tap trading | Mostly verified without funds | Against real Privy with empty wallets: real signatures on Flash orders and Uniswap buys and sells, and the policies block drains, unknown contracts, arbitrary messages and hidden Solana transfers. Caps and the server path are tested in live mode. A real one-tap buy has filled from your wallet: $3 from Arc to Base in 39 seconds. Same-chain buys and all sells are still unproven with real funds. |
| User flows | Verified in paper | Walked through in the browser: onboarding, deposit, buy, thesis, pin, sell, portfolio, profile, settings, search. Signed-out pages are also checked in live mode. Signed-in live pages need your sign-in. |
| Thesis on chart | Verified | Pins at post time and price. Tapping one opens the thesis. Only theses appear, never plain trades. |
| On-chain thesis registry | Verified on mainnet | Not in the deck's flows, added for the Arc prize. A running worker anchored a test thesis in about 20 seconds, and its hash was recomputed independently. See `ARC_STUDIO_BRIEF.md`. |
| Architecture | Verified | API and workers, Redis pub/sub, websockets. The production bundles boot. |
| Data model and PnL | Verified | Weighted average cost, checked by tests and by hand against a real browser session. |
| Reconciliation | Built, unverified | Pure logic is tested. The loop only runs in live mode. |
| Security and compliance | Mostly verified | Rate limits, spam filter, verified badge, geo-block and audit log are tested. KMS and legal review are open. |
| Beating fomo | Verified | Accuracy leaderboard, copy-buy with author's entry and a size cap, risk flags, X share cards, follower alerts. |
| Things you didn't mention | Mostly verified | See below. |
| Prize mapping | See below | |
| Native store apps | Not built | Out of hackathon scope in the deck. `packages/core` has no web or Node dependencies, so an Expo app can reuse it. |

## "Things you didn't mention"

1. Destination-chain gas for sells: built, unverified. Privy sponsorship, then a top-up.
2. Solana token sells: built, unverified, and the riskiest path.
3. Edit and delete rules: verified. Price locks at post, delete is allowed, there's no edit.
4. Reporting and blocking: verified.
5. Notifications: in-app verified, push built. Email isn't built, since the deck says "email or push".
6. Terms, privacy, risk: written as visibly marked drafts. They need a lawyer.
7. Fee model: **your decision.** `FLASH_INTEGRATOR_FEE_BPS` defaults to 0, so the app charges nothing. Flash collects it per trade.
8. Empty-wallet onboarding: verified.

## Prizes

| Prize | Status |
|---|---|
| Arc, $3k | Contract built and tested in Arc Studio, deployed to mainnet and integrated. Needs showing in the demo. See `ARC_STUDIO_BRIEF.md`. |
| Uniswap, $10k pool | Code is done and linked from the README, running on your API key. `FEEDBACK.md` has real findings and needs your live-test notes. |
| Definitive, $2.5k | Out, as the deck says: market orders only. |
