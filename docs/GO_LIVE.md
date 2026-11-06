# Going from paper to live

The app runs today with no keys: real market data, real routes, simulated fills, stand-in login. This is what it takes to move real money, in order.

## 1. Add keys in stages

Paste keys into `.env`, not into a chat, then test them. The checker is read-only and never prints a value. Run these commands from the project folder, since they don't work from anywhere else:

```bash
pnpm keys:check
```

Restart the API and workers after changing `.env`. A file watcher doesn't count: it only reloads `.env` when code changes.

**Stage 1: data and quotes.** None of these can move money. Paper trades start using real Flash and Uniswap routes as soon as they're in.

| What | Where | Goes in | Without it |
|---|---|---|---|
| CoinGecko Demo key (free) | coingecko.com/en/api/pricing | `COINGECKO_API_KEY` | About 5 data calls a minute, so charts and lists lag badly. Demo allows 100. For a paid key, also set `COINGECKO_PLAN=pro`. |
| Flash integrator key | app.definitive.fi > More > Flash | `FLASH_API_KEY` | No Flash routes, so LI.FI only cross-chain |
| Uniswap API key | developers.uniswap.org/dashboard | `UNISWAP_API_KEY` | Direct v3 route only, which is single-hop USDC pairs |

**Stage 2: real Google login.** Fills stay simulated, so this still can't move money. It creates real wallets for whoever signs in.

| What | Where | Goes in |
|---|---|---|
| Privy app id and secret | dashboard.privy.io | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |

In the Privy dashboard, turn on Google, email and wallet login, and add `http://localhost:3000` to the allowed domains. Then set `AUTH_MODE=privy`.

**Stage 3: one-tap signing.** The server can now sign for users within limits, so treat these as sensitive.

| What | Where | Goes in |
|---|---|---|
| Authorization key and signer id | Dashboard > Wallet infrastructure > Authorization keys | `PRIVY_AUTHORIZATION_KEY`, `PRIVY_SIGNER_ID` |
| Signer policies | `pnpm privy:policy`, then paste the two ids it prints | `PRIVY_POLICY_IDS`, `PRIVY_SOLANA_POLICY_IDS` |

**One-tap stays off until the EVM policy id is set**, on purpose: this server won't hold a signer without a policy. Also turn on gas sponsorship (app pays) for Robinhood Chain, Base and Solana in the dashboard.

Already handled: `.env` has VAPID keys for push, so only put a real contact in `VAPID_SUBJECT` before launch.

Optional: `GAS_TOPUP_PRIVATE_KEY`, a funded wallet for first sells on BSC, Ethereum, Arbitrum and HyperEVM, which Privy can't sponsor. `ARC_RPC_URL`, an Alchemy or QuickNode endpoint for production load.

## 2. Check the signer works, still with no funds at risk

These all use new empty wallets and can't move funds. All three pass today.

```bash
pnpm keys:check
```

```bash
pnpm signer:test
```

```bash
pnpm live:test
```

- `signer:test` signs real Flash and Uniswap payloads through Privy and confirms the policies block drains, unknown contracts, arbitrary messages and hidden Solana transfers. It also sends a real signed order to Flash, which refuses it only because the wallet is empty.
- `live:test` runs the real trade pipeline in live mode against a throwaway database. It checks the fill parser against real swaps by other people on Arc, using their actual balance changes, and dry-runs a real $5 buy against real pools.

Neither one proves a fill lands in your own wallet. Only step 4 does that.

### Turn on gasless trading

1. Create a Pimlico account at https://dashboard.pimlico.io, turn on billing for mainnet sponsorship, and make an API key.
2. Add it to `.env` as `PIMLICO_API_KEY`, then restart the API and workers.
3. Prove it, which spends a few cents of Pimlico credit and no user funds:

```bash
pnpm sponsor:test
```

It sends real sponsored transactions from empty wallets on Arc and Base, and confirms Flash accepts an upgraded wallet's signature.

### Fees

