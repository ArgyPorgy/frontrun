/**
 * Creates Front Run's own Morpho markets on Base: borrow USDC against tokenized stocks that have no listed
 * Morpho market yet. Prints each market's oracle and id for STOCK_MARKETS in packages/core/src/lending.ts.
 *   pnpm lending:markets            (a dry run that only checks and prints)
 *   pnpm lending:markets --send     (deploys from the gas wallet)
 *
 * Each market gets its own oracle from Morpho's official MorphoChainlinkOracleV2 factory, reading the
 * Chainlink "Coinbase <TICKER>" feed, the same setup as Morpho's listed stock markets. Markets use Morpho's
 * AdaptiveCurveIRM and a 62.5% liquidation LTV, as the listed ones do. Morpho markets can't be changed or
 * deleted after they're made, and nobody owns them, so this skips any market that already exists.
 * Every transaction carries Front Run's Builder Code. Costs a few cents of ETH at most.
 */
import { BASE_USDC, MORPHO_BASE, STOCK_MARKETS, builderCodeSuffix, stockToken } from "@frontrun/core";
import { createWalletClient, encodeAbiParameters, formatEther, http, keccak256, parseAbi, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { env } from "../src/env";
import { evmClient } from "../src/onchain";
import { normalizePrivateKey } from "../src/trading/signer";

/** Stocks without a listed Morpho market, so Front Run makes one. */
const TICKERS = ["TSLA", "AMZN", "MSFT"];
const LLTV = 625_000_000_000_000_000n;

const FACTORY_ABI = parseAbi([
  "function createMorphoChainlinkOracleV2(address baseVault, uint256 baseVaultConversionSample, address baseFeed1, address baseFeed2, uint256 baseTokenDecimals, address quoteVault, uint256 quoteVaultConversionSample, address quoteFeed1, address quoteFeed2, uint256 quoteTokenDecimals, bytes32 salt) returns (address oracle)",
  "function isMorphoChainlinkOracleV2(address) view returns (bool)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)", "function BASE_FEED_1() view returns (address)"]);
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function description() view returns (string)"]);
const MORPHO_ABI = parseAbi([
  "function createMarket((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function isIrmEnabled(address) view returns (bool)",
  "function isLltvEnabled(uint256) view returns (bool)",
]);

function marketId(p: { loanToken: Hex; collateralToken: Hex; oracle: Hex; irm: Hex; lltv: bigint }): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
}

async function main() {
  const send = process.argv.includes("--send");
  const e = env();
  if (!e.GAS_TOPUP_PRIVATE_KEY) throw new Error("GAS_TOPUP_PRIVATE_KEY is needed to pay for the markets.");
  const account = privateKeyToAccount(normalizePrivateKey(e.GAS_TOPUP_PRIVATE_KEY));
  const client = evmClient("base");
  if ((await client.getChainId()) !== base.id) throw new Error("The RPC isn't Base mainnet.");
  const morpho = MORPHO_BASE.blue as Hex;
  const factory = MORPHO_BASE.chainlinkOracleFactory as Hex;
  const irm = MORPHO_BASE.adaptiveCurveIrm as Hex;
  const [irmOk, lltvOk] = await Promise.all([
    client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "isIrmEnabled", args: [irm] }),
    client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "isLltvEnabled", args: [LLTV] }),
  ]);
  if (!irmOk || !lltvOk) throw new Error("Morpho doesn't allow this IRM or LLTV.");
  const balance = await client.getBalance({ address: account.address });
  console.log(`Gas wallet ${account.address}, ${formatEther(balance)} ETH. ${send ? "Sending." : "Dry run."}`);
  const wallet = createWalletClient({ account, chain: base, transport: http(e.BASE_RPC_URL, { timeout: 60_000 }) });

  for (const ticker of TICKERS) {
    const token = stockToken(ticker)!;
    if (STOCK_MARKETS.some((m) => m.ticker === ticker)) {
      console.log(`${ticker}: already in STOCK_MARKETS, skipped`);
      continue;
    }
    const [description, round] = await Promise.all([
      client.readContract({ address: token.feed as Hex, abi: FEED_ABI, functionName: "description" }),
      client.readContract({ address: token.feed as Hex, abi: FEED_ABI, functionName: "latestRoundData" }),
    ]);
    if (description !== `Coinbase ${ticker}`) throw new Error(`${ticker}: the feed says "${description}"`);
    const feedPrice = Number(round[1]) / 1e8;
    console.log(`${ticker}: feed "${description}" at $${feedPrice}, updated ${new Date(Number(round[3]) * 1000).toISOString()}`);

    const salt = keccak256(new TextEncoder().encode(`frontrun:${token.symbol}:usdc`));
    const args = [zeroAddress, 1n, token.feed as Hex, zeroAddress, 8n, zeroAddress, 1n, zeroAddress, zeroAddress, 6n, salt] as const;
    const sim = await client.simulateContract({ account, address: factory, abi: FACTORY_ABI, functionName: "createMorphoChainlinkOracleV2", args }).catch(() => null);
    let oracle = sim?.result as Hex | undefined;
    if (!oracle) throw new Error(`${ticker}: the oracle factory refused the call (maybe it already exists with this salt).`);
    const params = { loanToken: BASE_USDC as Hex, collateralToken: token.address as Hex, oracle, irm, lltv: LLTV };
    const id = marketId(params);
    console.log(`${ticker}: oracle ${oracle}, market ${id}`);
    if (!send) continue;

    const oracleCode = await client.getCode({ address: oracle });
    if (!oracleCode || oracleCode === "0x") {
      const hash = await wallet.writeContract({ address: factory, abi: FACTORY_ABI, functionName: "createMorphoChainlinkOracleV2", args, dataSuffix: builderCodeSuffix() });
      const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`${ticker}: oracle deployment reverted (${hash})`);
      console.log(`${ticker}: oracle deployed in ${hash}`);
    }
    const [genuine, feed, price] = await Promise.all([
      client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isMorphoChainlinkOracleV2", args: [oracle] }),
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "BASE_FEED_1" }),
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "price" }),
    ]);
    // One whole share (1e8 units) priced in USDC units, scaled by 1e36, divided back out: should match the feed.
    const oraclePrice = Number((price * 100_000_000n) / 10n ** 36n) / 1e6;
    if (!genuine || feed.toLowerCase() !== token.feed.toLowerCase() || Math.abs(oraclePrice - feedPrice) / feedPrice > 0.001)
      throw new Error(`${ticker}: the oracle doesn't check out (price ${oraclePrice} vs feed ${feedPrice}).`);

    const existing = await client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [id] });
    if (existing[4] === 0n) {
      const hash = await wallet.writeContract({ address: morpho, abi: MORPHO_ABI, functionName: "createMarket", args: [params], dataSuffix: builderCodeSuffix() });
      const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`${ticker}: createMarket reverted (${hash})`);
      console.log(`${ticker}: market created in ${hash}`);
    }
    const stored = await client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
    if (stored[2].toLowerCase() !== oracle.toLowerCase()) throw new Error(`${ticker}: Morpho doesn't show the market.`);
    console.log(`  { id: "${id}", ticker: "${ticker}", oracle: "${oracle}", lltv: "${LLTV}", ours: true },`);
    oracle = undefined;
  }
  const after = await client.getBalance({ address: account.address });
  console.log(`Gas used: ${formatEther(balance - after)} ETH`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
