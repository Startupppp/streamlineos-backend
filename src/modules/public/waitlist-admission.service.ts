import { randomBytes } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { platformWaitlist } from "../../db/schema";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { AuthService } from "../auth/auth.service";
import {
  ADMISSION_TOKEN_DAYS,
  mayAdmit,
  mayClaim,
} from "./waitlist-admission";

export interface AdmitResult {
  readonly reference: string;
  readonly email: string;
  /** The raw token, returned once. It is stored only as a digest. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ClaimInput {
  readonly token: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly companyName: string;
  /** ISO 3166-1 alpha-2, which decides the region the tenant is placed in. */
  readonly country?: string;
}

/**
 * Letting somebody in off the waitlist.
 *
 * Phase 3, ticket 13. The waitlist has collected entries since 25 August and has
 * never had a path out of it -- every row is PENDING forever. This is that path,
 * and it is deliberately **not** a reopening of self-serve signup: a token is
 * minted only by somebody holding `platform:waitlist:admit`, is single-use, and
 * expires. The door opens one named person at a time.
 *
 * Provisioning goes through `AuthService.register` rather than being written
 * again here. That path already creates the organisation, its first member, the
 * trial subscription, the system roles and the module set, in one tenant
 * transaction, and it already returns early for an email that exists -- so a
 * retried claim cannot produce a second tenant. Reimplementing it would be a
 * second thing to keep correct, and the half that would drift is the half
 * nobody tests: role seeding.
 */
