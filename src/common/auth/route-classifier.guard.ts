import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { AUTHORIZED_IN_SERVICE } from "./authorized-in-service.decorator";
import { IS_PUBLIC } from "./public.decorator";
import { IS_UNIVERSAL } from "./universal.decorator";
import { REQUIRE_PERMISSION } from "../rbac/require-permission-key";

/**
 * Every HTTP route must carry exactly one classification:
 *
 *   @Public()             — unauthenticated access permitted
 *   @Universal()          — authenticated, no permission key required
 *   @RequirePermission    — gated by PermissionGuard
 *   @AuthorizedInService  — authorized downstream, naming what does it
 *
 * Absence is the defect this guard exists to surface: PermissionGuard is not
 * global, so a handler under a class-level JwtAuthGuard with no key today is
 * authenticated and module-gated but never permission-checked, and nothing
 * says so.
 *
 * Enforcement is ON. It was opt-in while 107 routes were undeclared, because
 * denying absence would have 403'd the platform-core surfaces §8 promises every
 * member; that count reached zero on 2026-08-27, so absence now denies at boot
 * and at request time. REQUIRE_ROUTE_CLASSIFICATION=false is the escape hatch,
 * and turning it off is a deliberate line in a deployment config.
 */
const ENFORCE = () => process.env.REQUIRE_ROUTE_CLASSIFICATION !== "false";

@Injectable()
export class RouteClassifierGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(RouteClassifierGuard.name);
  private readonly undeclared = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  private isDeclared(handler: Function, classRef: Function): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, classRef])) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_UNIVERSAL, [handler, classRef])) return true;
    const by = this.reflector.getAllAndOverride<string | undefined>(AUTHORIZED_IN_SERVICE, [handler, classRef]);
    if (by !== undefined && by !== "") return true;
    const key = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [handler, classRef]);
    return key !== undefined;
  }

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== "object") continue;

      const proto: object = Object.getPrototypeOf(instance);
      const classRef = proto.constructor;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, methodName);
        if (typeof handler !== "function") continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        if (this.isDeclared(handler, classRef)) continue;
        this.undeclared.add(`${classRef.name}#${methodName}`);
      }
    }

    if (this.undeclared.size === 0) {
      this.logger.log("RouteClassifierGuard: every route declares its exposure");
      return;
    }

    const list = [...this.undeclared].sort().join("\n  ");
    const msg = `RouteClassifierGuard: ${this.undeclared.size} route(s) carry no exposure declaration (@Public / @Universal / @RequirePermission / @AuthorizedInService):\n  ${list}`;

    if (ENFORCE()) throw new Error(msg);
    this.logger.warn(msg);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.isDeclared(context.getHandler(), context.getClass())) return true;

    const label = `${context.getClass().name}#${context.getHandler().name}`;
    if (!ENFORCE()) {
      this.logger.warn(`Undeclared route allowed (classification not enforced): ${label}`);
      return true;
    }
    this.logger.error(`Undeclared route denied: ${label}`);
    throw new ForbiddenException("Route has no exposure declaration");
  }
}
