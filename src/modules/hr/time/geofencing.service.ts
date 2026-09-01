import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { geofences } from "../../../db/schema";
import { eq, and } from "drizzle-orm";

@Injectable()
export class GeofencingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db
      .select()
      .from(geofences)
      .where(and(eq(geofences.orgId, orgId), eq(geofences.isActive, true)))
      .limit(100);
  }

  async create(orgId: string, data: { name: string; lat: string; lng: string; radiusMeters?: number }) {
    const [fence] = await this.db.insert(geofences).values({ orgId, ...data }).returning();
    return fence;
  }

  async update(orgId: string, id: number, data: Partial<typeof geofences.$inferInsert>) {
    const [fence] = await this.db.update(geofences).set({ ...data, updatedAt: new Date() })
      .where(and(eq(geofences.id, id), eq(geofences.orgId, orgId))).returning();
    if (!fence) throw new NotFoundException("Geofence not found");
    return fence;
  }

  async remove(orgId: string, id: number) {
    await this.db.update(geofences).set({ isActive: false }).where(and(eq(geofences.id, id), eq(geofences.orgId, orgId)));
  }
}
