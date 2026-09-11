import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  crmContactChannelConsent,
  crmContactConsentEvents,
  crmSuppressionHashes,
} from "../../../../db/schema";
import { businessParties } from "../../../../db/schema/party";
import { isLegacyResolved, resolveLegacyParty } from "../../../party/party-legacy-seam";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { AuditService } from "../../../../common/audit/audit.service";
import { hashAddress } from "./crm-consent-suppression";
import type { ConsentRecordInput } from "./crm-consent.types";

/**
 * The address-only copy of an opt-out, for a contact we still have.
 *
 * Takes the transaction rather than opening one: the caller is recording the
 * opt-out, and the two must commit together or not at all.
 *
 * Silently does nothing when the contact has no address — there is nothing to
 * suppress, and a contact can legitimately have none. Not an error, because
 * it must never be the reason an opt-out fails to record.
 *
 * Keyed on the Party the guard above already resolved, not on the contact id:
 * re-entering through `contact_party_map` would be a second answer to a
 * question this transaction has answered, and two lookups can disagree.
 */
async function retainSuppressionForContact(
  tx: Parameters<Parameters<typeof runInTenantTransaction>[1]>[0],
  orgId: string,
  partyId: string,
  reason: string,
): Promise<void> {
  const [row] = await tx
    .select({ email: businessParties.email })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, orgId),
        eq(businessParties.partyId, partyId),
      ),
    )
    .limit(1);

  const normalised = row?.email?.trim().toLowerCase();
  if (!normalised) return;

  await tx
    .insert(crmSuppressionHashes)
    .values({
      orgId,
      channel: "EMAIL",
      addressHash: hashAddress(normalised),
      reason,
    })
    .onConflictDoNothing();
}

/**
 * The transaction behind `CrmConsentService.record`, run on the service's own
 * handle: the current position, its event, the durable suppression copy and the
 * audit entry commit together or not at all.
 */
export async function recordConsentChange(
  db: Db,
  audit: AuditService,
  orgId: string,
  input: ConsentRecordInput,
): Promise<void> {
  await runInTenantTransaction(
    db,
    async (tx) => {
      /**
       * The contact has to be this organisation's. The id arrives from a
       * signed unsubscribe token or a route parameter, and neither proves
       * which tenant owns it: a token minted for one organisation can name
       * another's contact id. The tenant key on the consent row refuses that
       * write, but as a 500 from the database. Checked here instead, before
       * anything is written, so a contact outside the organisation is a 404
       * on the signed-in route and a silent no-op behind the public link.
       *
       * Through the legacy seam rather than a join of its own on
       * `contact_party_map`: the map row outlives a soft delete, so reading it
       * directly answers "this id was mapped once", not "this contact is still
       * here". The seam carries the Party's `deletedAt` back with the answer,
       * and an erased contact is as absent here as a foreign one.
       */
      const resolved = await resolveLegacyParty(tx, orgId, {
        kind: "CONTACT",
        legacyId: input.contactId,
      });
      if (!isLegacyResolved(resolved) || resolved.party.deletedAt)
        throw new NotFoundException("Contact not found");

      const [existing] = await tx
        .select({ status: crmContactChannelConsent.status })
        .from(crmContactChannelConsent)
        .where(
          and(
            eq(crmContactChannelConsent.orgId, orgId),
            eq(crmContactChannelConsent.contactId, input.contactId),
            eq(crmContactChannelConsent.channel, input.channel),
          ),
        )
        .limit(1);

      await tx
        .insert(crmContactChannelConsent)
        .values({
          orgId,
          contactId: input.contactId,
          channel: input.channel,
          status: input.status,
          source: input.source,
          legalBasis: input.legalBasis ?? null,
          sourceDetail: input.sourceDetail ?? null,
          expiresAt: input.expiresAt ?? null,
          recordedByUserId: input.recordedByUserId ?? null,
        })
        .onConflictDoUpdate({
          target: [
            crmContactChannelConsent.orgId,
            crmContactChannelConsent.contactId,
            crmContactChannelConsent.channel,
          ],
          set: {
            status: input.status,
            source: input.source,
            legalBasis: input.legalBasis ?? null,
            sourceDetail: input.sourceDetail ?? null,
            expiresAt: input.expiresAt ?? null,
            recordedByUserId: input.recordedByUserId ?? null,
            capturedAt: new Date(),
            updatedAt: new Date(),
          },
        });

      await tx.insert(crmContactConsentEvents).values({
        orgId,
        contactId: input.contactId,
        channel: input.channel,
        fromStatus: existing?.status ?? null,
        toStatus: input.status,
        legalBasis: input.legalBasis ?? null,
        source: input.source,
        sourceDetail: input.sourceDetail ?? null,
        recordedByUserId: input.recordedByUserId ?? null,
      });

      /**
       * CRM-P1-11. An opt-out has to outlive the row it was captured on.
       *
       * `crm_contact_channel_consent` is keyed on `contact_id`, so a contact
       * erased under a DPDP request takes its opt-out with it — and if the
       * same address is imported again, both suppression readers find nothing
       * and mail resumes to somebody who withdrew consent.
       *
       * `crm_suppression_hashes` exists precisely to survive that, and both
       * readers already union it in: `CrmConsentService.suppressedEmails`, and
       * `OutboundService.isSuppressed` at send time. Nothing had ever written
       * a row, so that half of both queries was permanently empty and the
       * union added nothing at all.
       *
       * Written in the same transaction as the consent row, because an
       * opt-out recorded without its durable copy is the exact state this is
       * meant to prevent.
       *
       * EMAIL only, deliberately: both readers filter `channel = 'EMAIL'`,
       * and writing phone hashes nothing reads would be storing a fact with
       * no consumer — the shape of the bug being fixed here.
       */
      if (input.status === "OPTED_OUT" && input.channel === "EMAIL") {
        await retainSuppressionForContact(
          tx,
          orgId,
          resolved.party.partyId,
          `consent:${input.source}`,
        );
      }

      /**
       * The public unsubscribe endpoint has no signed-in user, so this is the
       * unattributed case: a null actor naming the capture path that acted.
       * It used to write the string "system", which has no row in `users`, so
       * this awaited `logCritical` raised a foreign-key violation and rolled
       * back the opt-out and its suppression hash along with it — clicking
       * the unsubscribe link recorded nothing at all.
       */
      const auditEntry = {
        action: "crm.consent.recorded",
        orgId,
        targetId: String(input.contactId),
        targetType: "crm_contact_consent",
        metadata: {
          channel: input.channel,
          from: existing?.status ?? null,
          to: input.status,
          source: input.source,
          legalBasis: input.legalBasis ?? null,
        },
      };

      await audit.logCritical(
        input.recordedByUserId
          ? { ...auditEntry, userId: input.recordedByUserId }
          : { ...auditEntry, systemActor: `crm.consent.${input.source}` },
      );
    },
    { orgId },
  );
}
