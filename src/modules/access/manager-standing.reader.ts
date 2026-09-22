import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hasCurrentDirectReport } from "../directory/employment-query";

@Injectable()
export class ManagerStandingReader {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  managesSomeone(orgId: string, userId: string): Promise<boolean> {
    return hasCurrentDirectReport(this.db, orgId, userId);
  }
}
