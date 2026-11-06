import { randomUUID } from "node:crypto";
import {
  AGENTS_BETA,
  AGENT_MAX_DAILY_USD,
  AGENT_MAX_PER_USER,
  AGENT_MAX_TRADE_USD,
  AGENT_MIN_TRADE_USD,
  AGENT_THINK_MINUTES,
  ARC_USDC,
  CHAINS,
  D,
  modelShortName,
  toBaseUnits,
  type AgentDetailView,
  type AgentMessageView,
  type AgentRunView,
  type AgentsView,
  type AgentView,
  type CreateAgentInput,
  type ExecStep,
  type UpdateAgentInput,
} from "@frontrun/core";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { db, schema } from "../db/client";
import { env } from "../env";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { logger } from "../logger";
import { CHANNELS, publish } from "../redis";
import { reputationOf } from "../reputation";
import { agentEvmRules } from "../trading/policy";
import { isPaperMode, signerStatus, usdcBalance } from "../trading/service";
import { loadSigningWallets, performServerStep, privy, serverSigningConfigured, solanaSigningConfigured } from "../trading/signer";
import { listOrders } from "../trading/orders";
import { approveFlash } from "../signerOps";
import { buildPortfolio, ensureDevWallets, follow, toSummary, type UserRow } from "../users";
import { agentModels, modelGatewayConfigured } from "./models";

export type AgentRow = typeof schema.agents.$inferSelect;

const DAY_MS = 86_400_000;
/** An agent's trading authority lasts until it's paused. The owner's limits still apply to every trade. */
const GRANT_DAYS = 3650;

/** Why this account can't create an agent, or null if it can. */
function unavailableReason(user: { username: string; agentOwnerId?: string | null }): string | null {
  if (user.agentOwnerId) return "An agent can't run agents of its own.";
  if (!AGENTS_BETA.includes(user.username.toLowerCase())) return "AI agents are opening soon. They're being tried with small amounts first.";
  if (!modelGatewayConfigured()) return "AI models aren't connected on this server yet.";
  if (!isPaperMode() && !serverSigningConfigured()) return "Server signing isn't set up on this server yet.";
  return null;
}

function checkLimits(perTradeUsd: string, dailyLimitUsd: string) {
  const perTrade = D(perTradeUsd);
  const daily = D(dailyLimitUsd);
  if (perTrade.lt(AGENT_MIN_TRADE_USD) || perTrade.gt(AGENT_MAX_TRADE_USD)) throw badRequest("agent_trade_limit", `The most per trade has to be between $${AGENT_MIN_TRADE_USD} and $${AGENT_MAX_TRADE_USD}.`);
  if (daily.lt(perTrade) || daily.gt(AGENT_MAX_DAILY_USD)) throw badRequest("agent_daily_limit", `The daily limit has to be at least the most per trade, and at most $${AGENT_MAX_DAILY_USD}.`);
}

function checkInterval(minutes: number) {
  if (!(AGENT_THINK_MINUTES as readonly number[]).includes(minutes)) throw badRequest("agent_interval", "Pick one of the offered intervals.");
}

async function checkModel(model: string) {
  const models = await agentModels();
  if (!models.some((m) => m.id === model)) throw badRequest("agent_model", "That model isn't available, or can't call tools.");
}

