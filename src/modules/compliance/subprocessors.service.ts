import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, or, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { subprocessors, subprocessorSubscribers } from "../../db/schema";

/**
 * The subprocessor register, and who wants to hear about changes to it.
 *
 * Platform data rather than tenant data: our subprocessors are the same for every
 * customer, and a per-tenant register would assert something untrue.
 */

export interface SubprocessorEntry {
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
  readonly url: string | null;
  readonly effectiveFrom: string;
  readonly retiredAt: string | null;
}

@Injectable()
export class SubprocessorsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The register as a customer reads it.
   *
   * Retired entries are included by default rather than filtered out. A reviewer
   * checking a period needs to know who processed their data *then*, and a
   * register that silently drops a departed processor cannot answer that.
   */
  async list(options?: { includeRetired?: boolean }): Promise<SubprocessorEntry[]> {
    const includeRetired = options?.includeRetired ?? true;

    const rows = await this.db
      .select({
        name: subprocessors.name,
        purpose: subprocessors.purpose,
        location: subprocessors.location,
        url: subprocessors.url,
        effectiveFrom: subprocessors.effectiveFrom,
        retiredAt: subprocessors.retiredAt,
      })
      .from(subprocessors)
      .where(includeRetired ? undefined : isNull(subprocessors.retiredAt))
      .orderBy(asc(subprocessors.name));

    return rows.map((row) => ({
      ...row,
      effectiveFrom: row.effectiveFrom.toISOString(),
      retiredAt: row.retiredAt?.toISOString() ?? null,
    }));
  }

  /**
   * Records an interest in changes.
   *
   * Idempotent on the email, and a re-subscribe clears a previous unsubscribe
   * rather than inserting a second row -- otherwise unsubscribing once would stop
   * working the moment somebody signed up twice.
   */
  async subscribe(email: string, organizationId?: string): Promise<{ subscribed: true }> {
    const normalised = email.trim().toLowerCase();

    await this.db
      .insert(subprocessorSubscribers)
      .values({ email: normalised, organizationId: organizationId ?? null })
      .onConflictDoUpdate({
        target: subprocessorSubscribers.email,
        set: { unsubscribedAt: null },
      });

    return { subscribed: true };
  }

  /** The row stays, so a later re-subscribe is one act rather than a new record. */
  async unsubscribe(email: string): Promise<{ unsubscribed: true }> {
    await this.db
      .update(subprocessorSubscribers)
      .set({ unsubscribedAt: new Date() })
      .where(eq(subprocessorSubscribers.email, email.trim().toLowerCase()));

    return { unsubscribed: true };
  }

  /**
   * Who to tell when the register changes.
   *
   * Kept here rather than at the notification site so there is one answer to
   * "who is subscribed", and one place to get the unsubscribe filter right.
   */
  async activeSubscribers(): Promise<string[]> {
    const rows = await this.db
      .select({ email: subprocessorSubscribers.email })
      .from(subprocessorSubscribers)
      .where(isNull(subprocessorSubscribers.unsubscribedAt))
      .orderBy(asc(subprocessorSubscribers.email));

    return rows.map((row) => row.email);
  }

  /**
   * What changed since a date, which is what a notification says.
   *
   * Both halves matter: a processor added, and one retired. A notification that
   * only reported additions would let a customer believe a departed processor
   * still holds their data.
   */
  async changesSince(since: Date): Promise<SubprocessorEntry[]> {
    const rows = await this.db
      .select({
        name: subprocessors.name,
        purpose: subprocessors.purpose,
        location: subprocessors.location,
        url: subprocessors.url,
        effectiveFrom: subprocessors.effectiveFrom,
        retiredAt: subprocessors.retiredAt,
      })
      .from(subprocessors)
      .where(
        or(gt(subprocessors.effectiveFrom, since), and(gt(subprocessors.retiredAt, since))),
      )
      .orderBy(asc(subprocessors.effectiveFrom));

    return rows.map((row) => ({
      ...row,
      effectiveFrom: row.effectiveFrom.toISOString(),
      retiredAt: row.retiredAt?.toISOString() ?? null,
    }));
  }
}
