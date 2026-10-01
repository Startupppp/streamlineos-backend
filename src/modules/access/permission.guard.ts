import {
  ForbiddenException,
  HttpException,
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
import { broadest } from "./access-policy";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import { authorize } from "./authorize";
import type { AuthResult, DataScope } from "./access.types";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";

/** `string` for a single-key route, `string[]` once a route names several. */
type DeclaredPermission = string | readonly string[];

function declaredKeys(declared: DeclaredPermission): readonly string[] {
  return typeof declared === "string" ? [declared] : declared;
}

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

        const declared = this.reflector.getAllAndOverride<DeclaredPermission | undefined>(
          REQUIRE_PERMISSION,
          [handler, classRef],
        );
        if (declared === undefined) continue;

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

  /**
   * Which refusal a caller sees when every declared key denies.
   *
   * UNAUTHENTICATED outranks everything: there is no principal to judge, and a
   * 402 or 403 would claim the permission system had an opinion about one.
   * NO_MODULE then outranks a plain denial (BE-22/BE-23) so an org whose module
   * is off is told to enable it rather than that it lacks a permission it may
   * well hold. Across mixed namespaces the first key to answer NO_MODULE names
   * the module, because declaration order is the author's own ordering and a 402
   * carries exactly one `moduleKey`.
   */
  private refusalFor(keys: readonly string[], results: readonly AuthResult[]): HttpException {
    if (results.some((r) => r.reason === "UNAUTHENTICATED"))
      return new UnauthorizedException("Unauthorized");

    const moduleDenial = results.findIndex((r) => r.reason === "NO_MODULE");
    if (moduleDenial !== -1)
      return new ModuleDisabledException(
        namespaceOf(keys[moduleDenial]),
        results[moduleDenial].moduleReason ?? "org-disabled",
      );

    return new ForbiddenException("Permission denied");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<DeclaredPermission | undefined>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (declared === undefined) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) return true;
      throw new ForbiddenException("Permission denied");
    }

    const permissionKeys = declaredKeys(declared);
    if (permissionKeys.length === 0) throw new ForbiddenException("Permission denied");

    const req = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext; rbacScope?: AuthResult["scope"]; user?: CurrentUserContext }>();

    let results: AuthResult[];
    try {
      results = await Promise.all(
        permissionKeys.map((key) => authorize(this.access, req.authContext ?? null, key)),
      );
    } catch (error: unknown) {
      logger.error("PermissionGuard: unexpected error during authorization — denying", {
        permissionKeys,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException("Permission denied");
    }

    const allowing = results.filter((r) => r.allow);
    if (allowing.length === 0) throw this.refusalFor(permissionKeys, results);

    // Every declared key, not only the allowing ones: an OR must not become a route into the billing namespace that impersonation could not otherwise take.
    if (permissionKeys.some((key) => key.startsWith("billing:")) && req.user?.impersonation) {
      throw new ForbiddenException("Billing actions are not available during impersonation");
    }

    req.rbacScope = allowing.reduce<DataScope>((widest, r) => broadest(widest, r.scope), "none");
    return true;
  }
}
