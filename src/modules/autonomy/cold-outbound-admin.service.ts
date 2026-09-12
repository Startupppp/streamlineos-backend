import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { resolveTxt } from "node:dns/promises";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { crmColdOutboundSettings, crmSendingDomains } from "../../db/schema";
import type { SendingDomainPurpose } from "../../db/schema/crm/outbound";

/** Where the tenant publishes the proof, and what it must say. */
const VERIFY_PREFIX = "_streamline-verify";
const VERIFY_KEY = "streamline-verify";

/**
 * A slow resolver must not hold a request open.
 *
 * DNS is the one outbound call on this path and the tenant controls the name, so
 * a nameserver that never answers is a request that never returns. Failing after
 * five seconds reads to the tenant as "not published yet", which is the same
 * thing they would do about it.
 */
const DNS_TIMEOUT_MS = 5_000;

/**
 * The operator controls for cold outreach, which did not exist.
 *
 * `evaluateColdGate` refuses on `not-enabled` and on the absence of a warmed
 * domain, and reads both from tables nothing wrote: the only writer of
 * `crm_cold_outbound_settings` anywhere was `pauseColdTrack`, which sets
 * `enabled: false`. So the cold track could be paused and never enabled, never
 * warmed, and never resumed — dead by construction, with the gate reporting a
 * configuration problem no screen could fix.
 *
 * Every method here is an explicit act by a person holding
 * `crm:autonomy:manage`. Nothing enables itself, and nothing here can undo a
 * pause the send path imposed except by a person clearing it, which is what that
 * column's own contract asks for.
 */
@Injectable()
export class ColdOutboundAdminService {
  private readonly logger = new Logger("ColdOutbound");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Everything the screen needs: the track's state and the domains behind it. */
  async overview(organizationId: string) {
    const [settings] = await this.db
      .select({
        enabled: crmColdOutboundSettings.enabled,
        enabledAt: crmColdOutboundSettings.enabledAt,
        pausedAt: crmColdOutboundSettings.pausedAt,
        pauseReason: crmColdOutboundSettings.pauseReason,
      })
      .from(crmColdOutboundSettings)
      .where(eq(crmColdOutboundSettings.organizationId, organizationId))
      .limit(1);

    const domains = await this.db
      .select({
        sendingDomainId: crmSendingDomains.sendingDomainId,
        domain: crmSendingDomains.domain,
        purpose: crmSendingDomains.purpose,
        verifiedAt: crmSendingDomains.verifiedAt,
        warmupStartedAt: crmSendingDomains.warmupStartedAt,
      })
      .from(crmSendingDomains)
      .where(eq(crmSendingDomains.organizationId, organizationId));

    return {
      /** A tenant with no row has never enabled it, which is not the same as off. */
      enabled: settings?.enabled ?? false,
      enabledAt: settings?.enabledAt ?? null,
      pausedAt: settings?.pausedAt ?? null,
      pauseReason: settings?.pauseReason ?? null,
      domains: domains.map((row) => ({
        ...row,
        /**
         * Returned so the screen can show what to publish without the tenant
         * having to be told it out of band. The id is a UUID nobody outside this
         * organisation has seen, which is what makes publishing it proof.
         */
        verificationRecord:
          row.verifiedAt === null
            ? { name: `${VERIFY_PREFIX}.${row.domain}`, value: `${VERIFY_KEY}=${row.sendingDomainId}` }
            : null,
      })),
    };
  }