Every trade carries a 0.5% fee, set by `FLASH_INTEGRATOR_FEE_BPS`. Flash pays its share into the Flash Portfolio of your Definitive account, where you withdraw it from app.definitive.fi. Uniswap sends it to `FEE_RECIPIENT_ADDRESS`, in whichever token the trade pays out. LI.FI can't collect until you add a fee wallet at portal.li.fi and set `LIFI_FEE=0.005`, so until then it only runs when nothing else can do the trade.

Flash also charges its own fee on limit and stop orders that rest on it, on top of yours: 0.10% through 2026 and 0.20% after. The deck flags trade fees for legal review.

### The trackers

The TG tracker reads Telegram's public web preview, and needs no key. The X tracker needs `TWITTERAPI_IO_KEY` from twitterapi.io, which bills $0.15 per 1,000 posts read, with a minimum of $0.00015 a request, and free accounts are limited to one request every 5 seconds. At one request a minute that's about $6.50 a month before posts are counted. TwitterAPI.io is a third party that isn't affiliated with X, so it could break, or conflict with X's rules, without notice. If that happens, the X tab stops updating and the rest of the app carries on. The lists of who's tracked are at the top of `packages/server/src/trackers.ts`.

### The database

The app's data lives in Neon, a hosted Postgres. `DATABASE_URL` has to be Neon's **direct** connection, with no `-pooler` in the hostname: the API and workers take a Postgres advisory lock when they migrate on boot, and a pooler can drop that lock between statements. Set `sslmode=verify-full` so the driver checks the certificate and stays quiet about it.

To move to another Postgres later, stop the API and workers, then copy the data across:

```bash
pg_dump --no-owner --no-acl "$OLD_DATABASE_URL" | psql "$NEW_DATABASE_URL"
```

## 3. Switch to live

**Already done on this machine.** `TRADING_MODE=live`, and `DATABASE_URL` points at a fresh `frontrun_live`, so paper data can never show as real. The old paper data is still in `frontrun_dev`.

For a real deployment, also set:

```
NODE_ENV=production
APP_ORIGIN=https://your-domain
NEXT_PUBLIC_API_URL=https://api.your-domain
NEXT_PUBLIC_APP_URL=https://your-domain
```

The API refuses to boot in production with dev login, paper trading, missing keys or a non-https origin.

## 4. The $1-2 live test (do this first, and do it yourself)

The deck asks for this, and it's the biggest open risk. Signing, policies and the Uniswap calldata are proven without funds. One real one-tap buy has filled, $3 from Arc to Base. No same-chain buy or any sell has yet. Use small amounts:

1. Sign in with Google. Confirm both wallets appear in Settings.
2. Send $5 of USDC on Arc to your address. Confirm the deposit toast and balance.
3. Enable one-tap. Confirm the approval on `explorer.arc.io`: this is the wallet's first Arc transaction.
4. **Arc same-chain:** buy $1 of an Arc token. Check the receipt, position and PnL.
5. **Post a thesis on it.** Within about 20 seconds its card should show "Anchored on Arc".
6. **Cross-chain:** buy $1 of a Base token. Note the real fill time for the deck's open question.
7. **Sell it back from Base.** This is the first-sell approval on another chain, and the deck's "zero-ETH Flash sell" unknown.
8. **Solana:** buy and sell $1. This one is the most likely to need work, see below.
9. Set the per-trade cap to $1 and buy $2. It must ask for a wallet confirm, not go through silently.
10. In Settings, remove the signer and revoke approvals. Confirm the allowance is 0 on the explorer.
11. Watch `GET /internal/metrics` with the `x-admin-token` header for quote latency and fill rate.

## 5. Known risks to watch in that test

