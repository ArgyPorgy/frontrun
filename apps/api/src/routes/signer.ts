import { signerCapsSchema, signerGrantSchema } from "@frontrun/core";
import { approveFlash, grantSigner, revokeApprovals, revokeSigner, signerStatus, updateCaps } from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth";

export async function registerSignerRoutes(app: FastifyInstance) {
  app.get("/v1/signer", async (req) => {
    const user = await requireUser(req);
    return signerStatus(user.id);
  });

  /** Called after the wallet has added our signer. Verified against Privy, not taken on trust. */
  app.post("/v1/signer/grant", async (req) => {
    const user = await requireUser(req);
    await grantSigner(user, signerGrantSchema.parse(req.body));
    return signerStatus(user.id);
  });

  app.post("/v1/signer/approve", async (req) => {
    const user = await requireUser(req);
    return approveFlash(user.id);
  });

  app.patch("/v1/signer/caps", async (req) => {
    const user = await requireUser(req);
    await updateCaps(user.id, signerCapsSchema.parse(req.body));
    return signerStatus(user.id);
  });

  app.delete("/v1/signer", async (req) => {
    const user = await requireUser(req);
    await revokeSigner(user.id);
    return signerStatus(user.id);
  });

  app.post("/v1/signer/revoke-approvals", async (req) => {
    const user = await requireUser(req);
    return revokeApprovals(user.id);
  });
}
