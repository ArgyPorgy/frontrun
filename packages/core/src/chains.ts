export type ChainKey =
  | "arc"
  | "robinhood"
  | "base"
  | "arbitrum"
  | "ethereum"
  | "bsc"
  | "hyperevm"
  | "solana";

export type ChainType = "evm" | "solana";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  shortName: string;
  type: ChainType;
  /** EVM chain id, or null on Solana. */
  chainId: number | null;
  /** LI.FI's numeric id (differs from chainId on Solana). */
  lifiId: number;
  /** Slug in the Flash API. */
  flashSlug: string;
  /** Network slug in GeckoTerminal. */
  geckoSlug: string;
  /** Chain slug in DexScreener. */
  dexSlug: string;
  explorer: string;
  explorerTxPath: string;
  explorerTokenPath: string;
  nativeSymbol: string;
  /** Canonical USDC on this chain. */
  usdc: string | null;
  usdcDecimals: number;
  /** Privy app-pays gas sponsorship covers this chain (per Privy's network list). */
  privySponsored: boolean;
  /** Small native amount the server can top up when sponsorship is unavailable, in wei. */
  gasTopupWei: string | null;
  defaultRpc: string;
  accent: string;
}

/** Arc USDC: same balance, two interfaces. Native gas side is 18 decimals, ERC-20 side is 6. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** DefinitiveFlashAllowance on Arc: the spender in the one-tap approval. */
export const FLASH_ALLOWANCE_ARC = "0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78";
export const EVM_NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** Uniswap deployments on Arc, from Uniswap's own deployment tables and sdk-core. */
export const UNISWAP_ARC = {
  universalRouter212: "0x8702463e73f74d0b6765aBceb314Ef07aCb92650",
  v3Factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
  v3QuoterV2: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
  v3SwapRouter02: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
  v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
} as const;

export const CHAINS: Record<ChainKey, ChainInfo> = {
  arc: {
    key: "arc",
    name: "Arc",
    shortName: "ARC",
    type: "evm",
    chainId: 5042,
    lifiId: 5042,
    flashSlug: "arc",
    geckoSlug: "arc",
    dexSlug: "arc",
    explorer: "https://explorer.arc.io",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "USDC",
    usdc: ARC_USDC,
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: null,
    defaultRpc: "https://rpc.mainnet.arc.io",
    accent: "#5B8DEF",
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    shortName: "HOOD",
    type: "evm",
    chainId: 4663,
    lifiId: 4663,
    flashSlug: "robinhood",
    geckoSlug: "robinhood",
    dexSlug: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "ETH",
    usdc: null,
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: "60000000000000",
    defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
    accent: "#C4F24A",
  },
  base: {
    key: "base",
    name: "Base",
    shortName: "BASE",
    type: "evm",
    chainId: 8453,
    lifiId: 8453,
    flashSlug: "base",
    geckoSlug: "base",
    dexSlug: "base",
    explorer: "https://basescan.org",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "ETH",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA91CD6",
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: "20000000000000",
    defaultRpc: "https://mainnet.base.org",
    accent: "#3B7BFF",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum",
    shortName: "ARB",
    type: "evm",
    chainId: 42161,
    lifiId: 42161,
    flashSlug: "arbitrum",
    geckoSlug: "arbitrum",
    dexSlug: "arbitrum",
    explorer: "https://arbiscan.io",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "ETH",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: "20000000000000",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    accent: "#3AA6E8",
  },
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    shortName: "ETH",
    type: "evm",
    chainId: 1,
    lifiId: 1,
    flashSlug: "ethereum",
    geckoSlug: "eth",
    dexSlug: "ethereum",
    explorer: "https://etherscan.io",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "ETH",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: "400000000000000",
    defaultRpc: "https://ethereum-rpc.publicnode.com",
    accent: "#8A92B2",
  },
  bsc: {
    key: "bsc",
    name: "BNB Chain",
    shortName: "BNB",
    type: "evm",
    chainId: 56,
    lifiId: 56,
    flashSlug: "bsc",
    geckoSlug: "bsc",
    dexSlug: "bsc",
    explorer: "https://bscscan.com",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "BNB",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdcDecimals: 18,
    privySponsored: false,
    gasTopupWei: "60000000000000",
    defaultRpc: "https://bsc-dataseed.bnbchain.org",
    accent: "#F0B90B",
  },
  hyperevm: {
    key: "hyperevm",
    name: "HyperEVM",
    shortName: "HYPE",
    type: "evm",
    chainId: 999,
    lifiId: 999,
    flashSlug: "hyperevm",
    geckoSlug: "hyperevm",
    dexSlug: "hyperevm",
    explorer: "https://hyperevmscan.io",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "HYPE",
    usdc: null,
    usdcDecimals: 6,
    privySponsored: false,
    gasTopupWei: "2000000000000000",
    defaultRpc: "https://rpc.hyperliquid.xyz/evm",
    accent: "#50E3C2",
  },
  solana: {
    key: "solana",
    name: "Solana",
    shortName: "SOL",
    type: "solana",
    chainId: null,
    lifiId: 1151111081099710,
    flashSlug: "solana",
    geckoSlug: "solana",
    dexSlug: "solana",
    explorer: "https://solscan.io",
    explorerTxPath: "/tx/",
    explorerTokenPath: "/token/",
    nativeSymbol: "SOL",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdcDecimals: 6,
    privySponsored: true,
    gasTopupWei: null,
    defaultRpc: "https://api.mainnet-beta.solana.com",
    accent: "#9B6DFF",
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

export function isChainKey(value: string): value is ChainKey {
  return value in CHAINS;
}

export function chainByDexSlug(slug: string): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.dexSlug === slug);
}

export function chainByGeckoSlug(slug: string): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.geckoSlug === slug);
}

export function chainByFlashSlug(slug: string): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.flashSlug === slug);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidAddress(chain: ChainKey, address: string): boolean {
  return CHAINS[chain].type === "evm" ? EVM_ADDRESS.test(address) : SOLANA_ADDRESS.test(address);
}

/** EVM addresses are case-insensitive so we key them lowercase; Solana addresses are case-sensitive. */
export function normalizeAddress(chain: ChainKey, address: string): string {
  return CHAINS[chain].type === "evm" ? address.toLowerCase() : address;
}

export function tokenKey(chain: ChainKey, address: string): string {
  return `${chain}:${normalizeAddress(chain, address)}`;
}

export function explorerTxUrl(chain: ChainKey, hash: string): string {
  const c = CHAINS[chain];
  return `${c.explorer}${c.explorerTxPath}${hash}`;
}

export function explorerTokenUrl(chain: ChainKey, address: string): string {
  const c = CHAINS[chain];
  return `${c.explorer}${c.explorerTokenPath}${address}`;
}
