import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "./backend-claims";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserContext => {
    const req = ctx.switchToHttp().getRequest<Request & { user: CurrentUserContext }>();
    return req.user;
  },
);
