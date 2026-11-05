import { createSecretKey } from "node:crypto";
import { AppError, ensureDevWallets, ensureUser, env, privy, syncWalletsFromPrivy, type UserRow } from "@frontrun/server";
import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";

const devKey = () => {
  const secret = env().DEV_JWT_SECRET;
  if (!secret) throw new Error("DEV_JWT_SECRET is required with AUTH_MODE=dev");
  return createSecretKey(Buffer.from(secret));
};

export async function issueDevToken(subject: string): Promise<string> {
  if (env().AUTH_MODE !== "dev") throw new AppError(404, "not_found", "Not found.");
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(subject).setIssuedAt().setExpirationTime("7d").sign(devKey());
}

/** Verifies a bearer token and returns the identity behind it, or null if it isn't valid. */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    if (env().AUTH_MODE === "dev") {
      const { payload } = await jwtVerify(token, devKey(), { algorithms: ["HS256"] });
      return payload.sub ?? null;
    }
    const claims = await privy().utils().auth().verifyAccessToken(token);
    return claims.user_id;
  } catch {
    return null;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export async function userFromToken(token: string): Promise<UserRow | null> {
  const identity = await verifyToken(token);
  if (!identity) return null;
  const user = await ensureUser(identity);
  if (user.isBanned) return null;
  return user;
}

export async function optionalUser(req: FastifyRequest): Promise<UserRow | null> {
  const token = bearer(req);
  return token ? userFromToken(token) : null;
}

export async function requireUser(req: FastifyRequest): Promise<UserRow> {
  const user = await optionalUser(req);
  if (!user) throw new AppError(401, "unauthorized", "Sign in to continue.");
  return user;
}

export async function ensureWallets(user: UserRow) {
  if (env().AUTH_MODE === "dev") await ensureDevWallets(user);
  else await syncWalletsFromPrivy(user);
}