  /**
   * Register a domain. Unverified, always — this records a claim, not a fact.
   *
   * A cold domain that shares a registrable domain with the transactional sender
   * defeats the separation the two purposes exist for, but that check lives in
   * `evaluateColdGate` where the send happens; refusing it here as well would put
   * the same rule in two places.
   */
  async registerDomain(
    organizationId: string,
    input: { domain: string; purpose: SendingDomainPurpose },
  ) {
    const domain = input.domain.trim().toLowerCase();

    try {
      const [row] = await this.db
        .insert(crmSendingDomains)
        .values({ organizationId, domain, purpose: input.purpose })
        .returning({ sendingDomainId: crmSendingDomains.sendingDomainId });

      return {
        sendingDomainId: row!.sendingDomainId,
        domain,
        purpose: input.purpose,
        verificationRecord: {
          name: `${VERIFY_PREFIX}.${domain}`,
          value: `${VERIFY_KEY}=${row!.sendingDomainId}`,
        },
      };
    } catch (error) {
      /**
       * Two unique indexes can refuse this: the same domain twice, and a second
       * `cold` domain. Drizzle wraps the driver error, so the SQLSTATE is on
       * `cause` rather than on the error itself.
       */
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === "23505")
        throw new ConflictException(
          input.purpose === "cold"
            ? "That domain is already registered, or this organisation already has a cold sending domain."
            : "That domain is already registered.",
        );
      throw error;
    }
  }

  /**
   * Prove the tenant controls the domain, by reading DNS rather than believing them.
   *
   * `verified_at` is documented as "DNS proved", and an endpoint that let a
   * caller assert it would let one tenant register a domain they do not own and
   * send cold mail from somebody else's reputation. So this is the only way the
   * column is ever written, and it writes it only after the record is found.
   */
  async verifyDomain(organizationId: string, sendingDomainId: string) {
    const domain = await this.loadDomain(organizationId, sendingDomainId);
    if (domain.verifiedAt !== null) return { verified: true, verifiedAt: domain.verifiedAt };

    const name = `${VERIFY_PREFIX}.${domain.domain}`;
    const expected = `${VERIFY_KEY}=${sendingDomainId}`;

    let records: string[][];
    try {
      records = await this.withTimeout(resolveTxt(name));
    } catch (error) {
      /**
       * NXDOMAIN and a resolver outage are the same answer to the tenant — the
       * record is not readable — and telling them apart would only invite a
       * retry against a nameserver that is not the problem.
       */
      this.logger.warn(
        `could not read ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException(
        `No ${VERIFY_PREFIX} TXT record could be read for ${domain.domain}. Publish "${expected}" at ${name} and try again — DNS can take a few minutes to propagate.`,
      );
    }

    // A TXT record arrives as chunks that must be joined before comparing.
    const found = records.some((chunks) => chunks.join("").trim() === expected);
    if (!found)
      throw new BadRequestException(
        `The TXT record at ${name} does not carry this domain's value. It must read exactly "${expected}".`,
      );

    const verifiedAt = new Date();
    await this.db
      .update(crmSendingDomains)
      .set({ verifiedAt })
      .where(
        and(
          eq(crmSendingDomains.organizationId, organizationId),
          eq(crmSendingDomains.sendingDomainId, sendingDomainId),
        ),
      );

    return { verified: true, verifiedAt };
  }

  /**
   * Start the ramp.
   *
   * Separate from verification because the ramp is a clock: `rampCapFor` counts
   * days from here, so beginning it the moment a domain verifies would spend the
   * early, smallest days of the schedule while the tenant is still deciding
   * whether to run a campaign at all.
   */
  async startWarmup(organizationId: string, sendingDomainId: string) {
    const domain = await this.loadDomain(organizationId, sendingDomainId);

    if (domain.verifiedAt === null)
      throw new ConflictException("That domain is not verified yet, so its warm-up cannot start.");
    if (domain.warmupStartedAt !== null)
      return { warmupStartedAt: domain.warmupStartedAt };

    const warmupStartedAt = new Date();
    await this.db
      .update(crmSendingDomains)
      .set({ warmupStartedAt })
      .where(
        and(
          eq(crmSendingDomains.organizationId, organizationId),
          eq(crmSendingDomains.sendingDomainId, sendingDomainId),
        ),
      );

    return { warmupStartedAt };
  }

  /**
   * Turn the track on.
   *
   * Refused until a warmed cold domain exists, because `evaluateColdGate` would
   * refuse every send anyway and the tenant would be left reading
   * "no warmed sending domain" on a track their screen says is enabled.
   */
  async enable(organizationId: string, userId: string) {
    const [cold] = await this.db
      .select({
        verifiedAt: crmSendingDomains.verifiedAt,
        warmupStartedAt: crmSendingDomains.warmupStartedAt,
      })
      .from(crmSendingDomains)
      .where(
        and(
          eq(crmSendingDomains.organizationId, organizationId),
          eq(crmSendingDomains.purpose, "cold"),
        ),
      )
      .limit(1);

    if (!cold)
      throw new ConflictException(
        "Register a cold sending domain before enabling the track. Cold mail must not go out from the domain your invoices do.",
      );
    if (cold.verifiedAt === null)
      throw new ConflictException("The cold sending domain is not verified yet.");
    if (cold.warmupStartedAt === null)
      throw new ConflictException("The cold sending domain's warm-up has not started yet.");

    const enabledAt = new Date();
    await this.db
      .insert(crmColdOutboundSettings)
      .values({ organizationId, enabled: true, enabledAt, enabledByUserId: userId })
      .onConflictDoUpdate({
        target: crmColdOutboundSettings.organizationId,
        set: { enabled: true, enabledAt, enabledByUserId: userId },
      });

    return { enabled: true, enabledAt };
  }

  /** Turn it off. Leaves any pause in place — the two are different states. */
  async disable(organizationId: string, userId: string) {
    await this.db
      .insert(crmColdOutboundSettings)
      .values({ organizationId, enabled: false, enabledByUserId: userId })
      .onConflictDoUpdate({
        target: crmColdOutboundSettings.organizationId,
        set: { enabled: false, enabledByUserId: userId },
      });

    return { enabled: false };
  }

  /**
   * Clear a pause the send path imposed.
   *
   * `paused_at` is written by `pauseColdTrack` when bounces or complaints cross
   * their ceiling, and its own comment says it is cleared only by a person: a
   * pause that expired on its own would resume sending into whatever caused it.
   * This is that person's hand, and nothing else in the codebase clears it.
   */
  async resume(organizationId: string, userId: string) {
    const cleared = await this.db
      .update(crmColdOutboundSettings)
      .set({ pausedAt: null, pauseReason: null, pausedByUserId: userId })
      .where(eq(crmColdOutboundSettings.organizationId, organizationId))
      .returning({ organizationId: crmColdOutboundSettings.organizationId });

    if (cleared.length === 0) throw new NotFoundException("This organisation has no cold track to resume.");
    return { resumed: true };
  }

  private async loadDomain(organizationId: string, sendingDomainId: string) {
    const [row] = await this.db
      .select({
        domain: crmSendingDomains.domain,
        verifiedAt: crmSendingDomains.verifiedAt,
        warmupStartedAt: crmSendingDomains.warmupStartedAt,
      })
      .from(crmSendingDomains)
      .where(
        and(
          eq(crmSendingDomains.organizationId, organizationId),
          eq(crmSendingDomains.sendingDomainId, sendingDomainId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Sending domain not found");
    return row;
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS).unref(),
      ),
    ]);
  }
}