@Injectable()
export class WaitlistAdmissionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  /** The queue, newest first, for whoever decides who gets in. */
  async list(status?: string, limit = 50) {
    const where = status ? eq(platformWaitlist.status, status) : undefined;

    return this.db
      .select({
        id: platformWaitlist.id,
        reference: platformWaitlist.publicCode,
        name: platformWaitlist.name,
        email: platformWaitlist.email,
        organization: platformWaitlist.organization,
        role: platformWaitlist.role,
        teamSize: platformWaitlist.teamSize,
        status: platformWaitlist.status,
        admittedAt: platformWaitlist.admittedAt,
        claimedAt: platformWaitlist.claimedAt,
        createdAt: platformWaitlist.createdAt,
      })
      .from(platformWaitlist)
      .where(where)
      .orderBy(desc(platformWaitlist.createdAt))
      .limit(Math.min(limit, 200));
  }

  /**
   * Mint a single-use token for one entry.
   *
   * Returns the raw token to the caller once. It is never stored and never
   * readable again -- the digest is what the table holds, so a database backup
   * does not contain live credentials for creating organisations.
   */
  async admit(entryId: number, admittedByUserId: string): Promise<AdmitResult> {
    const [entry] = await this.db
      .select({
        id: platformWaitlist.id,
        reference: platformWaitlist.publicCode,
        email: platformWaitlist.email,
        status: platformWaitlist.status,
        claimedAt: platformWaitlist.claimedAt,
      })
      .from(platformWaitlist)
      .where(eq(platformWaitlist.id, entryId))
      .limit(1);

    if (!entry) throw new NotFoundException("No such waitlist entry.");

    const check = mayAdmit(entry);
    if (!check.ok) throw new BadRequestException(check.reason);

    const token = randomBytes(32).toString("hex");
    const expiresAt = addDays(new Date(), ADMISSION_TOKEN_DAYS);

    await this.db
      .update(platformWaitlist)
      .set({
        status: "INVITED",
        tokenHash: hashToken(token),
        tokenExpiresAt: expiresAt,
        admittedByUserId,
        admittedAt: new Date(),
      })
      .where(eq(platformWaitlist.id, entryId));

    logger.info(`waitlist: admitted ${entry.reference}`);

    return { reference: entry.reference, email: entry.email, token, expiresAt };
  }

  /**
   * Spend a token and provision the tenant.
   *
   * Unauthenticated by necessity -- the person has no account yet, which is the
   * point. Every axis is checked rather than trusting that a token in hand is a
   * token that should work: consumed, expired, and the entry's own state.
   */
  async claim(input: ClaimInput): Promise<{ reference: string; email: string }> {
    const digest = hashToken(input.token);

    const [entry] = await this.db
      .select({
        id: platformWaitlist.id,
        reference: platformWaitlist.publicCode,
        email: platformWaitlist.email,
        status: platformWaitlist.status,
        claimedAt: platformWaitlist.claimedAt,
        tokenExpiresAt: platformWaitlist.tokenExpiresAt,
      })
      .from(platformWaitlist)
      .where(eq(platformWaitlist.tokenHash, digest))
      .limit(1);

    // Deliberately the same message as an invalid token. Distinguishing "no such
    // token" from "that token is spent" tells somebody guessing which of their
    // guesses was a real token.
    if (!entry) throw new BadRequestException("That invitation is no longer valid.");

    const check = mayClaim(entry, new Date());
    if (!check.ok) throw new BadRequestException(check.reason);

    /**
     * The claim is marked first, conditionally, and that ordering is the whole
     * of the single-use guarantee.
     *
     * Two clicks on the same link arrive concurrently. Provisioning first and
     * marking after leaves a window in which both pass `mayClaim` and both
     * create an organisation. The `WHERE claimed_at IS NULL` makes the second
     * update affect no rows, so exactly one caller proceeds -- and if
     * provisioning then fails, the entry is re-admittable by an operator, which
     * is a recoverable state. Two tenants is not.
     */
    const claimed = await this.db
      .update(platformWaitlist)
      .set({ status: "CLAIMED", claimedAt: new Date(), tokenHash: null })
      .where(and(eq(platformWaitlist.id, entry.id), isNull(platformWaitlist.claimedAt)))
      .returning({ id: platformWaitlist.id });

    if (claimed.length === 0) {
      throw new BadRequestException("That invitation has already been used.");
    }

    try {
      await this.auth.register({
        email: entry.email,
        firstName: input.firstName,
        lastName: input.lastName ?? "",
        companyName: input.companyName,
        ...(input.country ? { country: input.country } : {}),
      });
    } catch (error) {
      /*
       * Hand the entry back, because the comment above promised it.
       *
       * It said a failed provisioning leaves the entry re-admittable, and it did
       * not: `mayAdmit` refuses anything with a `claimed_at`, so a claim that
       * died mid-provisioning left the person with no token, no account they
       * could sign in to, and an operator whose only recovery was editing the
       * database. Releasing it puts the entry back in the admitted-but-unclaimed
       * state, which is the one an operator can act on.
       *
       * The token digest is already cleared, so releasing does not revive the
       * dead link -- a fresh `admit` has to mint a new one, and that is the only
       * way back in. And a second claim cannot double-provision: `register` now
       * resumes an unfinished workspace rather than starting another.
       */
      await this.db
        .update(platformWaitlist)
        .set({ status: "INVITED", claimedAt: null })
        .where(eq(platformWaitlist.id, entry.id));

      logger.error(`waitlist: provisioning failed for ${entry.reference}, entry released`, {
        error,
      });
      throw error;
    }

    /**
     * Which organisation this claim produced, recorded after the fact.
     *
     * `register` allocates the id and does not return it, and the alternative is
     * duplicating its provisioning to learn the id early -- which is the half
     * that would drift.
     *
     * Read through the user's `last_active_org_id`, which `register` sets in the
     * same transaction as the organisation. Best-effort and deliberately
     * non-fatal: this column is for the operator's queue, and failing a claim
     * that already created a working tenant because a reporting field could not
     * be filled in would be the worst possible trade.
     */
    try {
      const rows = await this.db.execute(
        sql`SELECT last_active_org_id AS org_id FROM users
            WHERE lower(email) = lower(${entry.email}) LIMIT 1`,
      );
      const orgId = rows[0]?.["org_id"];

      if (typeof orgId === "string" && orgId) {
        await this.db
          .update(platformWaitlist)
          .set({ claimedOrgId: orgId })
          .where(eq(platformWaitlist.id, entry.id));
      }
    } catch (error) {
      logger.warn(`waitlist: could not record the organisation for ${entry.reference}`, {
        error,
      });
    }

    logger.info(`waitlist: claimed ${entry.reference}`);

    return { reference: entry.reference, email: entry.email };
  }
}
