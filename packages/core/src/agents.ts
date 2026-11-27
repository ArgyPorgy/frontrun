import type { PerpPositionView } from "./perps";
import type { OrderView, PortfolioView, UserSummary } from "./types";

/** Who can create an agent while it's being tried out with small amounts. Lowercase usernames. */
export const AGENTS_BETA: readonly string[] = ["argyporgy", "sayan"];
export const AGENT_MAX_PER_USER = 3;
export const AGENT_MIN_TRADE_USD = "1";
export const AGENT_MAX_TRADE_USD = "100";
export const AGENT_MAX_DAILY_USD = "1000";
export const AGENT_DEFAULT_TRADE_USD = "10";
export const AGENT_DEFAULT_DAILY_USD = "50";
/** How often an agent can be set to think. Each round bills its model, so this sets what it costs to run. */
export const AGENT_THINK_MINUTES = [15, 30, 60, 240, 1440] as const;
export const AGENT_DEFAULT_THINK_MINUTES = 60;
/** What one agent's model can bill in a day before it stops thinking until tomorrow. */
export const AGENT_DAILY_MODEL_USD = 2;

export interface AgentModelView {
  id: string;
  name: string;
  provider: string;
  /** Weights are published, so anyone can run or check it. */
  openSource: boolean;
  /** Dollars per million tokens. */
  promptPrice: number;
  completionPrice: number;
  free: boolean;
  recommended: boolean;
}

export interface AgentView {
  id: string;
  user: UserSummary;
  wallet: { evm: string; solana: string | null };
  model: string;
  strategy: string;
  enabled: boolean;
  perTradeUsd: string;
  dailyLimitUsd: string;
  thinkEveryMinutes: number;
  balanceUsd: string;
  spentTodayUsd: string;
  modelCostTodayUsd: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  failures: number;
  score: number | null;
}

export interface AgentDetailView extends AgentView {
  portfolio: PortfolioView;
  orders: OrderView[];
  perps: PerpPositionView[];
}

export interface AgentsView {
  /** Whether this account can create agents. */
  available: boolean;
  /** Why not, in words for the person reading it. */
  unavailableReason: string | null;
  items: AgentView[];
}

/** What the app itself recorded the agent doing. A model can say anything, so this is what to believe. */
export interface AgentAction {
  tool: string;
  summary: string;
  ok: boolean;
  acted: boolean;
}

/** Marks a note that claims a trade the app has no record of. */
export const UNVERIFIED_CLAIM = "unverified_claim";
/** The tools that change something, which are the ones an owner needs to see the result of. */
export const AGENT_ACTION_TOOLS: readonly string[] = ["buy", "sell", "place_order", "cancel_order", "post_thesis", "open_perp", "close_perp", "set_perp_tpsl", "lend", "redeem_lending", UNVERIFIED_CLAIM];

/** The most leverage an agent may take, whatever the market allows. Stocks on Veranta stop at 5x anyway. */
export const AGENT_PERP_MAX_LEVERAGE = 10;

/** Starting points for an agent's strategy. The owner can edit any of it. */
export const AGENT_STRATEGY_PRESETS: ReadonlyArray<{ id: string; label: string; strategy: string }> = [
  {
    id: "perp_trend",
    label: "Perps: trend and momentum",
    strategy:
      "Trade perps on Veranta, mostly tokenized-stock markets like NVDA, TSLA, AAPL and COIN, plus BTC and ETH. Use perp_analysis on the 1h chart and follow its default signal: only enter when it says long or short, never when it says none. Use its suggested stop-loss and take-profit. Use 3x leverage on stocks and 5x on crypto, never more. Hold at most two perps at once. Skip a market if X posts about it are clearly against the trade. Close a position early if the 1h signal flips against it. Explain every entry in one or two sentences.",
  },
  {
    id: "perp_mean_reversion",
    label: "Perps: fade the extremes",
    strategy:
      "Trade perps on Veranta. Look for markets where RSI on the 15m or 1h chart is below 25 or above 75 and price is outside the Bollinger bands, while ADX is under 25, so there's no strong trend. Take the other side with 2x to 3x leverage, a stop-loss 1.5 ATR away and a take-profit at the middle band. Skip it if funding shows the crowd is on your side. One position at a time.",
  },
  {
    id: "spot_momentum",
    label: "Spot: momentum tokens",
    strategy:
      "Buy tokens on Base with rising volume, at least $250k of liquidity and no risk flags. Take profit around +40% and cut losers at -15%. Most rounds, do nothing.",
  },
];

export interface AgentRunView {
  id: string;
  trigger: "schedule" | "chat";
  summary: string | null;
  actions: AgentAction[];
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentMessageView {
  id: string;
  role: "owner" | "agent";
  body: string;
  pending: boolean;
  /** What actually happened while it was writing this. */
  actions: AgentAction[];
  createdAt: string;
}

const TRADE_CLAIM = /\b(bought|purchased|acquired|sold|executed|went through|filled|placed|i hold|you now hold|now hold|opened|went long|went short|closed (?:the|my|a|it|half))\b/i;

/** Whether a note reads as though a trade happened. Used to check it against what the app recorded. */
export function claimsTrade(note: string): boolean {
  return TRADE_CLAIM.test(note);
}

/** The last part of a model's id, which is the part people recognize. */
export function modelShortName(model: string): string {
  return model.split("/").pop()!.replace(/:.*$/, "");
}
