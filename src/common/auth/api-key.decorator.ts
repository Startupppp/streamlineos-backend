import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

export interface ApiKeyContext { id: string; orgId: string; scopes: string[]; }

export const ApiKey = createParamDecorator((_d: unknown, ctx: ExecutionContext): ApiKeyContext => {
  const req = ctx.switchToHttp().getRequest<Request & { apiKey: ApiKeyContext }>();
  return req.apiKey;
});
