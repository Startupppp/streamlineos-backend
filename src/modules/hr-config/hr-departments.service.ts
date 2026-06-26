import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { departments } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class HrDepartmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db.query.departments.findMany({
      where: eq(departments.orgId, orgId),
    });
  }

  async create(orgId: string, name: string) {
    await this.db.insert(departments).values({ name: name.trim(), orgId });
    return { success: true };
  }
}
