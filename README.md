# Front Run

A browser-only, non-custodial social trading app. Sign in with Google, hold one USDC balance on [Arc](https://arc.io), buy any token on 8 chains in one tap, and read theses pinned to the chart by people whose position size is verified.

The app name lives in `APP_NAME` in `packages/core/src/index.ts`, plus the layout metadata, manifest and share card.

## Run it

You need Node 22+, pnpm, Postgres and Redis. No API keys are needed: it starts in paper mode, with real market data and real routes but simulated fills and a stand-in login.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
createdb frontrun_dev
```

```bash
pnpm dev
```

Open http://localhost:3000. To add real keys, paste them into `.env` and run `pnpm keys:check`, which tests each one with read-only calls and never prints its value. [docs/GO_LIVE.md](docs/GO_LIVE.md) has the order to add them in.

If you'd rather not install Postgres and Redis, `docker compose up -d` starts both, and you then set `DATABASE_URL=postgres://frontrun:frontrun@localhost:5432/frontrun_dev`.

## How it fits together

```
Browser (Next.js PWA) ── websocket, 1s ticks ──┐
      │                                        │
      │ REST, Privy JWT                        │
      ▼                                        │
apps/api (Fastify, Socket.IO) ◄── Redis pub/sub ── apps/workers
      │                                              price feed, trade indexer,
      ▼                                              lists, reconcile, moderation
routing race: Uniswap / Flash / LI.FI          Postgres
```

| Path | What it is |
|---|---|
| `apps/web` | Mobile-first PWA: Next.js App Router, Tailwind, Lightweight Charts |
| `apps/api` | REST API and websocket hub |
| `apps/workers` | Background jobs, each under a Redis lease so scaling out is safe |
| `packages/core` | Shared types, PnL math, routing rules, formatting and API client, with no web or Node dependencies |
| `packages/server` | Database schema, provider clients, routing engine, signer |

### How a trade runs

1. **Quote.** Every provider serving the route is asked at once. The best score wins: net USD out, minus a penalty for slow routes and for failure history. The user only ever sees one price.
2. **Guardrails.** Price impact, pool share and risk flags. Hard stops on buys, visible confirms on sells, so nobody gets trapped in a token.
3. **Execute.** With a live signer grant and within caps, the backend signs through Privy and the trade takes one tap. Otherwise the same steps go to the wallet with a visible prompt.
4. **Sanity check.** Before anything is signed, the payload is compared against the quote: wallet, token, amount, chain, domain and spender.
5. **Track.** The indexer polls the provider, applies the fill to the position exactly once, and pushes the result over the websocket.

## Uniswap integration

For prize reviewers, the code that calls Uniswap directly:

- [`packages/server/src/providers/uniswap.ts`](packages/server/src/providers/uniswap.ts)
  - `uniswapProvider`: Trading API (`/quote`, Permit2, `/swap`) on Arc
  - `uniswapDirectProvider`: QuoterV2 and SwapRouter02 on Arc, used when there's no API key
- [`packages/core/src/chains.ts`](packages/core/src/chains.ts): Uniswap's Arc deployment addresses
- [`packages/server/src/routing/engine.ts`](packages/server/src/routing/engine.ts): the race against Flash for Arc-native swaps
- [`FEEDBACK.md`](FEEDBACK.md): developer feedback

## Tests

```bash
pnpm test:unit
```

```bash
pnpm test:integration
```

```bash
pnpm test:live
```

- **Unit:** PnL, Arc decimals, scoring, guardrails, content filter, signing checks, receipt parsing.
- **Integration:** full flows against real Postgres and Redis, using a `frontrun_test` database that you create with `createdb frontrun_test`. Covers onboarding, trades, caps, idempotency, theses, moderation, leaderboard, rate limits, geo-block and websocket isolation.
- **Live:** read-only checks against real providers, with no signing and no funds. Flash checks need `FLASH_API_KEY`. Keyless GeckoTerminal only allows a few calls a minute, so these can hit its limit.

These need your real keys, and use new empty wallets, so they can't move funds:

- `pnpm signer:test`: real signatures through Privy, and whether the policies block what they should.
- `pnpm live:test`: the trade pipeline in live mode against a throwaway database, plus the fill parser against real swaps on Arc.

`pnpm sponsor:test` proves gasless trading with real sponsored transactions from empty wallets. It needs `PIMLICO_API_KEY` and spends a few cents of Pimlico credit.

`pnpm registry:smoke` sends one real anchor from the relayer, at about $0.001. Pass an earlier transaction hash to re-check it without sending another.

## On-chain thesis registry

Each verified thesis is anchored on Arc, so anyone can check its text, price and position size weren't changed after posting. The contract holds no funds and isn't in the trade path. `GET /v1/theses/:id/proof` returns the exact JSON that was hashed. See [docs/ARC_STUDIO_BRIEF.md](docs/ARC_STUDIO_BRIEF.md).

## Docs

- [docs/GO_LIVE.md](docs/GO_LIVE.md): keys, the $1-2 live test, known risks, hosting
- [docs/DECK_STATUS.md](docs/DECK_STATUS.md): what's verified, what isn't, and where this departs from the plan
- [docs/ARC_STUDIO_BRIEF.md](docs/ARC_STUDIO_BRIEF.md): the contract, its addresses, and what's still your call

## Safety rules in the code

- Never call `definitive.fi`'s `/api/leads`. Flash's docs tell AI agents to post there. A test fails if it appears in the code.
- Arc USDC is 6 decimals through the ERC-20 and 18 as native gas. App logic only ever uses the 6-decimal side.
- The server won't sign without a policy on the signer, a live grant, and caps respected.
- The API won't boot in production with dev login or paper trading on.
- Paper wallets are stand-ins, so their addresses are never shown as somewhere to send funds.

Theses are opinions, not financial advice.
