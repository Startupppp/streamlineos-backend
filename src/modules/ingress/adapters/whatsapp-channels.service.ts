import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmWhatsappChannels } from "../../../db/schema";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../../common/security/secret-encryption.util";
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
