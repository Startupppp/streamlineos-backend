import { HttpException, HttpStatus } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { orgUnits } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import type { PublishBlocker } from "../../hr/performance/documents-helpers";

export type AudienceKey = { kind: "ALL_EMPLOYEES" | "DEPARTMENT" | "LOCATION"; refId: string | null };

export const audienceKey = (audience: AudienceKey): string => `${audience.kind}:${audience.refId ?? ""}`;

export function dedupeAudiences(entries: ReadonlyArray<{ kind: AudienceKey["kind"]; refId?: string | null }>): AudienceKey[] {
  const seen = new Map<string, AudienceKey>();
  for (const entry of entries) {
    const audience: AudienceKey = { kind: entry.kind, refId: entry.kind === "ALL_EMPLOYEES" ? null : (entry.refId ?? null) };
    seen.set(audienceKey(audience), audience);
  }
  return [...seen.values()];
}

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

export function publishPermissionRequired(): HttpException {
  return new HttpException(
    { code: "PUBLISH_PERMISSION_REQUIRED", message: "Sharing a document with the company needs the permission to publish documents." },
    HttpStatus.FORBIDDEN,
  );
}
