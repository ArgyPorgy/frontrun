/**
 * Rewrites each AI agent wallet's Privy policy with the current agent rules, so existing agents get the same
 * rules as new ones. Today that means sending USDC back to their owner on Base, the new home chain.
 *   pnpm agents:policies
 */
import { and, eq } from "drizzle-orm";
import { closeDb, db, schema } from "../src/db/client";
import { env } from "../src/env";
import { agentEvmRules } from "../src/trading/policy";
import { privy } from "../src/trading/signer";

async function main() {
  const e = env();
  if (!e.PRIVY_AUTHORIZATION_KEY) throw new Error("PRIVY_AUTHORIZATION_KEY is needed to change policies.");
  const authorization_context = { authorization_private_keys: [e.PRIVY_AUTHORIZATION_KEY] };
  const agents = await db().select().from(schema.agents);
  for (const agent of agents) {
    const [wallet, owner] = await Promise.all([
      db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, agent.userId), eq(schema.wallets.chainType, "evm")) }),
      db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, agent.ownerId), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)) }),
    ]);
    if (!wallet?.privyWalletId || !owner) {
      console.log(`${agent.id}: no signable wallet or owner wallet, skipped`);
      continue;
    }
    const privyWallet = await privy().wallets().get(wallet.privyWalletId);
    const policyId = privyWallet.policy_ids?.[0];
    if (!policyId) {
      console.log(`${wallet.address}: no policy attached, skipped`);
      continue;
    }
    const updated = await privy().policies().update(policyId, { rules: agentEvmRules(owner.address), authorization_context });
    console.log(`${wallet.address}: policy updated, ${updated.rules.length} rules`);
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
