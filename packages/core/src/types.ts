import type { ChainKey } from "./chains";
import type { RiskFlag } from "./risk";
import type { GuardrailIssue, ProviderId, TradeStatus } from "./routing";
import type { ThesisOutcome } from "./thesis";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface WindowStats<T> {
  m5: T;
  h1: T;
  h6: T;
  h24: T;
}

export interface TokenRef {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
}

export interface TokenSnapshot extends TokenRef {
  priceUsd: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  liquidityUsd: string | null;
  volumeUsd: WindowStats<number>;
  txns: WindowStats<{ buys: number; sells: number }>;
  priceChangePct: WindowStats<number>;
  pairAddress: string | null;
  dexId: string | null;
  pairCreatedAt: number | null;
  updatedAt: number;
}

export interface TokenListItem extends TokenSnapshot {
  /** DexScreener boosts are paid placement, and we say so in the UI. */
  boosted: boolean;
  thesisCount: number;
}

export interface HolderStats {
  count: number | null;
  top10Pct: number | null;
  source: "geckoterminal" | "flash" | null;
}

export interface TokenDetail extends TokenSnapshot {
  decimals: number | null;
  holders: HolderStats;
  /** Distinct wallets over 24h in the top pool. Null when the source hasn't answered yet. */
  makers: { buyers24h: number; sellers24h: number } | null;
  risk: RiskFlag[];
  riskFlagged: boolean;
  isHoneypot: boolean | null;
  thesisCount: number;
  tradable: boolean;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TapeTrade {
  id: string;
  time: number;
  side: "buy" | "sell";
  usd: number;
  priceUsd: number;
  qty: number;
  maker: string;
  txHash: string;
}

export interface PriceTick {
  chain: ChainKey;
  address: string;
  priceUsd: string;
  priceChange24h: number;
  liquidityUsd: string | null;
  marketCapUsd: string | null;
  volume24hUsd: number;
  at: number;
}

export interface UserSummary {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface WalletView {
  chainType: "evm" | "solana";
  address: string;
  isEmbedded: boolean;
}

export interface SignerStatus {
  active: boolean;
  grantedAt: string | null;
  expiresAt: string | null;
  perTradeCapUsd: string;
  dailyCapUsd: string;
  spentTodayUsd: string;
  flashApproved: boolean;
  approvalTx: string | null;
}

export type OnboardingStep = "profile" | "deposit" | "enable_one_tap" | "done";

export interface MeView extends UserSummary {
  createdAt: string;
  wallets: WalletView[];
  onboarding: OnboardingStep;
  signer: SignerStatus;
  followers: number;
  following: number;
  /** Set in paper mode only. */
  paperBalanceUsd: string | null;
}

export interface BalanceView {
  usdc: string;
  /** What a trade can use. */
  spendable: string;
  /** What can be sent out, which still pays its own gas. */
  withdrawable: string;
  mode: "live" | "paper";
}

export interface ThesisView {
  id: string;
  author: UserSummary;
  token: TokenRef;
  body: string;
  priceAtPost: string;
  ts: string;
  positionUsdAtPost: string;
  authorAvgEntry: string | null;
  verified: boolean;
  likeCount: number;
  replyCount: number;
  likedByMe: boolean;
  outcome: ThesisOutcome;
  returnPct: number | null;
  currentPriceUsd: string | null;
  /** Set once this thesis has been anchored on Arc. */
  anchor: { hash: string; txHash: string; anchoredAt: string } | null;
}

export interface ThesisProof {
  registry: string | null;
  chainId: number;
  payload: string | null;
  hash: string | null;
  txHash: string | null;
  anchoredAt: string | null;
}

export interface ReplyView {
  id: string;
  thesisId: string;
  author: UserSummary;
  body: string;
  createdAt: string;
}

export interface PositionView {
  id: string;
  token: TokenRef;
  qty: string;
  costBasisUsd: string;
  avgEntryUsd: string;
  realizedPnlUsd: string;
  openedAt: string;
  closedAt: string | null;
  priceUsd: string | null;
  marketCapUsd: string | null;
  valueUsd: string | null;
  unrealizedPnlUsd: string | null;
  returnPct: number | null;
}

export interface PortfolioView {
  totals: {
    valueUsd: string;
    realizedUsd: string;
    unrealizedUsd: string;
    allTimeUsd: string;
  };
  cash: BalanceView;
  open: PositionView[];
  closed: PositionView[];
  winRate: number | null;
}

export interface ProfileView extends UserSummary {
  createdAt: string;
  followers: number;
  following: number;
  isFollowing: boolean;
  isBlocked: boolean;
  isMe: boolean;
  stats: {
    allTimePnlUsd: string;
    realizedUsd: string;
    winRate: number | null;
    theses: number;
    resolved: number;
    right: number;
    accuracy: number | null;
  };
}

export interface LeaderboardRow {
  rank: number;
  user: UserSummary;
  accuracy: number;
  resolved: number;
  right: number;
  avgReturnPct: number;
  realizedPnlUsd: string;
}

export interface NotificationView {
  id: string;
  type: "thesis_posted" | "thesis_liked" | "thesis_replied" | "followed" | "trade_update" | "deposit" | "copy_buy";
  actor: UserSummary | null;
  thesisId: string | null;
  tradeId: string | null;
  token: TokenRef | null;
  message: string;
  createdAt: string;
  read: boolean;
}

export interface QuoteView {
  id: string;
  side: "buy" | "sell";
  token: TokenRef;
  amountInUsd: string;
  expectedQty: string;
  qtyIn: string | null;
  expectedOutUsd: string;
  priceUsd: string;
  feeUsd: string;
  gasUsd: string;
  etaSeconds: number;
  priceImpact: number | null;
  slippage: number;
  warnings: GuardrailIssue[];
  /** Guardrail or cap issues that take this trade off one-tap and onto a visible confirm. */
  confirmReasons: GuardrailIssue[];
  blocked: GuardrailIssue[];
  /** Whether the backend can sign this without any prompt. */
  oneTap: boolean;
  expiresAt: number;
  route: {
    provider: ProviderId;
    crossChain: boolean;
    alternatives: Array<{ provider: ProviderId; netOutputUsd: string | null; error: string | null; latencyMs: number }>;
    sponsoredSetup: boolean;
    needsSetup: boolean;
  };
  copy: { thesisId: string; authorEntry: string | null; capUsd: string } | null;
}

/** One signing action. The same steps run on the server (one-tap) or in the wallet (visible confirm). */
export type ExecStep =
  | { id: string; kind: "evm_tx"; chain: ChainKey; label: string; to: string; data: string; value?: string; sponsor?: boolean; waitForReceipt: boolean }
  | { id: string; kind: "evm_typed_data"; chain: ChainKey; label: string; typedData: string }
  | { id: string; kind: "svm_message"; chain: "solana"; label: string; message: string }
  | { id: string; kind: "svm_tx"; chain: "solana"; label: string; transactionBase64: string; broadcast: boolean; sponsor?: boolean };

export interface StepResult {
  id: string;
  signature?: string;
  txHash?: string;
  signedTransaction?: string;
}

export interface TradeView {
  id: string;
  side: "buy" | "sell";
  token: TokenRef;
  status: TradeStatus;
  usdIn: string | null;
  usdOut: string | null;
  qty: string | null;
  priceUsd: string | null;
  feeUsd: string | null;
  pnlUsd: string | null;
  closedPosition: boolean;
  provider: ProviderId;
  srcChain: ChainKey;
  srcTx: string | null;
  dstTx: string | null;
  isPaper: boolean;
  error: string | null;
  createdAt: string;
  filledAt: string | null;
  /** Present while the wallet must sign something. */
  pendingSteps: ExecStep[] | null;
}

export interface PublicConfig {
  appName: string;
  tradingMode: "live" | "paper";
  authMode: "privy" | "dev";
  privyAppId: string | null;
  signerId: string | null;
  /** Whether trades run with the gas paid for the user. */
  gasless: boolean;
  policyIds: string[];
  solanaPolicyIds: string[];
  vapidPublicKey: string | null;
  integratorFeeBps: number;
  providers: Record<ProviderId, boolean>;
  caps: { perTradeUsd: string; dailyUsd: string; grantDays: number };
  copyBuyCapUsd: string;
  flashSpender: string;
  bridgeUrlTemplate: string;
}

export type ServerEvent =
  | { type: "tick"; ticks: PriceTick[] }
  | { type: "trade"; trade: TradeView }
  | { type: "balance"; usdc: string }
  | { type: "notification"; notification: NotificationView }
  | { type: "thesis"; thesis: ThesisView };

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
