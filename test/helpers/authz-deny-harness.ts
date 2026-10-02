import { Test, type TestingModule } from "@nestjs/testing";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Type,
} from "@nestjs/common";
import {
  APP_GUARD,
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  Reflector,
} from "@nestjs/core";
import { AccessService } from "src/modules/access/access.service";
import { PermissionGuard } from "src/modules/access/permission.guard";
import { ModuleGuard } from "src/common/rbac/module.guard";
import { JwtAuthGuard } from "src/common/auth/jwt-auth.guard";
import { RateLimitGuard } from "src/common/ratelimit/rate-limit.guard";
import { humanSessionPrincipal } from "src/common/auth/principal";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import type { DataScope } from "src/common/rbac/data-scope";
import type { ModuleAvailabilityResult } from "src/common/rbac/module-availability";
import { attachTestAuthContext } from "./module-guard-context";

export interface AuthzHarness {
  readonly app: INestApplication;
  /** The HTTP server supertest drives. */
  server(): ReturnType<INestApplication["getHttpServer"]>;
  /** Hold every catalogued permission EXCEPT this one. */
  denyOnly(permissionKey: string): void;
  /** Hold nothing at all. */
  denyAll(): void;
  /** Hold everything — the control fixture. */
  allowAll(): void;
  holdScopes(scopes: Readonly<Record<string, DataScope>>): void;
  /** Attach no AuthContext, so the guard's UNAUTHENTICATED branch is reached. */
  withoutAuthContext(): void;
  /** Act as a different tenant/user. */
  actAs(actor: Partial<CurrentUserContext>): void;
  /** Make the plan module unavailable, so `ModuleGuard` refuses first. */
  disableModule(reason?: "not-in-plan" | "org-disabled" | "user-denied"): void;
  /** Every permission key the guard was asked about since the last reset. */
  keysAsked(): readonly string[];
  reset(): void;
  close(): Promise<void>;
}

export const ORG_A = "org-a";
export const ORG_B = "org-b";

export function actorOf(
  overrides: Partial<CurrentUserContext> = {},
): CurrentUserContext {
  return {
    userId: "user-a",
    orgId: ORG_A,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-a",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

function autoMock(): Record<string, unknown> {
  const made = new Map<string, unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      // A mock must not look like a promise to Nest's provider resolution.
      if (property === "then") return undefined;
      if (!made.has(property)) made.set(property, jest.fn());
      return made.get(property);
    },
  });
}

interface HarnessState {
  actor: CurrentUserContext;
  attachContext: boolean;
  availability: ModuleAvailabilityResult;
  scopeOf: (permissionKey: string) => DataScope;
  asked: string[];
}

export async function createAuthzHarness(
  controllers: readonly Type<unknown>[],
  options: { providers?: readonly unknown[] } = {},
): Promise<AuthzHarness> {
  const state: HarnessState = {
    actor: actorOf(),
    attachContext: true,
    availability: { available: true },
    scopeOf: () => "none",
    asked: [],
  };

  const authGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      if (!state.attachContext) return true;
      attachTestAuthContext(
        context.switchToHttp().getRequest(),
        state.actor,
        state.availability,
      );
      return true;
    },
  };

  const access = {
    scopeFor: async (
      _user: CurrentUserContext,
      permissionKey: string,
    ): Promise<DataScope> => {
      state.asked.push(permissionKey);
      return state.scopeOf(permissionKey);
    },
    getModuleState: async (): Promise<boolean> => true,
  };

  const discoveryStub = {
    getControllers: (): Iterable<{ instance: unknown }> => [],
    getProviders: (): Iterable<{ instance: unknown }> => [],
  };
  const scannerStub = {
    getAllMethodNames: (_proto: object): Iterable<string> => [],
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    /*
     * `PermissionGuard` injects `DiscoveryService` and `MetadataScanner` to run
     * the BE-29 sweep in `onApplicationBootstrap`. Without `DiscoveryModule`
     * both are auto-mocked, `getControllers()` is not a function, and
     * `app.init()` throws before a single request is made. Importing the real
     * module also keeps the sweep itself live over the controllers under test.
     */
    imports: [DiscoveryModule],
    controllers: [...controllers] as Type<unknown>[],
    providers: [
      Reflector,
      PermissionGuard,
      ModuleGuard,
      /*
       * `JwtAuthGuard` is a global APP_GUARD in production, and a controller is
       * free not to declare it — `SubjectRequestsController` does not. Without
       * this registration such a route reaches `PermissionGuard` with no
       * AuthContext and answers 401, which is NOT its deny path: the spec would
       * be asserting the absence of a guard the harness failed to run.
       */
      { provide: APP_GUARD, useValue: authGuard },
      { provide: AccessService, useValue: access },
      { provide: DiscoveryService, useValue: discoveryStub },
      { provide: MetadataScanner, useValue: scannerStub },
      ...((options.providers ?? []) as never[]),
    ],
  })
    .useMocker(() => autoMock())
    .overrideGuard(JwtAuthGuard)
    .useValue(authGuard)
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  return {
    app,
    server: () => app.getHttpServer(),
    denyOnly(permissionKey: string) {
      state.scopeOf = (key) => (key === permissionKey ? "none" : "all");
    },
    denyAll() {
      state.scopeOf = () => "none";
    },
    allowAll() {
      state.scopeOf = () => "all";
    },
    holdScopes(scopes: Readonly<Record<string, DataScope>>) {
      state.scopeOf = (key) => scopes[key] ?? "none";
    },
    withoutAuthContext() {
      state.attachContext = false;
    },
    actAs(actor: Partial<CurrentUserContext>) {
      state.actor = actorOf(actor);
    },
    disableModule(reason = "org-disabled") {
      state.availability = { available: false, reason };
    },
    keysAsked: () => [...state.asked],
    reset() {
      state.actor = actorOf();
      state.attachContext = true;
      state.availability = { available: true };
      state.scopeOf = () => "none";
      state.asked = [];
    },
    close: () => app.close(),
  };
}

/** One gated route, as a spec states it. */
export interface GatedRoute {
  readonly verb: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  /** The key the route's `@RequirePermission` names. */
  readonly key: string;
}
