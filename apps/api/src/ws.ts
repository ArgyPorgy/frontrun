import { isChainKey, isValidAddress, tokenKey, type ChainKey, type PriceTick, type ServerEvent, type ThesisView } from "@frontrun/core";
import { CHANNELS, KEYS, db, env, getPrices, logger, markActive, newSubscriber, redis, schema } from "@frontrun/server";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import { userFromToken } from "./auth";

const MAX_TOKEN_SUBS = 60;

function tokenRoom(chain: ChainKey, address: string) {
  return `token:${tokenKey(chain, address)}`;
}

/**
 * Fans Redis out to browsers. Clients only ever subscribe here and never talk to a market provider,
 * so one poller serves any number of viewers.
 */
export async function attachWebsocket(app: FastifyInstance): Promise<() => Promise<void>> {
  const io = new Server(app.server, {
    cors: { origin: env().APP_ORIGIN.split(",").map((o) => o.trim()) },
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });
  const subscriber = newSubscriber();

  // Auth runs as middleware so it's finished before "connection" fires. Listeners then attach
  // synchronously, and a client that subscribes the moment it connects doesn't lose the event.
  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : null;
    const user = token ? await userFromToken(token).catch(() => null) : null;
    socket.data.userId = user?.id ?? null;
    socket.data.wallets = user
      ? (
          await db()
            .select({ address: schema.wallets.address })
            .from(schema.wallets)
            .where(and(eq(schema.wallets.userId, user.id), eq(schema.wallets.chainType, "evm")))
        ).map((w) => w.address)
      : [];
    next();
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string | null;
    const onlineWallets = socket.data.wallets as string[];
    socket.join("feed");
    if (userId) socket.join(`user:${userId}`);

    const markOnline = async () => {
      if (userId && onlineWallets.length) {
        await redis().zadd(KEYS.onlineWallets, ...onlineWallets.flatMap((a) => [Date.now(), `${userId}:${a}`]));
      }
    };
    void markOnline();

    const subs = new Set<string>();

    socket.on("sub", async (msg: { chain?: string; address?: string }) => {
      if (!msg?.chain || !msg.address || !isChainKey(msg.chain) || !isValidAddress(msg.chain, msg.address)) return;
      if (subs.size >= MAX_TOKEN_SUBS) return;
      const room = tokenRoom(msg.chain, msg.address);
      subs.add(room);
      socket.join(room);
      await markActive(msg.chain, msg.address);
      // Send the last price right away so the UI doesn't wait for the next tick.
      const key = tokenKey(msg.chain, msg.address);
      const price = (await getPrices([key])).get(key);
      if (price) socket.emit("price", { chain: msg.chain, address: msg.address, priceUsd: price });
    });

    socket.on("unsub", (msg: { chain?: string; address?: string }) => {
      if (!msg?.chain || !msg.address || !isChainKey(msg.chain) || !isValidAddress(msg.chain, msg.address)) return;
      const room = tokenRoom(msg.chain, msg.address);
      subs.delete(room);
      socket.leave(room);
    });

    // Keeps watched tokens in the poller's active set for as long as someone is looking.
    socket.on("heartbeat", async () => {
      await Promise.all(
        [...subs].map((room) => {
          const [chain, address] = room.slice("token:".length).split(":") as [ChainKey, string];
          return markActive(chain, address);
        }),
      );
      await markOnline();
    });
  });

  subscriber.on("message", (channel, raw) => {
    try {
      if (channel === CHANNELS.ticks) {
        const ticks = JSON.parse(raw) as PriceTick[];
        for (const tick of ticks) io.to(tokenRoom(tick.chain, tick.address)).emit("tick", tick);
      } else if (channel === CHANNELS.theses) {
        const event = JSON.parse(raw) as { thesis: ThesisView };
        io.to("feed").emit("thesis", event.thesis);
      } else if (channel === CHANNELS.stats) {
        io.to("feed").emit("stats");
      }
    } catch (err) {
      logger.warn({ err }, "bad pubsub message");
    }
  });

  subscriber.on("pmessage", (_pattern, channel, raw) => {
    try {
      const userId = channel.slice("chan:user:".length);
      const event = JSON.parse(raw) as ServerEvent;
      io.to(`user:${userId}`).emit(event.type, event);
    } catch (err) {
      logger.warn({ err }, "bad user pubsub message");
    }
  });

  await subscriber.subscribe(CHANNELS.ticks, CHANNELS.theses, CHANNELS.stats);
  await subscriber.psubscribe(CHANNELS.userPattern);

  return async () => {
    await subscriber.quit();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
}
