import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmWhatsappChannels } from "../../../db/schema";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecretHint,
} from "../../../common/security/secret-encryption.util";
import type {
  CreateWhatsappChannelInput,
  RotateWhatsappChannelInput,
  UpdateWhatsappChannelInput,
} from "../dto/whatsapp-channel.schemas";
import type { WhatsAppAcceptOutcome, WhatsAppChannelBinding } from "./whatsapp-ingress.service";

/**
 * Finding the business line an unauthenticated delivery arrived on.
 *
 * The ordering here is the security argument, and it is the mailbox push
 * endpoint's argument next door: the row is located from what the delivery
 * names, that row's **own** secret verifies the body, and the tenant is read
 * from the row. The body's opinion about tenancy is never consulted, because a
 * caller who signs correctly for a line they control still must not be able to
 * name somebody else's organisation.
 *
 * Two steps rather than one, because the table is behind `tenant_isolation` and
 * this runs before any tenant is known. `app.resolve_whatsapp_channel_org_id`
 * (0657) is a SECURITY DEFINER function returning nothing but the org id; the
 * secret is then read inside a real tenant transaction, under the policy, like
 * every other row in the system. The alternative — an id-keyed arm on the
 * policy itself — would open the whole row, `app_secret` included, to any
 * unguarded query anyone writes against this table later.
 */

/** A channel, resolved far enough to verify a delivery against it. */
export interface ResolvedWhatsAppChannel {
  readonly crmWhatsappChannelId: string;
  readonly binding: WhatsAppChannelBinding;
  /** Present only on the handshake path; never returned to a delivery. */
  readonly verifyToken: string | null;
}

/**
 * Secrets are `enc:v1:` ciphertext from the day this table was created, so the
 * fallback is not for old rows — it is for a fixture or a seed that wrote a
 * plaintext value. Reading through this rather than assuming either form is
 * what the webhooks dispatcher does, and for the same reason: verifying against
 * the wrong value rejects every genuine delivery, silently.
 */
