import { FRONTRUN_BUILDER_CODE } from "@frontrun/core";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db/client";
import { fetchJson } from "./http";
import { logger } from "./logger";

/** Base hands out one code per agent wallet, and the same wallet always gets the same code. */
const AGENT_CODES_API = "https://api.base.dev/v1/agents/builder-codes";

/** Gets an agent's own Builder Code from Base and saves it. Returns null if Base can't be reached right now. */
export async function registerAgentBuilderCode(agentId: string, walletAddress: string): Promise<string | null> {
  try {
    const res = await fetchJson<{ builderCode?: string }>(AGENT_CODES_API, { method: "POST", body: { walletAddress }, timeoutMs: 10_000, retries: 1 });
    if (!res.builderCode || !/^bc_[a-z0-9]+$/i.test(res.builderCode)) throw new Error("Base returned no builder code.");
    await db().update(schema.agents).set({ builderCode: res.builderCode }).where(eq(schema.agents.id, agentId));
    return res.builderCode;
  } catch (err) {
    logger.warn({ agentId, err: err instanceof Error ? err.message : err }, "couldn't register an agent builder code");
    return null;
  }
}

/**
 * The codes to put on a transaction from this account. Always Front Run's, and an AI agent's own code next to
 * it, so Base can credit both the app and the agent that made the trade.
 */
export async function builderCodesFor(userId: string): Promise<string[]> {
  const agent = await db().query.agents.findFirst({ where: eq(schema.agents.userId, userId) });
  if (!agent) return [FRONTRUN_BUILDER_CODE];
  let code = agent.builderCode;
  if (!code) {
    const wallet = await db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, userId), eq(schema.wallets.chainType, "evm")) });
    code = wallet ? await registerAgentBuilderCode(agent.id, wallet.address) : null;
  }
  return code ? [FRONTRUN_BUILDER_CODE, code] : [FRONTRUN_BUILDER_CODE];
}

/** Worker: fills in codes for agents made before codes existed, or while Base was unreachable. */
export async function backfillAgentBuilderCodes(limit = 10): Promise<number> {
  const rows = await db()
    .select({ id: schema.agents.id, address: schema.wallets.address })
    .from(schema.agents)
    .innerJoin(schema.wallets, and(eq(schema.wallets.userId, schema.agents.userId), eq(schema.wallets.chainType, "evm")))
    .where(isNull(schema.agents.builderCode))
    .limit(limit);
  for (const row of rows) await registerAgentBuilderCode(row.id, row.address);
  return rows.length;
}
