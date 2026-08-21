import { BadRequestException } from "@nestjs/common";
import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { orgUnits } from "../../../db/schema/common/organization";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";

export const orgUnitNormalizedName = sql<string>`lower(${orgUnits.name})`;

export function getOrgUnitStatusFilter(status: ListQueryInput["status"]) {
  if (status === "CURRENT") return ne(orgUnits.status, "ARCHIVED");
  return status ? eq(orgUnits.status, status) : undefined;
}

type OrgUnitListCursor = { name: string; id: string };

function decodeOrgUnitCursor(value: string): OrgUnitListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { name?: unknown }).name !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      !(parsed as { id: string }).id
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      name: (parsed as { name: string }).name,
      id: (parsed as { id: string }).id,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_ORG_UNIT_CURSOR",
      message: "The organization list cursor is invalid or expired.",
    });
  }
}

export function getOrgUnitCursorFilter(value: string | undefined) {
  if (!value) return undefined;
  const cursor = decodeOrgUnitCursor(value);
  return or(
    gt(orgUnitNormalizedName, cursor.name),
    and(eq(orgUnitNormalizedName, cursor.name), gt(orgUnits.id, cursor.id)),
  );
}

export function encodeOrgUnitCursor(row: { name: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({ v: 1, name: row.name.toLowerCase(), id: row.id }),
    "utf8",
  ).toString("base64url");
}

export function toOrgUnitCursorPage<TRow extends { name: string; id: string }, TData>(
  rows: TRow[],
  limit: number,
  mapRow: (row: TRow) => TData,
) {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);

  return {
    data: pageRows.map(mapRow),
    pageInfo: {
      limit,
      hasMore,
      nextCursor: hasMore && lastRow ? encodeOrgUnitCursor(lastRow) : null,
    },
  };
}
