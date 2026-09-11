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
import { AUTHORIZED_IN_SERVICE } from "./authorized-in-service.decorator";
import { IS_PUBLIC } from "./public.decorator";
import { IS_UNIVERSAL } from "./universal.decorator";
import { REQUIRE_PERMISSION } from "../../modules/access/require-permission.decorator";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

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

/**
 * Reads one metadata key off a single route, the handler overriding its
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
    /**
     * The escape hatch arrives through the config token, not `process.env`.
     *
     * It used to be a module-level `ENFORCE()` closure reading the variable on
     * every route, every request. `no-restricted-syntax` bans that, and this
     * switch is the one it should least tolerate: it decides whether an
     * undeclared route is denied, and it was readable and writable by anything
     * in the process at any moment, from a source no test could set through the
     * constructor.
     *
     * Going through the schema also narrows it. `env.validation.ts` types it
     * `"true" | "false" | undefined`, so a deployment that misspells the value
     * now fails validation at boot instead of quietly falling through to
     * "enforce" — the case the old `!== "false"` had to be careful about is no
     * longer representable here.
     */
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "REQUIRE_ROUTE_CLASSIFICATION">,
  ) {}

  /**
   * Absence enforces; only an explicit `false` turns it off.
   *
   * Opt-OUT, not opt-in. The comment above and the spec both say absence
   * denies; this predicate once read the opt-in form the flag had while 107
   * routes were undeclared, so an unset variable -- the default everywhere --
   * silently let an undeclared route through. Only a literal "false" disables
   * it, so a typo enforces rather than opens the surface (and the schema now
   * refuses a typo at boot).
   */
  private get enforce(): boolean {
    return this.config.REQUIRE_ROUTE_CLASSIFICATION !== "false";
  }

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

    if (this.enforce) throw new Error(msg);
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
    if (!this.enforce) {
      this.logger.warn(`Undeclared route allowed (classification not enforced): ${label}`);
      return true;
    }
    this.logger.error(`Undeclared route denied: ${label}`);
    throw new ForbiddenException("Route has no exposure declaration");
  }
}
