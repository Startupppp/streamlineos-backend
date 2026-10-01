import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { buildPortalProjection, type PortalCapabilities } from "./portal-projection";

@Injectable()
export class PortalProjectionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  build(orgId: string, projectId: number, capabilities: PortalCapabilities) {
    return buildPortalProjection(this.db, orgId, projectId, capabilities);
  }
}
