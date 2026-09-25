import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class OrgService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getOrgName(orgId: string): Promise<{ name: string; logo: string | null }> {
    const [org] = await this.db
      .select({ name: organizations.name, logo: organizations.logo })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) throw new NotFoundException("Organization not found");
    return { name: org.name, logo: org.logo ?? null };
  }
}
