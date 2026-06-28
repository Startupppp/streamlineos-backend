import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "./backend-claims";

@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    if (!req.user?.isPlatformAdmin) {
      throw new ForbiddenException("Platform owner access required");
    }
    return true;
  }
}