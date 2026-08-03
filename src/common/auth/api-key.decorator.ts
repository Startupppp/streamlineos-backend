import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

export interface ApiKeyContext { id: string; orgId: string; scopes: string[]; }

export const ApiKey = createParamDecorator((_: unknown, ctx: ExecutionContext): ApiKeyContext => {
  const req = ctx.switchToHttp().getRequest<Request & { apiKey: ApiKeyContext }>();
  return req.apiKey;
});