- **Solana sells.** Flash's docs say sponsored delegation is "off for new accounts", and token account rent (about 0.002 SOL each) is never sponsored. The app tries Privy sponsorship, but rent may still need real SOL in the wallet. This conflicts with the "users only hold USDC" rule and may need a small SOL top-up.
- **Slippage.** So one-tap orders execute instead of reverting, the app allows 20% on cross-chain and 5% on Arc, set in `GUARDRAILS` in `packages/core/src/routing.ts`. Flash suggests 15% on cross-chain, and FOMO reportedly defaults to 40%. A wide limit can cost more: a $100 cross-chain buy could fill up to $20 under its quote.
- **Orders expiring.** One real $2.50 Arc to Base order closed with `REASON_ORDER_EXPIRED` after 37 seconds, with no funds moved, while the next one filled in 39 seconds. It's order `30494f56-85eb-44e4-8559-fbc750c097be`, and it's worth asking Definitive why. Wider limits may help, but that isn't proven.
- **"Bought" shows early.** Once an order is accepted, the toast says "Bought" about 3 seconds before the expected fill. If the order then fails, the toast and receipt correct it. Users can briefly see "Bought" on a trade that fails.
- **Gasless is only as good as its funding.** Once `PIMLICO_API_KEY` is set, Pimlico pays gas on Arc, Robinhood Chain, Base, Arbitrum, Ethereum and BNB Chain from your credit, and users never see it. Run out of credit and trades stop with "briefly unavailable". Set a spending limit in Pimlico's dashboard and put its id in `PIMLICO_SPONSORSHIP_POLICY_ID`.
- **Not gasless yet.** HyperEVM first sells still use the gas wallet's top-up, because Pimlico lists no EIP-7702 support there. Solana sells still need SOL for token accounts and setup. Withdrawals from Arc pay a few cents of USDC, since the wallet sends them and the signer policy rightly can't.
- **Very small buys.** Arc handled $0.01 when probed. Cross-chain routes have fixed costs, so on Base buys under about $1 and on Solana buys under about $5 lost more than 5%. Under $10 that asks you to confirm, showing the percentage lost, and below that some amounts have no route at all. The first Flash trade also sends the one-time USDC approval, if enabling one-tap couldn't.
- **Adding the signer from the browser.** `addSigners` only runs for a signed-in person, so it has never been run. If one-tap fails to turn on, look here first.
- **Uniswap often misses the race.** On Arc it answered in 1.3 to 4 seconds against Flash's 0.5 to 1.3, so it makes the 1.5s window about 3 times in 8. The price difference measured was about a cent on $25. Widen `QUOTE_RACE_TIMEOUT_MS` if you'd rather wait for it.

## 6. Before a public launch

- Use a paid Arc RPC in `ARC_RPC_URL`. The public one starts refusing at a few requests a second, which the app will hit with real users.
- Set `NEXT_PUBLIC_SOLANA_RPC_URL` to a key locked to your domain. The default is Solana's public endpoint, which is rate limited. Never reuse the server's private `SOLANA_RPC_URL` for it.
- Move the registry's owner and relayer off the gas wallet. See `ARC_STUDIO_BRIEF.md`.
- Move `PRIVY_AUTHORIZATION_KEY` into a KMS or HSM. The deck requires it, and it's an environment variable for now.
- Have a lawyer review the Terms, Privacy Policy and Risk Disclosure. They're marked as drafts in the app. The deck also flags trade fees for legal review (India FIU, US money transmission).
- Promote `Content-Security-Policy-Report-Only` in `apps/web/next.config.ts` to enforcing, once reports stay clean through a live Privy login.
- Read DexScreener's terms. The deck flags that they may bar competing products. If so, replace the price feed with a paid source.
- Add an error tracker. Logs are structured, but there's no Sentry yet because it needs your DSN.

## 7. Hosting, per the deck

| Piece | Host | Notes |
|---|---|---|
| `apps/web` | Vercel | Set the `NEXT_PUBLIC_*` values at build time. |
| `apps/api` | Fly.io or Railway | `docker build --build-arg APP=api .` It needs websockets, so not serverless. |
| `apps/workers` | Fly.io or Railway | `docker build --build-arg APP=workers .` Safe to run more than one: jobs take a Redis lease. |
| Postgres | Neon or Supabase | The API and workers migrate on boot. |
| Redis | Upstash | Must support pub/sub. |

The Dockerfile hasn't been run, because the Docker daemon was off on this machine. The bundles it builds were booted directly and work.
