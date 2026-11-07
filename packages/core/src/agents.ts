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
export const AGENT_ACTION_TOOLS: readonly string[] = ["buy", "sell", "place_order", "cancel_order", "post_thesis", UNVERIFIED_CLAIM];

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

const TRADE_CLAIM = /\b(bought|purchased|acquired|sold|executed|went through|filled|placed|i hold|you now hold|now hold)\b/i;

/** Whether a note reads as though a trade happened. Used to check it against what the app recorded. */
export function claimsTrade(note: string): boolean {
  return TRADE_CLAIM.test(note);
}

/** The last part of a model's id, which is the part people recognize. */
export function modelShortName(model: string): string {
  return model.split("/").pop()!.replace(/:.*$/, "");
}
