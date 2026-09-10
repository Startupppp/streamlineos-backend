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
import { REQUIRE_PERMISSION } from "../../modules/access/require-permission.decorator";

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

/**
 * Reads one metadata key off a single route, its handler overriding its
 * controller class.
 *
 * `isDeclared` used to take `(handler: Function, classRef: Function)` and build
 * that pair itself. `no-unsafe-function-type` bans the bare `Function` type,
 * and there is no honest way to restate it here: the two values come from
 * `ExecutionContext.getHandler()` and `Object.getPrototypeOf(x).constructor`,
 * which Nest and the standard library both type `Function`, and `Function` has
 * no call signature — so writing a real one and passing those values through
 * needs a cast at every call site, while widening to `object` does not satisfy
 * `Reflector`, whose own targets are `(Type<any> | Function)[]`.
 *
 * So the pair stays where it already is a plain array literal — at the call
 * site, which is how every sibling guard in this repo spells it — and this
 * closure is what crosses the boundary. Nothing here names a function type, and
 * the reads return `unknown` and are narrowed below, where they used to be
 * asserted to `boolean`/`string` on nothing but the decorator's good behaviour.
 */
type MetadataReader = (key: string) => unknown;

@Injectable()
export class RouteClassifierGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(RouteClassifierGuard.name);
  private readonly undeclared = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  private isDeclared(read: MetadataReader): boolean {
    if (read(IS_PUBLIC) === true) return true;
    if (read(IS_UNIVERSAL) === true) return true;
    const by = read(AUTHORIZED_IN_SERVICE);
    if (typeof by === "string" && by !== "") return true;
    return read(REQUIRE_PERMISSION) !== undefined;
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
        const declared = this.isDeclared((key) =>
          this.reflector.getAllAndOverride<unknown>(key, [handler, classRef]),
        );
        if (declared) continue;
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
    const declared = this.isDeclared((key) =>
      this.reflector.getAllAndOverride<unknown>(key, [
        context.getHandler(),
        context.getClass(),
      ]),
    );
    if (declared) return true;

    const label = `${context.getClass().name}#${context.getHandler().name}`;
    if (!ENFORCE()) {
      this.logger.warn(`Undeclared route allowed (classification not enforced): ${label}`);
      return true;
    }
    this.logger.error(`Undeclared route denied: ${label}`);
    throw new ForbiddenException("Route has no exposure declaration");
  }
}
