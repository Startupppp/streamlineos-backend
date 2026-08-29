import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./public.decorator";
import { IS_UNIVERSAL } from "./universal.decorator";
import { REQUIRE_PERMISSION } from "../../modules/access/require-permission.decorator";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

/** Exactly what `Reflector` accepts as a metadata target — a class or a handler. */
type ReflectTarget = Parameters<Reflector["getAllAndOverride"]>[1][number];

/**
 * Every HTTP route must carry exactly one classification:
 *
 *   @Public()          — unauthenticated access permitted
 *   @Universal()       — authenticated, no permission key required
 *   @RequirePermission — gated by PermissionGuard
 *
 * Absence is the defect this guard exists to surface: PermissionGuard is not
 * global, so a handler under a class-level JwtAuthGuard with no key today is
 * authenticated and module-gated but never permission-checked, and nothing
 * says so.
 *
 * ENFORCEMENT IS OPT-IN, and deliberately so. 93 controllers carry a
 * class-level JwtAuthGuard, and §8 designates some of those handlers as
 * platform core that is universal by design — own-calendar and people-directory
 * reads hold no key on purpose. Denying absence before those are marked
 * @Universal() would 403 exactly the surfaces every member is promised.
 *
 * So the boot report always runs and names the undeclared routes, and
 * REQUIRE_ROUTE_CLASSIFICATION=true turns absence into a hard failure — at
 * boot in CI, and at request time. Flip it once the report reaches zero.
 */
@Injectable()
export class RouteClassifierGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(RouteClassifierGuard.name);
  private readonly undeclared = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "REQUIRE_ROUTE_CLASSIFICATION">,
  ) {}

  private enforce(): boolean {
    return this.config.REQUIRE_ROUTE_CLASSIFICATION === "true";
  }

  private isDeclared(handler: ReflectTarget, classRef: ReflectTarget): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, classRef])) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_UNIVERSAL, [handler, classRef])) return true;
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
    const msg = `RouteClassifierGuard: ${this.undeclared.size} route(s) carry no exposure declaration (@Public / @Universal / @RequirePermission):\n  ${list}`;

    if (this.enforce()) throw new Error(msg);
    this.logger.warn(msg);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.isDeclared(context.getHandler(), context.getClass())) return true;

    const label = `${context.getClass().name}#${context.getHandler().name}`;
    if (!this.enforce()) {
      this.logger.warn(`Undeclared route allowed (classification not enforced): ${label}`);
      return true;
    }
    this.logger.error(`Undeclared route denied: ${label}`);
    throw new ForbiddenException("Route has no exposure declaration");
  }
}
