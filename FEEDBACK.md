# Uniswap developer feedback

**Draft.** Everything below came up while building against Uniswap's docs, SDK source, Arc mainnet and live Trading API quotes and swap calldata. No swap has been sent from our own wallet yet, so add notes here from your live test before submitting.

## What worked well

- **The Trading API served Arc on the first try.** A `/quote` for Arc USDC to WETH returned an AMM route in about a second, and it edged out Flash on a $25 trade.
- **The supported-chains page is clear and current.** It lists Arc (5042) with its Universal Router 2.1.2 address and its UniswapX status, which settled a question our earlier research had open.
- **The Quoter is simple to use directly.** `quoteExactInputSingle` on Arc returned a sane price over plain `eth_call`, at a median of about 450ms across fee tiers. That made a keyless fallback easy to build.
- **`llms.txt` and per-page Markdown are useful.** They made the docs easy to work through accurately.

## Friction

- **v3 addresses on Arc are hard to find.** The v4 deployments page has a full Arc table, but the v3 deployments page has no Arc section. We took the QuoterV2, SwapRouter02 and factory addresses from `sdk-core` source (`sdks/sdk-core/src/addresses.ts`). A table in the docs would help, especially since Arc's v3 addresses differ from the canonical ones.
- **Buys on Arc pay USDC as native value, which nothing in the docs says.** Arc's USDC is also its native token, so a buy comes back with `isTokenApprovalApplicable: false`, `permitData: null`, and a swap whose `value` is the amount at 18 decimals, such as `0x0de0b6b3a7640000` for $1. Sells work the other way, with a Permit2 approval and permit. We only found this by reading a live response, and our first version would have asked for a needless max approval. A note on Arc in the swap docs would save the next team the same trip.
- **Native sends break the usual way of reading a receipt.** Each ERC-20 USDC move logs twice, at 6 and 18 decimals, from different emitters. A native send logs only from Arc's system emitter. A parser that watches the USDC contract, which is the usual approach, would record $0 spent on every buy and get all PnL wrong. Reading the system emitter sees each move exactly once. We checked this against 9 real router swaps on mainnet, comparing to each wallet's actual balance change, and it matched to the cent with gas excluded.
- **`permitData` leaves out the `EIP712Domain` type.** Privy's signer expects it spelled out, so we add it ourselves before signing.
- **Latency.** On Arc the Trading API took 1.3 to 4 seconds across 8 samples, and timed out at 4 seconds once, against about 450ms for the Quoter. In a race against other venues it often misses a short window, even when it has the better price.

## To fill in after the live test

- [x] `/quote` returns `CLASSIC` for Arc pairs
- [ ] Which of v3 and v4 do those routes use in practice?
- [ ] Is the `x-universal-router-version: 2.1.2` header needed on Arc?
- [x] Permit2 signature from a Privy embedded wallet on Arc (signed and verified through Privy, not yet sent on-chain)
- [x] A buy's calldata against live pools (dry run with a pretend balance succeeds)
- [ ] A real buy and sell from our own wallet
- [ ] `gasFeeUSD` accuracy when gas is paid in USDC