function readSecret(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

@Injectable()
export class WhatsAppChannelsService {
  private readonly logger = new Logger("WhatsAppChannels");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The line a delivery says it arrived on.
   *
   * `phone_number_id` comes out of a body signed by the provider rather than by
   * the organisation, so on a shared Meta app it is attacker-influenced in the
   * sense that any tenant on that app can emit it. It is used to *find* a
   * candidate row and for nothing else — the signature is then checked against
   * that row's secret, and `WhatsAppIngressService.accept` refuses any block
   * whose line does not match the binding it was handed.
   */
  resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedWhatsAppChannel | null> {
    const line = phoneNumberId.trim();
    if (!line) return Promise.resolve(null);

    return this.resolve(
      sql`SELECT app.resolve_whatsapp_channel_org_id(${line}) AS org_id`,
      (channel) => eq(channel.businessPhoneNumberId, line),
    );
  }

  /**
   * The line a callback URL names.
   *
   * The subscription handshake carries no phone number id — only
   * `hub.verify_token` — so the channel has to be in the URL for the handshake
   * to be answerable at all.
   */
  resolveByChannelId(channelId: string): Promise<ResolvedWhatsAppChannel | null> {
    const id = channelId.trim();
    if (!id) return Promise.resolve(null);

    return this.resolve(
      sql`SELECT app.resolve_whatsapp_channel_org_id_by_id(${id}) AS org_id`,
      (channel) => eq(channel.crmWhatsappChannelId, id),
    );
  }

  /**
   * What the last delivery came to, written onto the channel.
   *
   * A channel that verifies everything and files nothing is the failure mode
   * this adapter was built around, and it is invisible from outside — so the
   * adapter's own note about why nothing was filed is stored where an operator
   * looking at the channel will find it, rather than only in a log line nobody
   * is watching.
   *
   * Best-effort on purpose: this is bookkeeping about a delivery that has
   * already been filed, and failing it must not turn a successful ingest into
   * a provider retry.
   */
  async recordDelivery(
    channel: ResolvedWhatsAppChannel,
    outcome: WhatsAppAcceptOutcome,
  ): Promise<void> {
    const now = new Date();
    const delivered = outcome.accepted && outcome.delivered > 0;
    const note = outcome.accepted ? outcome.note : `delivery refused: ${outcome.reason}`;

    try {
      await runInNewTenantTransaction(this.db, channel.binding.organizationId, async (tx) => {
        await tx
          .update(crmWhatsappChannels)
          .set({
            lastDeliveryAt: now,
            ...(delivered ? { lastAcceptedAt: now } : {}),
            lastNote: note,
          })
          .where(
            and(
              eq(crmWhatsappChannels.crmWhatsappChannelId, channel.crmWhatsappChannelId),
              eq(crmWhatsappChannels.organizationId, channel.binding.organizationId),
            ),
          );
      });
    } catch (error) {
      this.logger.warn(
        `could not record the delivery on channel ${channel.crmWhatsappChannelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Point a business line at the CRM.
   *
   * The verify token is generated rather than asked for: it is an arbitrary
   * string whose only job is to prove, once, that whoever configured the
   * callback URL at the provider also controls this deployment. Asking a person
   * to invent one produces "whatsapp" as often as not.
   *
   * The app secret is the opposite — Meta issues it and an operator copies it
   * across, so it arrives as input. It is encrypted on the way in and there is
   * no read path that returns it, here or anywhere: `list` selects columns
   * explicitly and neither secret is among them.
   */
  async create(organizationId: string, input: CreateWhatsappChannelInput) {
    const verifyToken = randomBytes(24).toString("hex");

    /**
     * The line may already be somebody's.
     *
     * `uniq_crm_whatsapp_channel_line` is global, so the conflict this catches
     * can be another organisation's row — which is exactly why the answer says
     * only that the line is taken. Naming the holder would turn creation into a
     * lookup for which businesses use this deployment.
     */
    try {
      return await runInNewTenantTransaction(this.db, organizationId, async (tx) => {
        const [row] = await tx
          .insert(crmWhatsappChannels)
          .values({
            organizationId,
            businessPhoneNumberId: input.businessPhoneNumberId,
            businessNumber: input.businessNumber,
            appSecret: encryptSecret(input.appSecret),
            verifyToken: encryptSecret(verifyToken),
          })
          .returning({
            crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId,
            businessPhoneNumberId: crmWhatsappChannels.businessPhoneNumberId,
            businessNumber: crmWhatsappChannels.businessNumber,
            enabled: crmWhatsappChannels.enabled,
            createdAt: crmWhatsappChannels.createdAt,
          });

        if (!row) throw new NotFoundException("The channel could not be created");

        return {
          ...row,
          /**
           * Shown once. Not stored in readable form and not returned again —
           * rotation is how somebody who lost it carries on.
           */
          verifyToken,
          appSecretHint: maskSecretHint(input.appSecret),
          callbackPath: callbackPathFor(row.crmWhatsappChannelId),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("That WhatsApp business line is already bound");
      throw error;
    }
  }

  /** Every line this organisation has pointed at the CRM. No secrets, ever. */
  async list(organizationId: string) {
    return runInNewTenantTransaction(this.db, organizationId, (tx) =>
      tx
        .select({
          crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId,
          businessPhoneNumberId: crmWhatsappChannels.businessPhoneNumberId,
          businessNumber: crmWhatsappChannels.businessNumber,
          enabled: crmWhatsappChannels.enabled,
          /**
           * The honesty surface, which is the reason this list is worth
           * looking at. A channel that verifies every delivery and files
           * nothing reads as a quiet week from anywhere else.
           */
          lastDeliveryAt: crmWhatsappChannels.lastDeliveryAt,
          lastAcceptedAt: crmWhatsappChannels.lastAcceptedAt,
          lastNote: crmWhatsappChannels.lastNote,
          createdAt: crmWhatsappChannels.createdAt,
        })
        .from(crmWhatsappChannels)
        .where(eq(crmWhatsappChannels.organizationId, organizationId))
        .orderBy(asc(crmWhatsappChannels.businessNumber))
        .limit(100),
    );
  }

  /**
   * A new verify token, and optionally a new app secret.
   *
   * Two secrets with different owners, so they rotate on different occasions:
   * the token is ours and is replaced every time, because re-running the
   * handshake is the only thing anybody rotates it for. The app secret is
   * Meta's, so it is replaced only when the caller supplies the new one —
   * inventing one here would silently stop verifying every genuine delivery.
   */
  async rotate(
    organizationId: string,
    crmWhatsappChannelId: string,
    input: RotateWhatsappChannelInput,
  ) {
    const verifyToken = randomBytes(24).toString("hex");

    return runInNewTenantTransaction(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .update(crmWhatsappChannels)
        .set({
          verifyToken: encryptSecret(verifyToken),
          ...(input.appSecret ? { appSecret: encryptSecret(input.appSecret) } : {}),
        })
        .where(
          and(
            eq(crmWhatsappChannels.crmWhatsappChannelId, crmWhatsappChannelId),
            eq(crmWhatsappChannels.organizationId, organizationId),
          ),
        )
        .returning({ crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId });

      // A channel in another tenant is a channel that does not exist, which is
      // 404 rather than 403 — a 403 would confirm the id.
      if (!row) throw new NotFoundException("Channel not found");

      return {
        crmWhatsappChannelId: row.crmWhatsappChannelId,
        verifyToken,
        ...(input.appSecret ? { appSecretHint: maskSecretHint(input.appSecret) } : {}),
        callbackPath: callbackPathFor(row.crmWhatsappChannelId),
      };
    });
  }

  /**
   * Stop, or restart, a line feeding the CRM.
   *
   * Separate from unsubscribing at the provider, which is a different decision
   * made somewhere else. A disabled channel keeps its row and its line: both
   * resolvers filter on `enabled`, so deliveries stop arriving without the
   * binding being given up.
   */
  async setEnabled(
    organizationId: string,
    crmWhatsappChannelId: string,
    input: UpdateWhatsappChannelInput,
  ) {
    return runInNewTenantTransaction(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .update(crmWhatsappChannels)
        .set({ enabled: input.enabled })
        .where(
          and(
            eq(crmWhatsappChannels.crmWhatsappChannelId, crmWhatsappChannelId),
            eq(crmWhatsappChannels.organizationId, organizationId),
          ),
        )
        .returning({
          crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId,
          enabled: crmWhatsappChannels.enabled,
        });

      if (!row) throw new NotFoundException("Channel not found");
      return row;
    });
  }

  /**
   * Give the line up.
   *
   * The binding goes; everything it ever filed stays. Activities and parties
   * are records of things that happened, and unbinding a phone number is not a
   * claim that they did not. Deleting rather than disabling because the line is
   * globally unique — a row nobody wants would keep the number from ever being
   * bound again, here or by the business that owns it.
   */
  async remove(organizationId: string, crmWhatsappChannelId: string) {
    return runInNewTenantTransaction(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .delete(crmWhatsappChannels)
        .where(
          and(
            eq(crmWhatsappChannels.crmWhatsappChannelId, crmWhatsappChannelId),
            eq(crmWhatsappChannels.organizationId, organizationId),
          ),
        )
        .returning({ crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId });

      if (!row) throw new NotFoundException("Channel not found");
      return { crmWhatsappChannelId: row.crmWhatsappChannelId, removed: true };
    });
  }

  private async resolve(
    orgQuery: ReturnType<typeof sql>,
    match: (channel: typeof crmWhatsappChannels) => ReturnType<typeof eq>,
  ): Promise<ResolvedWhatsAppChannel | null> {
    const rows = await this.db.execute(orgQuery);
    const organizationId = rows[0]?.org_id ? String(rows[0].org_id) : null;
    if (!organizationId) return null;

    return runInNewTenantTransaction(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select({
          crmWhatsappChannelId: crmWhatsappChannels.crmWhatsappChannelId,
          organizationId: crmWhatsappChannels.organizationId,
          businessPhoneNumberId: crmWhatsappChannels.businessPhoneNumberId,
          businessNumber: crmWhatsappChannels.businessNumber,
          appSecret: crmWhatsappChannels.appSecret,
          verifyToken: crmWhatsappChannels.verifyToken,
        })
        .from(crmWhatsappChannels)
        .where(and(match(crmWhatsappChannels), eq(crmWhatsappChannels.enabled, true)))
        .limit(1);

      if (!row) return null;

      return {
        crmWhatsappChannelId: row.crmWhatsappChannelId,
        binding: {
          organizationId: row.organizationId,
          businessPhoneNumberId: row.businessPhoneNumberId,
          businessNumber: row.businessNumber,
          appSecret: readSecret(row.appSecret),
        },
        verifyToken: row.verifyToken ? readSecret(row.verifyToken) : null,
      } satisfies ResolvedWhatsAppChannel;
    });
  }
}

/** Where the provider should be told to deliver. */
function callbackPathFor(crmWhatsappChannelId: string): string {
  return `/crm/ingress/whatsapp/${crmWhatsappChannelId}`;
}

/**
 * A duplicate line, whoever holds it.
 *
 * Drizzle wraps the driver's error, so the SQLSTATE is on `.cause` rather than
 * on the error itself — reading `err.code` here would never match and every
 * duplicate would surface as a 500.
 */
function isUniqueViolation(error: unknown): boolean {
  const codeOf = (value: unknown): string | undefined =>
    typeof value === "object" && value !== null && "code" in value
      ? String((value as { code?: unknown }).code)
      : undefined;

  return (
    codeOf(error) === "23505" ||
    codeOf((error as { cause?: unknown } | null)?.cause) === "23505"
  );
}
