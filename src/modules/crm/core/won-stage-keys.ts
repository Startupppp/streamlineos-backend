import { and, eq } from "drizzle-orm";
import { crmPipelineStages } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

/**
 * Which stage keys mean "won", for this organisation, in one place.
 *
 * A tenant names its own stages on `crm_pipeline_stages`, so "won" is tenant
 * data rather than a constant; the literal fallback covers an organisation that
 * has deals but has never configured a pipeline, where every row still sits on
 * the seeded key. That fallback is part of the definition, not a defensive
 * shrug — without it a pre-configuration org reports zero won revenue rather
 * than the revenue it actually closed.
 *
 * It is a shared function rather than a method because two reports now need it:
 * the shipped first/last-touch SQL report and the multi-touch report in
 * `modules/attribution`. A second copy is precisely how two attribution numbers
 * over the same quarter come to disagree about which deals closed — the failure
 * `attribution-models.ts` opens by describing.
 */
export async function resolveWonStageKeys(db: Db, orgId: string): Promise<string[]> {
  const wonStages = await db
    .select({ key: crmPipelineStages.key })
    .from(crmPipelineStages)
    .where(
      and(
        eq(crmPipelineStages.orgId, orgId),
        eq(crmPipelineStages.stageType, "won"),
      ),
    );
  return wonStages.length ? wonStages.map((s) => s.key) : ["WON", "Closed Won"];
}
