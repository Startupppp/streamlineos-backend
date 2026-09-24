import { HttpException, HttpStatus } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { orgUnits } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import type { SetDocumentAudiencesInput } from "./dto/document-classification.schemas";
import type { PublishBlocker } from "./documents-helpers";

export type AudienceKey = { kind: "ALL_EMPLOYEES" | "DEPARTMENT" | "LOCATION"; refId: string | null };

export const audienceKey = (audience: AudienceKey): string => `${audience.kind}:${audience.refId ?? ""}`;

/** The same audience twice is one audience; `ALL_EMPLOYEES` never carries a ref, whatever the caller sent. */
export function dedupeAudiences(entries: SetDocumentAudiencesInput["audiences"]): AudienceKey[] {
  const seen = new Map<string, AudienceKey>();
  for (const entry of entries) {
    const audience: AudienceKey = { kind: entry.kind, refId: entry.kind === "ALL_EMPLOYEES" ? null : (entry.refId ?? null) };
    seen.set(audienceKey(audience), audience);
  }
  return [...seen.values()];
}

/**
 * A department or location in an audience must be a live unit of the same kind in THIS tenant. An id from
 * another tenant, a deleted one, and one of the wrong kind all read as "not found", which is all the caller is
 * told: the answer must not confirm that another tenant's unit exists.
 */
export async function assertAudienceTargetsExist(
  reader: Pick<TenantTx, "select">,
  orgId: string,
  wanted: readonly AudienceKey[],
): Promise<void> {
  const ids = [...new Set(wanted.flatMap((audience) => (audience.refId === null ? [] : [audience.refId])))];
  if (ids.length === 0) return;
  const units = await reader
    .select({ id: orgUnits.id, kind: orgUnits.kind })
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), inArray(orgUnits.id, ids)))
    .limit(ids.length);
  const kindById = new Map(units.map((unit) => [unit.id, unit.kind]));
  const missing = wanted.filter((audience) => audience.refId !== null && kindById.get(audience.refId) !== audience.kind);
  if (missing.length === 0) return;
  throw new HttpException(
    {
      code: "AUDIENCE_TARGET_NOT_FOUND",
      message: "A department or location in the audience does not exist.",
      details: { missing: missing.map((audience) => ({ kind: audience.kind, refId: audience.refId })) },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

export function notPublishableError(blockers: readonly PublishBlocker[]): HttpException {
  return new HttpException(
    {
      code: "DOCUMENT_NOT_PUBLISHABLE",
      message: "This document cannot be shared with the company.",
      details: { blockers },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
