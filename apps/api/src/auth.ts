import { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

export type MarketDeskRole = "admin" | "analyst" | "viewer";

const roleRank: Record<MarketDeskRole, number> = {
  viewer: 1,
  analyst: 2,
  admin: 3
};

export function requireRole(allowedRoles: MarketDeskRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isApiAuthRequired()) {
      return;
    }

    const role = roleFromRequest(request);
    if (!role) {
      reply.status(401).send({ error: "Missing or invalid API token." });
      return;
    }

    const requiredRank = Math.min(...allowedRoles.map((allowedRole) => roleRank[allowedRole]));
    if (roleRank[role] < requiredRank) {
      reply.status(403).send({ error: "Insufficient role for this operation.", role });
    }
  };
}

export function roleFromRequest(request: FastifyRequest): MarketDeskRole | null {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) {
    return null;
  }

  if (safeEqual(token, process.env.ADMIN_API_TOKEN)) {
    return "admin";
  }
  if (safeEqual(token, process.env.ANALYST_API_TOKEN)) {
    return "analyst";
  }
  if (safeEqual(token, process.env.VIEWER_API_TOKEN)) {
    return "viewer";
  }
  return null;
}

export function isApiAuthRequired(): boolean {
  if (process.env.API_AUTH_REQUIRED === "false") {
    return false;
  }
  if (process.env.API_AUTH_REQUIRED === "true") {
    return true;
  }
  return (
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.ADMIN_API_TOKEN || process.env.ANALYST_API_TOKEN || process.env.VIEWER_API_TOKEN)
  );
}

function safeEqual(candidate: string, expected?: string): boolean {
  if (!expected || candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
