import {
  ForbiddenException,
  UnauthorizedException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthContext } from "../../common/auth/auth-context";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { IS_PUBLIC } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import { AccessService } from "./access.service";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import { authorize } from "./authorize";
import type { AuthResult } from "./access.types";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";

@Injectable()
export class PermissionGuard implements CanActivate, OnApplicationBootstrap {
  private readonly bootLogger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const broken: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== "object") continue;

      const proto: object = Object.getPrototypeOf(instance);
      const classRef = proto.constructor;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, methodName);
        if (typeof handler !== "function") continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const permissionKey = this.reflector.getAllAndOverride<string | undefined>(
          REQUIRE_PERMISSION,
          [handler, classRef],
        );
        if (permissionKey === undefined) continue;

        const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, classRef) ?? [];
        const hasPermissionGuard = [...classGuards, ...handlerGuards].includes(PermissionGuard);

        if (!hasPermissionGuard) {
          broken.push(`${classRef.name}#${methodName}`);
        }
      }
    }

    if (broken.length === 0) {
      this.bootLogger.log(
        "PermissionGuard: every @RequirePermission route has PermissionGuard in its guard chain",
      );
      return;
    }

    const list = broken.sort().join("\n  ");
    throw new Error(
      `PermissionGuard: ${broken.length} route(s) declare @RequirePermission but mount no PermissionGuard — add @UseGuards(JwtAuthGuard, PermissionGuard) to each controller or handler:\n  ${list}`,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permissionKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissionKey) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) return true;
      throw new ForbiddenException("Permission denied");
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext; rbacScope?: AuthResult["scope"]; user?: CurrentUserContext }>();

    let result: AuthResult;
    try {
      result = await authorize(this.access, req.authContext ?? null, permissionKey);
    } catch (error: unknown) {
      logger.error("PermissionGuard: unexpected error during authorization — denying", {
        permissionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException("Permission denied");
    }

    if (!result.allow) {
      if (result.reason === "UNAUTHENTICATED") throw new UnauthorizedException("Unauthorized");
      if (result.reason === "NO_MODULE")
        throw new ModuleDisabledException(
          namespaceOf(permissionKey),
          result.moduleReason ?? "org-disabled",
        );
      throw new ForbiddenException("Permission denied");
    }

    if (permissionKey.startsWith("billing:") && req.user?.impersonation) {
      throw new ForbiddenException("Billing actions are not available during impersonation");
    }

    req.rbacScope = result.scope;
    return true;
  }
}
