import { and, eq } from "drizzle-orm";
import { deals } from "../../../../db/schema";
import { ANCHOR_PARTY_ID } from "../import-entities";
import type { EntityWriter } from "./entity-writer";

/**
 * Landing a row as a deal sitting in a pipeline stage.
 *
 * "Pipeline" is what the criterion calls this and what the connector seam
 * already called it, and a pipeline export is an Opportunities or Deals file:
 * the rows are deals, and the pipeline is the thing they are moving through.
 * Nobody exports a pipeline definition from a CRM — that is configuration — so
 * reading this as `crm_pipelines` would be an importer with nothing to import.
 *
 * Two things the plan has already decided, and this must not decide again.
 * `amount` arrives as the integer minor units `value_minor` stores, coerced
 * while the row was read so the preview shows the number that will be written.
 * `anchorPartyId` is the customer the file named, resolved against this tenant
 * during planning — `deals.party_id` is nullable, so a deal whose account this
 * organisation does not have still lands, keeping the account name it came with
 * as a custom field rather than being refused.
 *
 * There is no update path, and that is a claim rather than an omission: a deal
 * has no unique business key — two real deals can share a name, a stage and an
 * amount — so `matchStrategyFor("pipeline")` is `none` and no `update` row can
 * be planned. Re-importing the same file twice creates twice, which the
 * thirty-day undo covers; inventing a key would merge two genuine deals, which
 * no undo can separate.
 */
export const PIPELINE_WRITER: EntityWriter = {
  async create(tx, context, row) {
    const values = row.values;
    const amount = Number(values.amount ?? "");
    const probability = Number(values.probability ?? "");

    const [deal] = await tx
      .insert(deals)
      .values({
        orgId: context.organizationId,
        name: values.name ?? "",
        // `stage` is free text with its own default, so a file that says
        // nothing keeps the column's answer rather than being given one here.
        stage: values.stage || undefined,
        valueMinor: Number.isFinite(amount) ? amount : undefined,
        probability: Number.isFinite(probability) ? probability : undefined,
        expectedCloseDate: values.closeDate || null,
        nextStep: values.nextStep || null,
        notes: values.notes || null,
        partyId: values[ANCHOR_PARTY_ID] || null,
        pipelineId: context.pipelineId,
        customData: row.customFields ?? null,
      })
      .returning({ id: deals.id });

    if (!deal) throw new Error("insert returned no row");

    // `deals.id` is a `serial`, and every outcome column on an import row is
    // text. Stringified here rather than at the call site so the writer owns the
    // shape of its own identifier.
    return String(deal.id);
  },

  async remove(tx, context, recordId) {
    const id = Number(recordId);
    if (!Number.isInteger(id)) throw new Error(`not a deal identifier: ${recordId}`);

    await tx
      .update(deals)
      .set({ deletedAt: new Date() })
      .where(and(eq(deals.orgId, context.organizationId), eq(deals.id, id)));
  },
};
