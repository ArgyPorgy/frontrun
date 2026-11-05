# Arc Studio and the thesis registry

**Status: built, deployed to Arc mainnet, and integrated into the app.**

| | |
|---|---|
| Mainnet contract | `0xbce0c97590ff096367d1de13f7b4d492b9700bb5` |
| Deploy transaction | `0xde1a55c08824812f2502ab50325a4c16acd0d2db5ce92eed324225049ee8de61` |
| Owner and relayer | `0xFA8864f4CC3DE8e659EF16ee3FcA726408cb186a` (the gas wallet) |
| Testnet contract | `0x4a98f49375a4a06cd1a832389417268277d58fb0` |
| Arc Studio app | https://studio.arc.io/app/5fa6e028-fb9b-4dda-a30a-727c4568d130 |
| Source | `onchain/contracts/ThesisRegistry.sol` |
| Verified source | [Arc explorer](https://explorer.arc.io/address/0xbce0c97590ff096367d1de13f7b4d492b9700bb5?tab=contract), exact match. Published through Sourcify. |

## Why it exists

The app trades with no custom contract: Flash, Uniswap and LI.FI are all existing deployments. The registry exists for the deck's Arc prize, and it does something real that a judge can check. It holds no funds, needs no approvals, and sits outside the trade path, so a bug in it can't stop anyone trading or touch anyone's money.

Theses are the product's edge, and their "verified at post time" claim used to live only in our database. Now anyone can check that a thesis, its price and its position size weren't changed afterwards.

## How it was built

- **Arc Studio** wrote and tested the contract and deployed it to testnet. It reported 39 passing tests and nothing above informational in a balanced review, and it says that review isn't a substitute for an independent audit.
- **Mainnet was deployed outside Arc Studio**, from this machine, with `pnpm registry:deploy`. Arc Studio doesn't deploy to mainnet, and it asks you to accept a disclaimer before it will edit code that references mainnet. That's yours to accept, so it was never accepted. It's quoted in full below.
- 40 tests pass locally with Foundry. The mainnet bytecode matches testnet, apart from the metadata tail.

## How it works in the app

1. A worker job (`thesis-anchor`) picks up verified theses every 15 seconds, one at a time, in live mode only. Paper positions never reach the chain.
2. It writes the thesis as canonical JSON and hashes it with keccak256. Only the hash and the price and position numbers go on-chain, so a deleted thesis's words don't live there forever.
3. The thesis card shows an "Anchored on Arc" link to the transaction.
4. `GET /v1/theses/:id/proof` returns the exact JSON that was hashed, so anyone can recompute it.

Failures never block posting:

- A network, gas or relayer problem pauses that run and doesn't use up any thesis's retries.
- An anchor that landed but wasn't saved, because the worker died mid-way, is found again from the hash.
- A thesis's own failure gets 5 tries.

The relayer is `ANCHOR_RELAYER_PRIVATE_KEY`, falling back to `GAS_TOPUP_PRIVATE_KEY`. An anchor costs about $0.001 in USDC.

## What was run for real, on mainnet

- `pnpm registry:smoke` sent a test anchor and read it back. The event fields decode to the right decimals, duplicates revert with `AlreadyAnchored`, and other callers revert with `NotRelayer`.
- The running worker anchored a test thesis on its own in about 20 seconds. Its hash was recomputed independently with `cast keccak` and matched what's on-chain.

Both test entries stay on-chain permanently, because the registry is append-only. They're authored by the relayer's own address, and their position numbers aren't real. The test rows were removed from the database afterwards.

Transactions: `0x8c0623ee608c43ca669c688f57dd0879af5fb32e245da76e8936ec19863d454f` and `0x1f3fc07c7cc22d05f467bf96b7036bb651271e9d1a332b52d15f882423b7e815`.

## Open decisions

1. **Separating the keys.** Owner and relayer are the same hot wallet as gas top-ups. Before a public launch, move ownership to a safer wallet with `transferOwnership` and `acceptOwnership`, and give the relayer its own key with `setRelayer`.
2. **An independent audit.** The contract is small and holds no funds, so the risk is low, but no independent review has happened.

## Verifying a future deployment

You approved publishing this contract's source, and only that file went out. A new deployment needs its own verification.

`forge verify-contract --verifier sourcify` fails on Foundry 1.3.5, because it calls Sourcify's removed v1 API. Generate the input with `forge verify-contract --show-standard-json-input`, then send it to `POST https://sourcify.dev/server/v2/verify/5042/{address}` with `compilerVersion`, `contractIdentifier` and `creationTransactionHash`. The Arc explorer picked up the result on its own.

## For the demo

- Show the project inside Arc Studio, then the contract and its verified source on `explorer.arc.io`.
- Post a thesis, then open its anchor transaction from the card.

## Arc Studio's mainnet disclaimer

Shown here because you should read it. It covers the mainnet use above:

> Warning: Transactions on mainnet involve real funds and, once submitted, are irreversible. Arc Studio may generate or edit code or configuration that references mainnet, but Arc Studio does not deploy to, transact on, sign for, fund, or otherwise interact with mainnet on your behalf. Any code used for mainnet must be independently reviewed, tested, validated, deployed, and operated by you outside of Arc Studio. You are solely responsible for any losses, errors, or other consequences resulting from your use of any code, configuration, or output generated or edited through Arc Studio in connection with mainnet. Before proceeding, you should first use testnet, obtain an independent professional audit, and carefully review all wallet addresses, contract addresses, chain settings, permissions, and other configuration details.
