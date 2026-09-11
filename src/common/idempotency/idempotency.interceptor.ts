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
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { Reflector } from "@nestjs/core";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { commandFences } from "../../db/schema";
import type { CurrentUserContext } from "../auth/backend-claims";
import {
  IDEMPOTENCY_COMMAND,
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_OPTIONAL,
  IDEMPOTENCY_TTL_MS,
} from "./idempotency.constants";

interface ClaimParams {
  orgId: string;
  audience: string;
  idempotencyKey: string;
  commandName: string;
  requestHash: string;
  principalId: string;
}

type ClaimResult =
  | { kind: "proceed"; fenceId: number }
  | { kind: "replay"; responseBody: unknown; responseStatus: number }
  | { kind: "inflight" }
  | { kind: "mismatch" };

/**
 * Enforces the sensitive-command idempotency contract for any handler decorated with
 * `@Idempotent(commandName)`. It runs as an inner (method-level) interceptor, so the raw
 * handler result it stores and replays is re-wrapped by the global response transformer
 * identically on both the first call and any replay.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
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

    const claim = await this.claim({
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
          void this.complete(user.orgId, fenceId, res?.statusCode ?? 200, data);
        },
        error: () => {
          void this.fail(user.orgId, fenceId);
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
    const keys = Object.keys(params ?? {}).sort();
    const canonical: Record<string, unknown> = { commandName };
    if (keys.length > 0) {
      canonical.params = Object.fromEntries(
        keys.map((k) => [k, String(params![k])]),
      );
    }
    canonical.body = body ?? null;
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  /**
   * Every fence write runs in the caller's own tenant transaction.
   *
   * `command_fences` is tenant-scoped and under row-level security, so a write
   * that names no organisation is refused — and the refusal lands on the fence,
   * not the command, so an idempotent route 500s before its handler ever runs.
   */
  private inTenant<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return runInNewTenantTransaction(this.db, orgId, (tx) => fn(tx as unknown as Db));
  }

  private async claim(params: ClaimParams): Promise<ClaimResult> {
    const now = Date.now();
    const leaseExpiresAt = new Date(now + IDEMPOTENCY_LEASE_MS);
    const expiresAt = new Date(now + IDEMPOTENCY_TTL_MS);

    const inserted = await this.inTenant(params.orgId, (tx) => tx
      .insert(commandFences)
      .values({
        organizationId: params.orgId,
        audience: params.audience,
        idempotencyKey: params.idempotencyKey,
        commandName: params.commandName,
        requestHash: params.requestHash,
        principalId: params.principalId,
        status: "IN_FLIGHT",
        leaseExpiresAt,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [
          commandFences.organizationId,
          commandFences.audience,
          commandFences.idempotencyKey,
        ],
      })
      .returning({ fenceId: commandFences.commandFenceId }));

    if (inserted.length > 0) return { kind: "proceed", fenceId: inserted[0].fenceId };

    const [existing] = await this.inTenant(params.orgId, (tx) => tx
      .select()
      .from(commandFences)
      .where(
        and(
          eq(commandFences.organizationId, params.orgId),
          eq(commandFences.audience, params.audience),
          eq(commandFences.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1));

    // Conflicting row vanished between insert and read (e.g. expiry sweep) — treat as in-flight; client retries.
    if (!existing) return { kind: "inflight" };

    if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };

    if (existing.status === "COMPLETED") {
      return {
        kind: "replay",
        responseBody: existing.responseBody ?? null,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (
      existing.status === "IN_FLIGHT" &&
      existing.leaseExpiresAt.getTime() > now
    ) {
      return { kind: "inflight" };
    }

    // Expired in-flight lease or a prior FAILED attempt — reclaim under an optimistic lock on the
    // observed lease timestamp, so exactly one concurrent reclaimer wins.
    const reclaimed = await this.inTenant(params.orgId, (tx) => tx
      .update(commandFences)
      .set({
        status: "IN_FLIGHT",
        leaseExpiresAt,
        expiresAt,
        requestHash: params.requestHash,
        principalId: params.principalId,
        responseBody: null,
        responseStatus: null,
      })
      .where(
        and(
          eq(commandFences.commandFenceId, existing.commandFenceId),
          eq(commandFences.leaseExpiresAt, existing.leaseExpiresAt),
        ),
      )
      .returning({ fenceId: commandFences.commandFenceId }));

    if (reclaimed.length > 0) return { kind: "proceed", fenceId: reclaimed[0].fenceId };
    return { kind: "inflight" };
  }

  private async complete(
    orgId: string,
    fenceId: number,
    responseStatus: number,
    data: unknown,
  ): Promise<void> {
    try {
      await this.inTenant(orgId, (tx) =>
        tx
          .update(commandFences)
          .set({ status: "COMPLETED", responseBody: data ?? null, responseStatus })
          .where(eq(commandFences.commandFenceId, fenceId)),
      );
    } catch {
      // best-effort: a lost completion write just means the next retry re-executes after the lease.
    }
  }

  private async fail(orgId: string, fenceId: number): Promise<void> {
    try {
      await this.inTenant(orgId, (tx) =>
        tx
          .update(commandFences)
          .set({ status: "FAILED" })
          .where(eq(commandFences.commandFenceId, fenceId)),
      );
    } catch {
      // best-effort
    }
  }
}
