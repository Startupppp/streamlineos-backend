import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { IS_PUBLIC } from "./public.decorator";
import type { BackendClaims, CurrentUserContext } from "./backend-claims";

function extractClaims(payload: JWTPayload): BackendClaims {
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    orgId: typeof payload["orgId"] === "string" && payload["orgId"] !== "" ? payload["orgId"] : null,
    branchId: typeof payload["branchId"] === "number" ? payload["branchId"] : null,
    role: typeof payload["role"] === "string" ? payload["role"] : "",
    permissions: Array.isArray(payload["permissions"])
      ? payload["permissions"].filter((x): x is string => typeof x === "string")
      : [],
    enabledModules: Array.isArray(payload["enabledModules"])
      ? payload["enabledModules"].filter((x): x is string => typeof x === "string")
      : [],
    plan: typeof payload["plan"] === "string" ? payload["plan"] : null,
    isPlatformAdmin: payload["isPlatformAdmin"] === true,
    isOrgOwner: payload["isOrgOwner"] === true,
    sessionId: typeof payload["sessionId"] === "string" ? payload["sessionId"] : "",
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Unauthorized");
    }
    const token = header.slice("Bearer ".length).trim();
    const secret = process.env.BACKEND_JWT_SECRET;
    if (!secret) throw new UnauthorizedException("Unauthorized");

    let claims: BackendClaims;
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      claims = extractClaims(payload);
    } catch {
      throw new UnauthorizedException("Unauthorized");
    }

    if (!claims.sub) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (!claims.sessionId) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (!claims.orgId && !claims.isPlatformAdmin) {
      throw new UnauthorizedException("Organization not found");
    }

    req.user = {
      userId: claims.sub,
      orgId: claims.orgId ?? "",
      branchId: claims.branchId ?? null,
      role: claims.role,
      permissions: claims.permissions,
      enabledModules: claims.enabledModules,
      plan: claims.plan,
      isPlatformAdmin: claims.isPlatformAdmin,
      isOrgOwner: claims.isOrgOwner,
      sessionId: claims.sessionId,
    };
    return true;
  }
}
