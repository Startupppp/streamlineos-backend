import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { rosters, rosterEntries } from "../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireOrganizationMembershipId } from "./organization-membership";

@Injectable()
export class RostersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listRosters(orgId: string) {
    return this.db.select().from(rosters).where(eq(rosters.orgId, orgId)).orderBy(desc(rosters.weekStart)).limit(52);
  }

  async createRoster(orgId: string, createdBy: string, data: { name: string; weekStart: string; weekEnd: string }) {
    const [roster] = await this.db.insert(rosters).values({ orgId, createdBy, ...data }).returning();
    return roster;
  }

  async getRosterEntries(orgId: string, rosterId: number) {
    const roster = await this.db.query.rosters.findFirst({
      where: and(eq(rosters.id, rosterId), eq(rosters.orgId, orgId)),
      columns: { id: true },
    });
    if (!roster) throw new NotFoundException("Roster not found");
    return this.db
      .select()
      .from(rosterEntries)
      .where(and(eq(rosterEntries.orgId, orgId), eq(rosterEntries.rosterId, rosterId)))
      .limit(5000);
  }

  async upsertRosterEntry(orgId: string, data: { rosterId: number; userId: string; shiftId?: number; date: string; isDayOff?: boolean; notes?: string }) {
    const roster = await this.db.query.rosters.findFirst({
      where: and(eq(rosters.id, data.rosterId), eq(rosters.orgId, orgId)),
      columns: { id: true },
    });
    if (!roster) throw new NotFoundException("Roster not found");
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, data.userId);
    const [entry] = await this.db.insert(rosterEntries).values({ ...data, orgId, userMembershipId })
      .onConflictDoUpdate({ target: [rosterEntries.orgId, rosterEntries.rosterId, rosterEntries.userMembershipId, rosterEntries.date], set: { shiftId: data.shiftId, isDayOff: data.isDayOff, notes: data.notes, userMembershipId } })
      .returning();
    return entry;
  }

  async publishRoster(orgId: string, id: number) {
    const [roster] = await this.db.update(rosters).set({ status: "PUBLISHED" })
      .where(and(eq(rosters.id, id), eq(rosters.orgId, orgId)))
      .returning();
    if (!roster) throw new NotFoundException("Roster not found");
    return roster;
  }
}
