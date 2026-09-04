import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { commandFences } from "../../db/schema";
import { logger } from "../logger/logger.service";
import { getPostgresErrorDetails } from "../db/postgres-error";
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS } from "./idempotency.constants";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";

export interface ClaimParams {
  orgId: string;
  audience: string;
  idempotencyKey: string;
  commandName: string;
  requestHash: string;
  /**
   * The pre-widening hash of the same request, accepted only for a fence this
   * process did not write. See {@link requestHashMatches}.
   */
  legacyRequestHash?: string;
  principalId: string;
}

export type ClaimResult =
  | { kind: "proceed"; fenceId: number }
  | { kind: "replay"; responseBody: unknown; responseStatus: number }
  | { kind: "inflight" }
  | { kind: "mismatch" };

/**
 * `orgId` is on every method because the fence is a tenant row and `command_fences`
 * is RLS-enabled with `organization_id = current_org_id()` — a function that RAISES
 * `42501` rather than returning NULL when the GUC is absent. `claim` always carried
 * it; `complete` and `fail` did not, and had no way to open a transaction of their
 * own, so all three depended on an ambient tenant transaction being open around them.
 * That is what made `@Idempotent` unusable on a `@NoTenantTransaction()` route.
 */
export interface CommandFenceStore {
  claim(params: ClaimParams): Promise<ClaimResult>;
  complete(fenceId: number, responseStatus: number, data: unknown, orgId: string): Promise<void>;
  fail(fenceId: number, orgId: string): Promise<void>;
}

export const COMMAND_FENCE_STORE = "COMMAND_FENCE_STORE";

/**
 * When this process booted. Every fence it writes carries the widened request hash,
 * so a row older than this is the only kind that can legitimately still carry the
 * narrow one.
 */
export const PROCESS_STARTED_AT = new Date();

/**
 * Whether a stored fence describes the request now being claimed.
 *
 * The hash was widened to cover the route's path params, method and query — without
 * them one key replayed across `/x/:a/post` and `/x/:b/post` and returned the first
 * resource's response for the second. Rewriting the input invalidates every fence
 * already on disk, so a retry that was in flight across the deploy would have been
 * answered 422 "already used with a different request" instead of replaying. A row
 * written before this process started is therefore still matched against the narrow
 * hash; a row this process wrote can only carry the wide one. The window closes on
 * its own with the 24h fence TTL, after which `legacyRequestHash` can be deleted.
 */
export function requestHashMatches(
  existing: { requestHash: string; createdAt: Date },
  params: ClaimParams,
): boolean {
  if (existing.requestHash === params.requestHash) return true;
  if (params.legacyRequestHash === undefined) return false;
  if (existing.createdAt.getTime() >= PROCESS_STARTED_AT.getTime()) return false;
  return existing.requestHash === params.legacyRequestHash;
}

function describe(error: unknown): Record<string, unknown> {
  const details = getPostgresErrorDetails(error);
  return {
    error: error instanceof Error ? error.message : String(error),
    sqlstate: details.code,
    constraint: details.constraint,
  };
}

/**
 * Every fence statement runs through here, and this is the whole reason `@Idempotent`
 * composes with `@NoTenantTransaction()`.
 *
 * `command_fences` carries the RLS policy `organization_id = current_org_id()`, and
 * `current_org_id()` RAISES `42501` when `app.organization_id` is unset — it is not the
 * `_or_null` variant, so there is no quiet zero-row answer to mistake for success. The
 * store used to issue all three statements through the bare injected `DRIZZLE` proxy,
 * which routes to the ambient tenant transaction when there is one and falls through to
 * the pool with no GUC when there is not. Measured against the live schema as
 * `streamline_app`: the insert without a GUC fails
 * `ERROR: no tenant context: app.organization_id is not set for this transaction`, and
 * the identical insert inside `set_config('app.organization_id', ...)` passes the policy.
 *
 * So a fenced handler that also carried `@NoTenantTransaction()` did not merely lose its
 * fence — it 500'd on the very first statement, before the handler ran at all. That is why
 * `POST /kb/ask` and the two reindex routes could not simply be decorated: they must run
 * outside the request transaction, because each awaits a provider round trip that would
 * otherwise pin a pooled connection idle-in-transaction past the 60s
 * `idle_in_transaction_session_timeout` that `withTenant` sets.
 *
 * `runInTenantTransaction` with an explicit `orgId` returns the ambient transaction
 * unchanged when one is open, so every fenced route that already worked behaves exactly as
 * before — including the property the money commands depend on, that a failed completion
 * write rolls the command back with it. Only the no-ambient-context case changes, and it
 * changes from "guaranteed 42501" to "a short transaction of its own".
 */
