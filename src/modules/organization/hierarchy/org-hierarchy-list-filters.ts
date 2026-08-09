import { eq, ne } from "drizzle-orm";
import { orgUnits } from "../../../db/schema/common/organization";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";

export function getOrgUnitStatusFilter(status: ListQueryInput["status"]) {
  if (status === "CURRENT") return ne(orgUnits.status, "ARCHIVED");
  return status ? eq(orgUnits.status, status) : undefined;
}
