import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { businessParties } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

export async function assertPartyInOrg(db: Db, organizationId: string, partyId: string): Promise<void> {
  const party = await db.query.businessParties.findFirst({
    columns: { partyId: true },
    where: and(eq(businessParties.partyId, partyId), eq(businessParties.organizationId, organizationId)),
  });
  if (!party) throw new NotFoundException("Party not found");
}
