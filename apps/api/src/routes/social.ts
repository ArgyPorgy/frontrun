import { LEADERBOARD_MIN_RESOLVED } from "@frontrun/core";
import {
  block,
  buildProfile,
  findByUsername,
  follow,
  leaderboard,
  listNotifications,
  markAllRead,
  notFound,
  notify,
  publicPositions,
  searchUsers,
  unblock,
  unfollow,
} from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { optionalUser, requireUser } from "../auth";

const usernameParam = z.object({ username: z.string().min(1).max(32) });

export async function registerSocialRoutes(app: FastifyInstance) {
  // Static route first, so it's never swallowed by the "/:username" parametric route below.
  app.get("/v1/users/search", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { q } = z.object({ q: z.string().min(1).max(32) }).parse(req.query);
    return { items: await searchUsers(q) };
  });

  app.get("/v1/users/:username", async (req) => {
    const viewer = await optionalUser(req);
    const { username } = usernameParam.parse(req.params);
    return buildProfile(username, viewer?.id ?? null);
  });

  app.get("/v1/users/:username/positions", async (req) => {
    const { username } = usernameParam.parse(req.params);
    const user = await findByUsername(username);
    if (!user || user.isBanned) throw notFound("User");
    return publicPositions(user.id);
  });

  app.post("/v1/users/:username/follow", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(req);
    const { username } = usernameParam.parse(req.params);
    const { target, created } = await follow(user.id, username);
    if (created) {
      await notify(target.id, { type: "followed", actorId: user.id, message: `${user.username} followed you` });
    }
    reply.status(204).send();
  });

  app.delete("/v1/users/:username/follow", async (req, reply) => {
    const user = await requireUser(req);
    await unfollow(user.id, usernameParam.parse(req.params).username);
    reply.status(204).send();
  });

  app.post("/v1/users/:username/block", async (req, reply) => {
    const user = await requireUser(req);
    await block(user.id, usernameParam.parse(req.params).username);
    reply.status(204).send();
  });

  app.delete("/v1/users/:username/block", async (req, reply) => {
    const user = await requireUser(req);
    await unblock(user.id, usernameParam.parse(req.params).username);
    reply.status(204).send();
  });

  app.get("/v1/leaderboard", async () => ({ items: await leaderboard(), minResolved: LEADERBOARD_MIN_RESOLVED }));

  app.get("/v1/notifications", async (req) => {
    const user = await requireUser(req);
    return listNotifications(user.id);
  });

  app.post("/v1/notifications/read", async (req, reply) => {
    const user = await requireUser(req);
    await markAllRead(user.id);
    reply.status(204).send();
  });
}
