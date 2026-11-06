/**
 * Creates or updates the two Privy policies that limit what the app signer can do, and prints their ids.
 *   pnpm privy:policy
 * If a policy id is already in .env, that policy's rules are replaced, so re-running never duplicates.
 * Put any newly printed ids in PRIVY_POLICY_IDS and PRIVY_SOLANA_POLICY_IDS.
 *
 * Privy denies anything no rule allows, and DENY beats ALLOW. These rules are the enclave-side half
 * of the guardrails. The other half runs on our server before anything gets signed: caps, expiry,
 * and matching each payload against its quote. Both have to hold.
 *
 * `pnpm signer:test` checks these rules against Privy with a wallet that holds no funds.
 */
import { env } from "../src/env";
import { evmRules, solanaRules } from "../src/trading/policy";
import { privy } from "../src/trading/signer";

async function main() {
  const e = env();
  if (!e.PRIVY_SIGNER_ID) throw new Error("Set PRIVY_SIGNER_ID in .env first.");
  if (!e.PRIVY_AUTHORIZATION_KEY) throw new Error("Set PRIVY_AUTHORIZATION_KEY in .env first.");
  const client = privy();
  // Owned by the signer, as Privy recommends, so the app secret alone can't loosen these rules.
  const owner_id = e.PRIVY_SIGNER_ID;
  const authorization_context = { authorization_private_keys: [e.PRIVY_AUTHORIZATION_KEY] };

  if (e.PRIVY_POLICY_IDS) {
    const id = e.PRIVY_POLICY_IDS.split(",")[0]!.trim();
    const updated = await client.policies().update(id, { rules: evmRules(), authorization_context });
    console.log(`Updated EVM policy: ${updated.rules.length} rules.`);
  } else {
    const created = await client.policies().create({ version: "1.0", name: "Front Run app signer (EVM)", chain_type: "ethereum", owner_id, rules: evmRules() });
    console.log(`PRIVY_POLICY_IDS=${created.id}`);
  }

  if (e.PRIVY_SOLANA_POLICY_IDS) {
    const id = e.PRIVY_SOLANA_POLICY_IDS.split(",")[0]!.trim();
    const updated = await client.policies().update(id, { rules: solanaRules(), authorization_context });
    console.log(`Updated Solana policy: ${updated.rules.length} rules.`);
  } else {
    const created = await client.policies().create({ version: "1.0", name: "Front Run app signer (Solana)", chain_type: "solana", owner_id, rules: solanaRules() });
    console.log(`PRIVY_SOLANA_POLICY_IDS=${created.id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
