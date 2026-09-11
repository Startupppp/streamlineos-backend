import { Controller, Delete, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { enrichUserAgent } from "../../common/http/parse-user-agent";
import { SessionsService } from "./sessions.service";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  sessionListResponseSchema,
  sessionRevokeOneResponseSchema,
  sessionRevokeAllResponseSchema,
} from "./dto/sessions-response.schemas";
import { z } from "zod";
import { resolveClientIp } from "../../common/http/client-ip";

const sessionIdParams = z.object({ sessionId: z.string().min(1) }).strict();

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @ResponseSchema(sessionListResponseSchema)
  @Universal()
  list(@Req() req: Request, @CurrentUser() u: CurrentUserContext) {
    const rawUa =
      headerString(req.headers["x-client-user-agent"]) ??
      headerString(req.headers["user-agent"]) ??
      "";
    const clientApp =
      headerString(req.headers["x-client-app"]) ??
      headerString(req.headers["x-streamlineos-client"]) ??
      null;
    const userAgent = enrichUserAgent(rawUa, { clientApp });
    const ipAddress = resolveClientIp(req);
    return this.sessions.list(u.userId, u.sessionId, userAgent, ipAddress);
  }

  @Delete(":sessionId")
  @ResponseSchema(sessionRevokeOneResponseSchema)
  @Universal()
  @Validate({ params: sessionIdParams })
  revokeOne(
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sessions.revokeOne(u.userId, u.sessionId, sessionId);
  }

  @Delete()
  @ResponseSchema(sessionRevokeAllResponseSchema)
  @Universal()
  revokeAllOthers(@CurrentUser() u: CurrentUserContext) {
    return this.sessions.revokeAllOthers(u.userId, u.sessionId);
  }
}
