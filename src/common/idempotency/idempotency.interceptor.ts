import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { Observable, of } from "rxjs";
import { concatMap, tap } from "rxjs/operators";
import type { CurrentUserContext } from "../auth/backend-claims";
import { logger } from "../logger/logger.service";
import { getTenantContext } from "../tenant/tenant-context";
import { IDEMPOTENCY_COMMAND } from "./idempotency.constants";
import { COMMAND_FENCE_STORE, type CommandFenceStore } from "./command-fence-store";

/** Attempts at the completion write when there is no transaction to be atomic with. */
const COMPLETION_ATTEMPTS = 3;
const COMPLETION_RETRY_MS = 50;

interface FencedRequest {
  headers: Record<string, unknown>;
  method?: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  user?: CurrentUserContext;
}

/**
 * Key order is part of a hash, and Express hands `params` and `query` back in
 * whatever order the URL happened to use, so they are sorted before hashing —
 * otherwise `?a=1&b=2` and `?b=2&a=1` would be two different commands.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child: unknown = Reflect.get(value, key);
    out[key] = canonical(child);
  }
  return out;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Enforces the sensitive-command idempotency contract for any handler decorated with
 * `@Idempotent(commandName)`. It runs as a global APP_INTERCEPTOR registered after
 * `TenantContextInterceptor`, so it always executes inside the tenant transaction context.
 * The raw handler result it stores and replays is re-wrapped by the global response
 * transformer identically on both the first call and any replay.
 *
 * Persistence is delegated to {@link CommandFenceStore} (real: DrizzleCommandFenceStore;
 * tests: InMemoryCommandFenceStore). The interceptor owns all policy: header validation,
 * request hashing, the four ClaimResult branches, and what a failed completion write
 * costs. A store failure propagates as-is — the fence is fail-closed because these are
 * sensitive commands where a double-execution is worse than a client retry.
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

    const req = context.switchToHttp().getRequest<FencedRequest>();

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
    /*
     * The fence keys on the organisation, so without one there is nothing to key on.
     * This used to fall through to the handler, which ran a command declared sensitive
     * with no fence at all and no signal that it had happened. No route reaches it today
     * — `JwtAuthGuard` rejects an org-less request 403 unless the handler carries
     * `@AllowNoOrg()`, and no `@Idempotent` handler does — so failing closed costs
     * nothing now and stops the next `@Public` or `@AllowNoOrg` fenced route from
     * silently running unprotected.
     */
    if (!user?.orgId || !user.userId) {
      throw new InternalServerErrorException(
        `The command "${commandName}" is fenced but the request carries no organisation context`,
      );
    }

    const audience = user.sessionId?.startsWith("pat:") ? "pat" : "internal";
    /*
     * Path params, method and query are part of the request's identity. Hashing only
     * `{commandName, body}` meant one key replayed across `/credit-notes/:a/post` and
     * `/credit-notes/:b/post` — same empty body, same command — and the client got the
     * first note's response while the second was never posted.
     */
    const requestHash = sha256({
      v: 2,
      commandName,
      method: (req.method ?? "").toUpperCase(),
      params: canonical(req.params ?? null),
      query: canonical(req.query ?? null),
      body: canonical(req.body ?? null),
    });
    const legacyRequestHash = sha256({ commandName, body: req.body ?? null });

    const claim = await this.store.claim({
      orgId: user.orgId,
      audience,
      idempotencyKey,
      commandName,
      requestHash,
      legacyRequestHash,
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
        error: () => {
          /*
           * Inside a tenant transaction the claim row rolls back with the command it
           * fenced, so there is nothing left to stamp and an UPDATE on an aborting
           * transaction only raises a second, misleading error. Outside one the claim
           * is durable and must be stamped, or the retry waits out a stale lease.
           */
          if (getTenantContext()) return;
          void this.store.fail(fenceId);
        },
      }),
      concatMap(async (data: unknown) => {
        const res = context
          .switchToHttp()
          .getResponse<{ statusCode?: number }>();
        await this.recordCompletion(fenceId, res?.statusCode ?? 200, data, commandName);
        return data;
      }),
    );
  }

  /**
   * The completion write, and what its failure is allowed to cost.
   *
   * Inside a tenant transaction it is awaited and its failure propagates: the fence
   * stamp and the command's own writes are the same transaction, so the alternative
   * to committing both is committing neither. That is what makes a lost completion
   * write incapable of licensing a second transfer — the first one did not happen.
   *
   * Outside one the command has already committed on its own, and failing the response
   * would report an error for work that succeeded. There it is retried and then logged
   * at error — the previous behaviour was an empty `catch` with no log at all, so a pool
   * exhausted exactly as handlers finished would have double-executed money commands
   * invisibly.
   */
  private async recordCompletion(
    fenceId: number,
    responseStatus: number,
    data: unknown,
    commandName: string,
  ): Promise<void> {
    if (getTenantContext()) {
      await this.store.complete(fenceId, responseStatus, data);
      return;
    }

    for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt++) {
      try {
        await this.store.complete(fenceId, responseStatus, data);
        return;
      } catch (error: unknown) {
        if (attempt === COMPLETION_ATTEMPTS) {
          logger.error(
            "[idempotency] the fence was never stamped COMPLETED; a retry on this key will re-execute the command",
            {
              fenceId,
              commandName,
              attempts: attempt,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_MS * attempt));
      }
    }
  }
}
