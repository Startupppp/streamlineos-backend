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
import { IDEMPOTENCY_COMMAND } from "./idempotency.constants";
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
 * is worse than a client retry.
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
      body?: unknown;
      user?: CurrentUserContext;
    }>();

    const rawKey = req.headers["idempotency-key"];
    const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!idempotencyKey) {
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
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ commandName, body: req.body ?? null }))
      .digest("hex");

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
          void this.store.complete(fenceId, res?.statusCode ?? 200, data);
        },
        error: () => {
          void this.store.fail(fenceId);
        },
      }),
    );
  }
}
