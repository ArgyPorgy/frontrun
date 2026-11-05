import { CHAINS, createReplySchema, createThesisSchema, isValidAddress, listThesesSchema, reportSchema, type ThesisProof } from "@frontrun/core";
import {
  AppError,
  createReply,
  createThesis,
  db,
  deleteReply,
  deleteThesis,
  env,
  findByUsername,
  getThesis,
  likeThesis,
  listReplies,
  listTheses,
  notFound,
  report,
  schema,
  unlikeThesis,
} from "@frontrun/server";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { optionalUser, requireUser } from "../auth";

const idParam = z.object({ id: z.string().uuid() });

export async function registerThesisRoutes(app: FastifyInstance) {
  app.get("/v1/theses", async (req) => {
    const viewer = await optionalUser(req);
    return listTheses(listThesesSchema.parse(req.query), viewer?.id ?? null);
  });

  app.post("/v1/theses", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const body = createThesisSchema.parse(req.body);
    if (!isValidAddress(body.chain, body.address)) throw new AppError(400, "invalid_address", "That isn't a valid token address.");
    return createThesis(user, body);
  });

  app.get("/v1/theses/:id", async (req) => {
    const viewer = await optionalUser(req);
    const { id } = idParam.parse(req.params);
    return getThesis(id, viewer?.id ?? null);
  });

  /** The exact text that was hashed on Arc, so anyone can recompute the hash themselves. */
  app.get("/v1/theses/:id/proof", async (req): Promise<ThesisProof> => {
    const { id } = idParam.parse(req.params);
    const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, id) });
    if (!thesis || thesis.deletedAt || thesis.hiddenAt) throw notFound("Thesis");
    return {
      registry: env().THESIS_REGISTRY_ADDRESS ?? null,
      chainId: CHAINS.arc.chainId!,
      payload: thesis.anchorPayload,
      hash: thesis.anchorHash,
      txHash: thesis.anchorTx,
      anchoredAt: thesis.anchoredAt?.toISOString() ?? null,
    };
  });

  app.delete("/v1/theses/:id", async (req, reply) => {
    const user = await requireUser(req);
    const { id } = idParam.parse(req.params);
    await deleteThesis(user.id, id);
    reply.status(204).send();
  });

  app.post("/v1/theses/:id/like", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req);
    const { id } = idParam.parse(req.params);
    await likeThesis(user, id);
    reply.status(204).send();
  });

  app.delete("/v1/theses/:id/like", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req);
    const { id } = idParam.parse(req.params);
    await unlikeThesis(user.id, id);
    reply.status(204).send();
  });

  app.get("/v1/theses/:id/replies", async (req) => {
    const viewer = await optionalUser(req);
    const { id } = idParam.parse(req.params);
    return { items: await listReplies(id, viewer?.id ?? null) };
  });

  app.post("/v1/theses/:id/replies", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const { id } = idParam.parse(req.params);
    const { body } = createReplySchema.parse(req.body);
    return createReply(user, id, body);
  });

  app.delete("/v1/theses/:id/replies/:replyId", async (req, reply) => {
    const user = await requireUser(req);
    const { id, replyId } = z.object({ id: z.string().uuid(), replyId: z.string().uuid() }).parse(req.params);
    await deleteReply(user.id, id, replyId);
    reply.status(204).send();
  });

  app.post("/v1/reports", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req);
    const body = reportSchema.parse(req.body);
    let targetUserId: string | undefined;
    if (body.username) {
      const target = await findByUsername(body.username);
      if (!target) throw notFound("User");
      targetUserId = target.id;
    }
    await report(user.id, { thesisId: body.thesisId, targetUserId, reason: body.reason, note: body.note });
    reply.status(204).send();
  });
}