export async function modelCostToday(agentId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)::float` })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, agentId), gt(schema.agentRuns.createdAt, new Date(Date.now() - DAY_MS))));
  return row?.total ?? 0;
}

async function toView(agent: AgentRow, user: UserRow): Promise<AgentView> {
  const [wallets, balance, signer, cost, reputation] = await Promise.all([
    loadSigningWallets(user.id),
    usdcBalance(user.id).catch(() => ({ usdc: "0" })),
    signerStatus(user.id),
    modelCostToday(agent.id),
    reputationOf(user.id),
  ]);
  return {
    id: agent.id,
    user: toSummary(user),
    wallet: { evm: wallets.evmAddress, solana: wallets.solanaAddress },
    model: agent.model,
    strategy: agent.strategy,
    enabled: agent.enabled,
    perTradeUsd: D(agent.perTradeUsd).toFixed(),
    dailyLimitUsd: D(agent.dailyLimitUsd).toFixed(),
    thinkEveryMinutes: agent.thinkEveryMinutes,
    balanceUsd: D(balance.usdc).toFixed(),
    spentTodayUsd: signer.spentTodayUsd,
    modelCostTodayUsd: cost,
    lastRunAt: agent.lastRunAt?.toISOString() ?? null,
    nextRunAt: agent.enabled ? (agent.nextRunAt?.toISOString() ?? null) : null,
    failures: agent.failures,
    score: reputation?.score ?? null,
  };
}

async function ownedAgent(owner: { id: string }, id: string): Promise<{ agent: AgentRow; user: UserRow }> {
  const [row] = await db()
    .select({ agent: schema.agents, user: schema.users })
    .from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId))
    .where(and(eq(schema.agents.id, id), eq(schema.agents.ownerId, owner.id)));
  if (!row) throw notFound("Agent");
  return row;
}

export async function listAgents(owner: UserRow): Promise<AgentsView> {
  const rows = await db()
    .select({ agent: schema.agents, user: schema.users })
    .from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.userId))
    .where(eq(schema.agents.ownerId, owner.id))
    .orderBy(asc(schema.agents.createdAt));
  const unavailable = unavailableReason(owner);
  return { available: !unavailable, unavailableReason: unavailable, items: await Promise.all(rows.map((r) => toView(r.agent, r.user))) };
}

export async function agentDetail(owner: { id: string }, id: string): Promise<AgentDetailView> {
  const { agent, user } = await ownedAgent(owner, id);
  const [view, portfolio, orders] = await Promise.all([toView(agent, user), buildPortfolio(user.id), listOrders(user.id, { status: "open" })]);
  return { ...view, portfolio, orders };
}

/**
 * An agent gets wallets of its own, which its owner funds with however much they want it to have. Its
 * policy is the app's usual one plus a single way out: USDC back to the owner. That caps what can go wrong
 * at what was sent to it, and keeps its positions and record separate from its owner's on the leaderboard.
 */
async function createAgentWallets(owner: UserRow, user: UserRow) {
  if (isPaperMode()) return ensureDevWallets(user);
  const e = env();
  const ownerWallet = await db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, owner.id), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)) });
  if (!ownerWallet) throw conflict("wallet_not_ready", "Your wallet is still being set up. Try again in a moment.");
  const signer = e.PRIVY_SIGNER_ID!;
  const policy = await privy().policies().create({ version: "1.0", name: `Front Run agent ${user.username}`, chain_type: "ethereum", owner_id: signer, rules: agentEvmRules(ownerWallet.address) });
  const evm = await privy().wallets().create({ chain_type: "ethereum", owner_id: signer, policy_ids: [policy.id] });
  await db().insert(schema.wallets).values({ userId: user.id, chainType: "evm", address: evm.address, isEmbedded: true, privyWalletId: evm.id });
  if (solanaSigningConfigured()) {
    const solana = await privy().wallets().create({ chain_type: "solana", owner_id: signer, policy_ids: [e.PRIVY_SOLANA_POLICY_IDS!.split(",")[0]!.trim()] });
    await db().insert(schema.wallets).values({ userId: user.id, chainType: "solana", address: solana.address, isEmbedded: true, privyWalletId: solana.id });
  }
}

/** Trading runs through the same one-tap path as anyone else, so the same caps hold on the agent's limits. */
async function grantAgent(userId: string, perTradeUsd: string, dailyLimitUsd: string) {
  await db().update(schema.signerGrants).set({ revokedAt: new Date() }).where(and(eq(schema.signerGrants.userId, userId), sql`${schema.signerGrants.revokedAt} is null`));
  const previous = await db().query.signerGrants.findFirst({ where: and(eq(schema.signerGrants.userId, userId), sql`${schema.signerGrants.approvalTx} is not null`), orderBy: desc(schema.signerGrants.grantedAt) });
  await db().insert(schema.signerGrants).values({ userId, perTradeCapUsd: perTradeUsd, dailyCapUsd: dailyLimitUsd, expiresAt: new Date(Date.now() + GRANT_DAYS * DAY_MS), approvalTx: previous?.approvalTx ?? null });
}

/** Safe to call repeatedly. A failed approval is retried before its next trade, rather than failing the setup. */
export async function ensureAgentCanTrade(userId: string) {
  const status = await signerStatus(userId);
  if (status.flashApproved) return;
  await approveFlash(userId);
}

export async function createAgent(owner: UserRow, input: CreateAgentInput): Promise<AgentDetailView> {
  const reason = unavailableReason(owner);
  if (reason) throw conflict("agents_unavailable", reason);
  const [count] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.agents).where(eq(schema.agents.ownerId, owner.id));
  if ((count?.n ?? 0) >= AGENT_MAX_PER_USER) throw conflict("agent_limit", `You can run up to ${AGENT_MAX_PER_USER} agents.`);
  checkLimits(input.perTradeUsd, input.dailyLimitUsd);
  checkInterval(input.thinkEveryMinutes);
  await checkModel(input.model);

  const [user] = await db()
    .insert(schema.users)
    .values({ privyId: `agent:${randomUUID()}`, username: input.name, usernameSet: true, agentOwnerId: owner.id, agentModel: modelShortName(input.model) })
    .onConflictDoNothing()
    .returning();
  if (!user) throw conflict("username_taken", "That name is taken.");

  try {
    await createAgentWallets(owner, user);
    await grantAgent(user.id, input.perTradeUsd, input.dailyLimitUsd);
    const [agent] = await db()
      .insert(schema.agents)
      .values({ userId: user.id, ownerId: owner.id, model: input.model, strategy: input.strategy, perTradeUsd: input.perTradeUsd, dailyLimitUsd: input.dailyLimitUsd, thinkEveryMinutes: input.thinkEveryMinutes, nextRunAt: new Date() })
      .returning();
    await db().insert(schema.auditLog).values({ userId: owner.id, action: "agent_created", detail: { agentId: agent!.id, model: input.model } });
    await follow(owner.id, user.username);
    await ensureAgentCanTrade(user.id).catch((err) => logger.warn({ agentId: agent!.id, err: err instanceof Error ? err.message : err }, "agent approval deferred"));
    return await agentDetail(owner, agent!.id);
  } catch (err) {
    // No half-made account left holding the name.
    await db().delete(schema.users).where(eq(schema.users.id, user.id));
    throw err;
  }
}

export async function updateAgent(owner: { id: string }, id: string, input: UpdateAgentInput): Promise<AgentDetailView> {
  const { agent, user } = await ownedAgent(owner, id);
  const perTradeUsd = input.perTradeUsd ?? agent.perTradeUsd;
  const dailyLimitUsd = input.dailyLimitUsd ?? agent.dailyLimitUsd;
  checkLimits(perTradeUsd, dailyLimitUsd);
  if (input.thinkEveryMinutes !== undefined) checkInterval(input.thinkEveryMinutes);
  if (input.model && input.model !== agent.model) await checkModel(input.model);

  const resumed = input.enabled === true && !agent.enabled;
  await db()
    .update(schema.agents)
    .set({
      ...(input.model ? { model: input.model } : {}),
      ...(input.strategy ? { strategy: input.strategy } : {}),
      ...(input.thinkEveryMinutes ? { thinkEveryMinutes: input.thinkEveryMinutes } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(resumed ? { nextRunAt: new Date(), failures: 0 } : {}),
      perTradeUsd,
      dailyLimitUsd,
      updatedAt: new Date(),
    })
    .where(eq(schema.agents.id, id));
  if (input.model) await db().update(schema.users).set({ agentModel: modelShortName(input.model) }).where(eq(schema.users.id, user.id));
  if (input.perTradeUsd || input.dailyLimitUsd) await grantAgent(user.id, perTradeUsd, dailyLimitUsd);
  await db().insert(schema.auditLog).values({ userId: owner.id, action: "agent_updated", detail: { agentId: id, ...input } });
  return agentDetail(owner, id);
}

export async function listAgentRuns(owner: { id: string }, id: string): Promise<AgentRunView[]> {
  await ownedAgent(owner, id);
  const rows = await db().select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, id)).orderBy(desc(schema.agentRuns.createdAt)).limit(50);
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    summary: r.summary,
    actions: r.actions,
    costUsd: r.costUsd,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

export async function listAgentMessages(owner: { id: string }, id: string): Promise<AgentMessageView[]> {
  await ownedAgent(owner, id);
  const rows = await db().select().from(schema.agentMessages).where(eq(schema.agentMessages.agentId, id)).orderBy(desc(schema.agentMessages.createdAt)).limit(50);
  return rows.reverse().map((m) => ({ id: m.id, role: m.role, body: m.body, pending: m.role === "owner" && !m.handledAt, createdAt: m.createdAt.toISOString() }));
}

/** The worker picks this up, so a slow model can't hold a web request open. */
export async function sendAgentMessage(owner: { id: string }, id: string, body: string): Promise<AgentMessageView[]> {
  await ownedAgent(owner, id);
  if (!modelGatewayConfigured()) throw conflict("agents_unavailable", "AI models aren't connected on this server yet.");
  await db().insert(schema.agentMessages).values({ agentId: id, role: "owner", body });
  return listAgentMessages(owner, id);
}

export async function runAgentNow(owner: { id: string }, id: string): Promise<AgentDetailView> {
  const { agent } = await ownedAgent(owner, id);
  if (!agent.enabled) throw conflict("agent_paused", "Resume it first.");
  if (agent.lastRunAt && Date.now() - agent.lastRunAt.getTime() < 60_000) throw new AppError(429, "agent_just_ran", "It only just finished thinking. Give it a minute.");
  await db().update(schema.agents).set({ nextRunAt: new Date() }).where(eq(schema.agents.id, id));
  return agentDetail(owner, id);
}

export async function withdrawFromAgent(owner: { id: string }, id: string, amountUsd: string): Promise<AgentDetailView> {
  const { user } = await ownedAgent(owner, id);
  const amount = D(amountUsd);
  const { usdc } = await usdcBalance(user.id);
  if (amount.lte(0) || amount.gt(usdc)) throw conflict("insufficient_balance", "The agent doesn't have that much.");

  if (isPaperMode()) {
    await db().transaction(async (tx) => {
      await tx.update(schema.users).set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} - ${amount.toFixed()}` }).where(eq(schema.users.id, user.id));
      await tx.update(schema.users).set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${amount.toFixed()}` }).where(eq(schema.users.id, owner.id));
    });
  } else {
    const ownerWallet = await db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, owner.id), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)) });
    if (!ownerWallet) throw conflict("wallet_not_ready", "Your wallet is still being set up. Try again in a moment.");
    const step: ExecStep = {
      id: "agent-withdraw",
      kind: "evm_tx",
      chain: "arc",
      label: "Send USDC to the agent's owner",
      to: ARC_USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ownerWallet.address as Hex, toBaseUnits(amount.toFixed(), CHAINS.arc.usdcDecimals)] }),
      waitForReceipt: true,
    };
    const result = await performServerStep(await loadSigningWallets(user.id), step, { userId: user.id, tradeId: "agent-withdraw" });
    await db().insert(schema.auditLog).values({ userId: owner.id, action: "agent_withdrawn", detail: { agentId: id, amountUsd: amount.toFixed(), txHash: result.txHash } });
  }
  await publish(CHANNELS.user(owner.id), { type: "balance", usdc: "0" });
  return agentDetail(owner, id);
}

/** Paper money only. Real funding is an ordinary USDC send from the owner's wallet to the agent's. */
export async function fundAgentPaper(owner: UserRow, id: string, amountUsd: string): Promise<AgentDetailView> {
  if (!isPaperMode()) throw conflict("not_paper", "Send USDC to the agent's wallet instead.");
  const { user } = await ownedAgent(owner, id);
  const amount = D(amountUsd);
  const [debited] = await db()
    .update(schema.users)
    .set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} - ${amount.toFixed()}` })
    .where(and(eq(schema.users.id, owner.id), sql`${schema.users.paperBalanceUsd} >= ${amount.toFixed()}`))
    .returning({ id: schema.users.id });
  if (!debited) throw conflict("insufficient_balance", "You don't have that much.");
  await db().update(schema.users).set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${amount.toFixed()}` }).where(eq(schema.users.id, user.id));
  return agentDetail(owner, id);
}
