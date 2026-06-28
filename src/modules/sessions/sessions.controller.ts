import { Controller, Delete, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SessionsService } from "./sessions.service";

@Controller("hr/sessions")
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Req() req: Request, @CurrentUser() u: CurrentUserContext) {
    const userAgent = req.headers["user-agent"];
    const raw = req.headers["x-forwarded-for"];
    const ipAddress =
      (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim() ??
      (req.headers["x-real-ip"] as string | undefined);
    return this.sessions.list(u.userId, u.sessionId, userAgent, ipAddress);
  }

  @Delete(":sessionId")
  revokeOne(
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sessions.revokeOne(u.userId, u.sessionId, sessionId);
  }

  @Delete()
  revokeAllOthers(@CurrentUser() u: CurrentUserContext) {
    return this.sessions.revokeAllOthers(u.userId, u.sessionId);
  }
}
