import { agentMessageSchema, agentMoneySchema, createAgentSchema, updateAgentSchema } from "@frontrun/core";
import {
  agentDetail,
  agentModels,
  createAgent,
  fundAgentPaper,
  listAgentMessages,
  listAgentRuns,
  listAgents,
  runAgentNow,
  sendAgentMessage,
  updateAgent,
  withdrawFromAgent,
} from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth";

const idParam = z.object({ id: z.string().uuid() });

export async function registerAgentRoutes(app: FastifyInstance) {
  app.get("/v1/agents", async (req) => listAgents(await requireUser(req)));

  // Static route first, so it's never swallowed by the "/:id" parametric route below. Nothing private in it.
  app.get("/v1/agents/models", async () => ({ items: await agentModels() }));

  app.post("/v1/agents", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req) => {
    const user = await requireUser(req);
    return createAgent(user, createAgentSchema.parse(req.body));
  });

  app.get("/v1/agents/:id", async (req) => {
    const user = await requireUser(req);
    return agentDetail(user, idParam.parse(req.params).id);
  });

  app.patch("/v1/agents/:id", async (req) => {
    const user = await requireUser(req);
    return updateAgent(user, idParam.parse(req.params).id, updateAgentSchema.parse(req.body));
  });

  app.get("/v1/agents/:id/runs", async (req) => {
    const user = await requireUser(req);
    return { items: await listAgentRuns(user, idParam.parse(req.params).id) };
  });

  app.get("/v1/agents/:id/messages", async (req) => {
    const user = await requireUser(req);
    return { items: await listAgentMessages(user, idParam.parse(req.params).id) };
  });

  app.post("/v1/agents/:id/messages", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const { body } = agentMessageSchema.parse(req.body);
    return { items: await sendAgentMessage(user, idParam.parse(req.params).id, body) };
  });

  app.post("/v1/agents/:id/run", async (req) => {
    const user = await requireUser(req);
    return runAgentNow(user, idParam.parse(req.params).id);
  });

  app.post("/v1/agents/:id/withdraw", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const { amountUsd } = agentMoneySchema.parse(req.body);
    return withdrawFromAgent(user, idParam.parse(req.params).id, amountUsd);
  });

  app.post("/v1/agents/:id/paper-fund", async (req) => {
    const user = await requireUser(req);
    const { amountUsd } = agentMoneySchema.parse(req.body);
    return fundAgentPaper(user, idParam.parse(req.params).id, amountUsd);
  });
}
