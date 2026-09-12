import { Logger, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { SignTokensService } from "../sign-tokens.service";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { reportError } from "../../../common/observability";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import {
  getTenantContext,
  runWithTenantContext,
  type AfterCommitHook,
} from "../../../common/tenant/tenant-context";

/**
 * Where a public signing request came from, for the audit rows each step
 * writes. Lives beside the session seam every step already imports, rather than
 * on the public-form service it used to sit in: that surface is retired.
 */
export interface PublicRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Resolving a public recipient token into the recipient and envelope behind it,
 * lifted out of `sign-public.service.ts` unchanged. Every public route in that
 * service runs inside it, which is what made it 70 lines in the middle of a file
 * that is otherwise one method per route.
 *
 * Private with no caller outside the service; it used the db handle, the token
 * service and the logger, so those arrive as parameters.
 */
export async function withRecipientSession<T>(
    db: Db,
    tokens: SignTokensService,
    logger: Logger,
    token: string,
    fn: (session: {
      recipient: typeof signRecipients.$inferSelect;
      envelope: typeof signEnvelopes.$inferSelect;
    }) => Promise<T>,
  ): Promise<T> {
    const hash = tokens.hash(token);
    const recipient = await withPublicToken(db, hash, (tx) =>
      tx.query.signRecipients.findFirst({ where: eq(signRecipients.signingTokenHash, hash) }),
    );
    if (!recipient) throw new NotFoundException("This signing link is invalid.");

    /*
     * This session owns a transaction, so it owns an after-commit queue too.
     *
     * Every public signing route is `@Public()`, so `JwtAuthGuard` returns
     * before setting `req.user`, `resolveTenant` finds no organisation and
     * `TenantContextInterceptor` opens nothing. The transaction below is
     * therefore the outermost one on this path. `runInTenantTransaction` gives
     * it a hook array of its own and drains that fire-and-forget after the
     * commit; the array installed here shadows it so the hooks registered on
     * this path — the auto-advance invitation in `applyRecipientOutcome` — are
     * drained below, awaited, with a failure logged and reported inside the
     * signer's request instead of after it has been answered.
     *
     * Installed only when we are the ones opening the transaction. If a caller
     * above already holds a context, the queue is theirs and drains after
     * *their* commit; shadowing it would drain these hooks while that
     * transaction is still open, which is the whole failure being avoided.
     */
    const preexisting = getTenantContext();
    const afterCommit: AfterCommitHook[] = [];

    const result = await runInTenantTransaction(
      db,
      async (tx) => {
        const envelope = await tx.query.signEnvelopes.findFirst({ where: eq(signEnvelopes.id, recipient.envelopeId) });
        if (!envelope) throw new NotFoundException("This signing link is invalid.");
        const body = () => fn({ recipient, envelope });
        const opened = getTenantContext();
        if (preexisting || !opened) return body();
        return runWithTenantContext({ ...opened, afterCommit }, body);
      },
      { orgId: recipient.orgId },
    );

    /*
     * Awaited rather than fired and forgotten: the signer already waited on
     * this email when it went out inside the transaction, so awaiting it out
     * here costs them nothing and keeps a provider failure observable. Each
     * hook gets its own transaction, and a failure is logged and reported
     * rather than swallowed (§4) — the signing itself has committed, so it must
     * not be failed now for a mail provider's sake.
     */
    for (const hook of afterCommit) {
      try {
        await runInNewTenantTransaction(db, recipient.orgId, async () => {
          await hook();
        });
      } catch (error) {
        logger.error(
          `after-commit hook failed for org ${recipient.orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        reportError(error, { orgId: recipient.orgId, phase: "after-commit" });
      }
    }

    return result;
  }
