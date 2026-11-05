import { ARC_USDC, FLASH_ALLOWANCE_ARC, PERMIT2, type ExecStep } from "@frontrun/core";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "./db/client";
import { conflict } from "./errors";
import { arcUsdcBalance, encodeApprove, erc20Allowance } from "./onchain";
import { activeGrant, isPaperMode, signerStatus } from "./trading/service";
import { loadSigningWallets, performServerStep, serverSigningConfigured } from "./trading/signer";
import { sponsorshipConfigured } from "./trading/sponsor";

const MAX_UINT256 = 2n ** 256n - 1n;
const OPS_CONTEXT = "account-setup";

/**
 * The one approval one-tap trading needs: max USDC to Flash. It's also the wallet's first footprint
 * on Arc. Gas comes out of the same USDC balance, so the wallet must be funded first.
 */
export async function approveFlash(userId: string) {
  const grant = await activeGrant(userId);
  if (!grant || grant.expiresAt.getTime() < Date.now()) throw conflict("no_grant", "Turn on one-tap trading first.");

  if (isPaperMode()) {
    await db().update(schema.signerGrants).set({ approvalTx: "paper" }).where(eq(schema.signerGrants.id, grant.id));
    return signerStatus(userId);
  }
  if (!serverSigningConfigured()) throw conflict("signer_unavailable", "One-tap trading isn't available on this server.");
  const wallets = await loadSigningWallets(userId);
  const allowance = await erc20Allowance("arc", ARC_USDC, wallets.evmAddress, FLASH_ALLOWANCE_ARC);
  if (allowance > 0n) return signerStatus(userId);

  if (!sponsorshipConfigured("arc")) {
    const balance = await arcUsdcBalance(wallets.evmAddress);
    if (balance === 0n) throw conflict("needs_deposit", "Add a little USDC first. Gas on Arc is paid in USDC.");
  }

  const step: ExecStep = {
    id: "approve",
    kind: "evm_tx",
    chain: "arc",
    label: "Approve USDC for trading",
    to: ARC_USDC,
    data: encodeApprove(FLASH_ALLOWANCE_ARC, MAX_UINT256),
    waitForReceipt: true,
  };
  const result = await performServerStep(wallets, step, { userId, tradeId: OPS_CONTEXT });
  await db().update(schema.signerGrants).set({ approvalTx: result.txHash ?? null }).where(eq(schema.signerGrants.id, grant.id));
  await db().insert(schema.auditLog).values({ userId, action: "flash_approved", detail: { txHash: result.txHash } });
  return signerStatus(userId);
}

/**
 * Resets allowances to zero. With a live signer the backend sends these. Without one, the steps go
 * back to the wallet, because revoking must keep working after the user has removed our signer.
 */
export async function revokeApprovals(userId: string): Promise<{ txHash: string | null; steps: ExecStep[] }> {
  if (isPaperMode()) {
    await db().update(schema.signerGrants).set({ approvalTx: null }).where(and(eq(schema.signerGrants.userId, userId), isNull(schema.signerGrants.revokedAt)));
    return { txHash: "paper", steps: [] };
  }
  const wallets = await loadSigningWallets(userId);
  const steps: ExecStep[] = [];
  for (const spender of [FLASH_ALLOWANCE_ARC, PERMIT2]) {
    const allowance = await erc20Allowance("arc", ARC_USDC, wallets.evmAddress, spender);
    if (allowance > 0n) {
      steps.push({
        id: `revoke-${spender.slice(0, 8)}`,
        kind: "evm_tx",
        chain: "arc",
        label: "Revoke approval",
        to: ARC_USDC,
        data: encodeApprove(spender, 0n),
        waitForReceipt: true,
      });
    }
  }
  if (!steps.length) return { txHash: null, steps: [] };
  const grant = await activeGrant(userId);
  const canSign = !!grant && grant.expiresAt.getTime() > Date.now() && serverSigningConfigured();
  if (!canSign) return { txHash: null, steps };

  let txHash: string | null = null;
  for (const step of steps) {
    const result = await performServerStep(wallets, step, { userId, tradeId: OPS_CONTEXT });
    txHash = result.txHash ?? txHash;
  }
  await db().update(schema.signerGrants).set({ approvalTx: null }).where(eq(schema.signerGrants.id, grant.id));
  await db().insert(schema.auditLog).values({ userId, action: "approvals_revoked", detail: { txHash } });
  return { txHash, steps: [] };
}
