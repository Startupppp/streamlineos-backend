import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import type { CurrentUserContext } from "../auth/backend-claims";
import { IDEMPOTENCY_COMMAND, IDEMPOTENCY_OPTIONAL } from "./idempotency.constants";
import { COMMAND_FENCE_STORE, type CommandFenceStore } from "./command-fence-store";

/**
 * Enforces the sensitive-command idempotency contract for any handler decorated with
 * `@Idempotent(commandName)`. It runs as a global APP_INTERCEPTOR registered after
 * `TenantContextInterceptor`, so it always executes inside the tenant transaction context.
 * The raw handler result it stores and replays is re-wrapped by the global response
 * transformer identically on both the first call and any replay.
 *
 * Persistence is delegated to {@link CommandFenceStore} (real: DrizzleCommandFenceStore;
 * tests: InMemoryCommandFenceStore). The interceptor owns all policy: header validation,
 * request hashing, and the four ClaimResult branches. A store failure propagates as-is —
 * the fence is fail-closed because these are sensitive commands where a double-execution
 * is worse than a client retry. The store writes every fence row in the org's tenant
 * transaction (the request's own, or a fresh one on a `@NoTenantTransaction()` route).
 *
 * The request hash covers the command name, the route params and the body — see
 * {@link IdempotencyInterceptor.hashRequest}. `@Idempotent(name, { required: false })`
 * lets a keyless request through unfenced instead of answering 400.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(COMMAND_FENCE_STORE) private readonly store: CommandFenceStore,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const commandName = this.reflector.getAllAndOverride<string | undefined>(
      IDEMPOTENCY_COMMAND,
      [context.getHandler(), context.getClass()],
    );
    if (!commandName) return next.handle();

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      params?: Record<string, unknown>;
      body?: unknown;
      user?: CurrentUserContext;
    }>();

    const rawKey = req.headers["idempotency-key"];
    const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!idempotencyKey) {
      /**
       * An optional fence lets the request through rather than answering 400.
       *
       * The 400 is the right answer for a command that must not execute twice,
       * but it reads at the call site like a body validation failure, so
       * turning it on for a high-frequency existing endpoint breaks every
       * caller that never sent the header in a way that is hard to diagnose.
       * `@Idempotent(name, { required: false })` is how an endpoint offers
       * replay safety to callers who want it without demanding it of callers
       * who do not.
       */
      const optional = this.reflector.getAllAndOverride<boolean | undefined>(
        IDEMPOTENCY_OPTIONAL,
        [context.getHandler(), context.getClass()],
      );
      if (optional) return next.handle();
      throw new BadRequestException(
        "An Idempotency-Key header is required for this operation",
      );
    }
    if (idempotencyKey.length > 255) {
      throw new BadRequestException(
        "Idempotency-Key must be at most 255 characters",
      );
    }

    const user = req.user;
    // No tenant context (e.g. an unauthenticated command) — the fence keys on the org, so skip.
    if (!user?.orgId || !user.userId) return next.handle();

    const audience = user.sessionId?.startsWith("pat:") ? "pat" : "internal";
    const requestHash = this.hashRequest(commandName, req.params, req.body);

    const claim = await this.store.claim({
      orgId: user.orgId,
      audience,
      idempotencyKey,
      commandName,
      requestHash,
      principalId: user.userId,
    });

    if (claim.kind === "mismatch") {
      throw new UnprocessableEntityException(
        "This Idempotency-Key was already used with a different request",
      );
    }
    if (claim.kind === "inflight") {
      throw new ConflictException(
        "A matching request is already in progress; retry shortly",
      );
    }
    if (claim.kind === "replay") {
      const res = context
        .switchToHttp()
        .getResponse<{ status?: (code: number) => void }>();
      if (typeof res.status === "function") res.status(claim.responseStatus);
      return of(claim.responseBody);
    }

    const fenceId = claim.fenceId;
    return next.handle().pipe(
      tap({
        next: (data: unknown) => {
          const res = context
            .switchToHttp()
            .getResponse<{ statusCode?: number }>();
          void this.store.complete(user.orgId, fenceId, res?.statusCode ?? 200, data);
        },
        error: () => {
          void this.store.fail(user.orgId, fenceId);
        },
      }),
    );
  }

  /**
   * The identity of a command: its name, the resource it addresses, and its body.
   *
   * The route params are in here because without them the hash cannot tell two
   * resources apart. `POST /timesheets/timer/:timerId/stop` carries no body, so
   * under `{ commandName, body }` alone every stop of every timer hashed
   * identically — a caller that reuses one key stops timer 11, then calls stop
   * on timer 22 and is replayed the first response. Timer 22 keeps running and
   * the caller is told it stopped. Sixty-nine fenced routes across the platform
   * are param-carrying with no body and shared exactly that defect; posting two
   * different AR invoices under one key had the same shape.
   *
   * Params can only ever narrow the hash, never widen it: a retry is the same
   * request to the same URL, so its params are identical to the original's by
   * construction. Nothing here relies on them being excluded — no two fenced
   * routes share a command name across differing param shapes, so no
   * cross-route dedupe is disturbed.
   *
   * Two details are load-bearing:
   *
   *   - **Keys are sorted.** `JSON.stringify` follows insertion order, and
   *     Express builds `req.params` in the order the segments appear in the
   *     path. Sorting means the hash depends on the params themselves rather
   *     than on how the route happens to be spelled.
   *   - **An empty params object is omitted entirely**, so a route with no
   *     params hashes byte-identically to what it hashed before params were
   *     considered at all. That is what keeps this change from invalidating
   *     the live fences of the 83 param-free routes — see the spec, which
   *     pins the format so the property cannot regress silently.
   */
  private hashRequest(
    commandName: string,
    params: Record<string, unknown> | undefined,
    body: unknown,
  ): string {
    const source = params ?? {};
    const keys = Object.keys(source).sort();
    const canonical: Record<string, unknown> = { commandName };
    if (keys.length > 0) {
      canonical.params = Object.fromEntries(keys.map((k) => [k, String(source[k])]));
    }
    canonical.body = body ?? null;
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }
}
