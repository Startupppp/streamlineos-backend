import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { Public } from "../common/auth/public.decorator";

@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Database is not ready");
    }
  }
}
