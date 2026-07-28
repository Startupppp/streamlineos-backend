import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "./backend-claims";

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentUserContext => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    if (!req.user) throw new UnauthorizedException("Unauthorized");
    return req.user;
  },
);