@Injectable()
export class DrizzleCommandFenceStore implements CommandFenceStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private fenced<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return runInTenantTransaction(this.db, fn, { orgId });
  }

  async claim(params: ClaimParams): Promise<ClaimResult> {
    return this.fenced(params.orgId, () => this.claimStatements(params));
  }

  private async claimStatements(params: ClaimParams): Promise<ClaimResult> {
    const now = Date.now();
    const leaseExpiresAt = new Date(now + IDEMPOTENCY_LEASE_MS);
    const expiresAt = new Date(now + IDEMPOTENCY_TTL_MS);

    const inserted = await this.db
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
      .returning({ fenceId: commandFences.commandFenceId });

    const [firstInserted] = inserted;
    if (firstInserted) return { kind: "proceed", fenceId: firstInserted.fenceId };

    const [existing] = await this.db
      .select()
      .from(commandFences)
      .where(
        and(
          eq(commandFences.organizationId, params.orgId),
          eq(commandFences.audience, params.audience),
          eq(commandFences.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) return { kind: "inflight" };

    if (existing.status === "COMPLETED") {
      if (!requestHashMatches(existing, params)) return { kind: "mismatch" };
      return {
        kind: "replay",
        responseBody: existing.responseBody ?? null,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (existing.status === "IN_FLIGHT" && existing.leaseExpiresAt.getTime() > now) {
      if (!requestHashMatches(existing, params)) return { kind: "mismatch" };
      return { kind: "inflight" };
    }

    /*
     * FAILED, or IN_FLIGHT past its lease.
     *
     * A command that failed must be retryable on the same key — the client never
     * received a success to replay — so a FAILED fence is re-leased rather than
     * replayed or rejected, and the hash is NOT compared: a retry that corrects an
     * invalid body is the ordinary reason a fenced command failed. The lease value
     * is the compare-and-set token, so two racing retries cannot both proceed.
     */
    const reclaimed = await this.db
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
          eq(commandFences.status, existing.status),
        ),
      )
      .returning({ fenceId: commandFences.commandFenceId });

    const [firstReclaimed] = reclaimed;
    if (firstReclaimed) return { kind: "proceed", fenceId: firstReclaimed.fenceId };
    return { kind: "inflight" };
  }

  /**
   * Stamps the fence COMPLETED, and **propagates a failure**.
   *
   * This used to swallow, on the reasoning that "a lost completion write just means
   * the next retry re-executes after the lease". For the money commands behind
   * `@Idempotent` that reasoning inverts: re-executing `POST /finance/transfers`
   * moves the cash a second time. The write is issued on the request's own tenant
   * transaction (the DRIZZLE provider is a proxy that routes to the ambient `tx`),
   * so letting it fail rolls the command back with it — there is no state in which
   * the money moved and the fence did not. The interceptor owns the one case where
   * that is not true: a handler running outside a tenant transaction, where the
   * command has already committed and the completion is retried and logged instead.
   */
  async complete(
    fenceId: number,
    responseStatus: number,
    data: unknown,
    orgId: string,
  ): Promise<void> {
    await this.fenced(orgId, async () => {
      await this.db
        .update(commandFences)
        .set({ status: "COMPLETED", responseBody: data ?? null, responseStatus })
        .where(eq(commandFences.commandFenceId, fenceId));
    });
  }

  /**
   * Stamps the fence FAILED so a retry re-leases it instead of waiting out a stale
   * lease. The interceptor calls this only when the fence is durable — inside a
   * tenant transaction the claim row rolls back with the failing command, so there
   * is nothing left to stamp. A failure here is logged rather than propagated: the
   * command has already failed and the client is already getting an error.
   */
  async fail(fenceId: number, orgId: string): Promise<void> {
    try {
      await this.fenced(orgId, async () => {
        await this.db
          .update(commandFences)
          .set({ status: "FAILED" })
          .where(eq(commandFences.commandFenceId, fenceId));
      });
    } catch (error: unknown) {
      logger.error("[idempotency] could not stamp the fence FAILED", {
        fenceId,
        ...describe(error),
      });
    }
  }
}
