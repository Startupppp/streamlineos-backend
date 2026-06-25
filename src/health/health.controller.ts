import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";

@Controller("health")
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" | "degraded" }> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ready" };
    } catch {
      return { status: "degraded" };
    }
  }
}
