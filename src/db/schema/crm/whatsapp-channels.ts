import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * An organisation's WhatsApp business line, as the ingress endpoint meets it.
 *
 * The adapter next door was written against a `WhatsAppChannelBinding` that was
 * passed in rather than looked up, because where it lived was an open question:
 * `user_integration_connections.toolkit` is a closed union over `gmail`,
 * `outlook` and `googlecalendar`, so a WhatsApp line cannot be a row there
 * without widening a column three other adapters depend on. This is the
 * narrower answer — a table that holds exactly what a delivery needs to be
 * verified and filed, and nothing that could act on the organisation's behalf.
 *
 * What is deliberately absent is a provider access token. Sending, and the
 * media download the adapter stops short of, both go through Composio's
 * connected account, where those credentials stay. A leak of this whole table
 * lets an attacker forge inbound messages into a timeline; it does not let them
 * send one, read the org's history, or reach anything outside the CRM.
 */
export const crmWhatsappChannels = pgTable(
  "crm_whatsapp_channels",
  {
    crmWhatsappChannelId: text("crm_whatsapp_channel_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * `metadata.phone_number_id` — the provider's handle for the line.
     *
     * This is the field a delivery is matched on, and matching is the whole of
     * the tenant decision: on a shared Meta app every tenant's delivery is
     * signed with the same app secret, so the signature proves the provider
     * sent the body and says nothing about who it is for.
     */
    businessPhoneNumberId: text("business_phone_number_id").notNull(),
    /** The business's own number, as the other end of the participant pair. */
    businessNumber: text("business_number").notNull(),

    /**
     * The app secret the provider signs deliveries with, encrypted at rest.
     *
     * Authenticates the provider to us and nothing else — it cannot be used to
     * act as the organisation anywhere. Encrypted anyway, because a forged
     * inbound message lands on a real customer's timeline and is read as if a
     * person sent it.
     */
    appSecret: text("app_secret").notNull(),
    /**
     * What the subscription handshake echoes back, encrypted at rest.
     *
     * Meta's `GET ?hub.verify_token=` is a one-time proof that whoever
     * configured the callback URL also controls this deployment. Per channel
     * rather than per deployment: a deployment-wide token makes one
     * integrator's leak a key to every tenant's subscription.
     */
    verifyToken: text("verify_token"),

    /**
     * A person can stop a line feeding the CRM without unsubscribing it at the
     * provider, which is a different decision made in a different place.
     */
    enabled: boolean("enabled").default(true).notNull(),

    /**
     * The honesty surface.
     *
     * A channel that verifies every delivery and files nothing is
     * indistinguishable from a quiet week from the outside — which is the
     * failure this adapter was built to make impossible. `lastNote` carries the
     * adapter's own explanation of the last delivery that produced no
     * activities, so the answer is on the channel rather than in a log.
     */
    lastDeliveryAt: timestamp("last_delivery_at"),
    lastAcceptedAt: timestamp("last_accepted_at"),
    lastNote: text("last_note"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Globally unique, not unique per organisation.
     *
     * The lookup that reads this runs before any tenant is known — that is the
     * point of it — so two rows claiming the same line would make the tenant a
     * function of row order. One line belongs to one organisation, and the
     * database is where that is true rather than where it is hoped.
     */
    uniqueIndex("uniq_crm_whatsapp_channel_line").on(t.businessPhoneNumberId),
    uniqueIndex("uniq_crm_whatsapp_channel_org_line").on(t.organizationId, t.businessPhoneNumberId),
    index("idx_crm_whatsapp_channel_org")
      .on(t.organizationId)
      .where(sql`${t.enabled} = true`),
  ],
);
