import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthContext } from "./auth-context";

export const AuthCtx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext }>();
    if (!req.authContext) throw new UnauthorizedException("Unauthorized");
    return req.authContext;
  },
);
