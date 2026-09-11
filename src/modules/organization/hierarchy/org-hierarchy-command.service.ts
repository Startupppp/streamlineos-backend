import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getTenantContext, runWithTenantContext, withTenant } from "../../../common/tenant";
import { orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  OrgHierarchyDependenciesService,
  type OrgUnitKind,
} from "./org-hierarchy-dependencies.service";

@Injectable()
export class OrgHierarchyCommandService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dependencies: OrgHierarchyDependenciesService,
  ) {}

  async run<T>(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const execute = async () => {
      await this.db.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${orgId}:org-unit:${unitId}`}, 0)
        )
      `);

      const [unit] = await this.db
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.id, unitId),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, kind),
            isNull(orgUnits.deletedAt),
          ),
        )
        .for("update")
        .limit(1);

      if (!unit) throw new NotFoundException("Organization unit not found");

      await this.dependencies.assertCanArchive(orgId, unitId, kind);

      return mutation();
    };

    const context = getTenantContext();
    if (context) {
      if (context.orgId !== orgId) {
        throw new Error("Hierarchy command tenant does not match request tenant");
      }
      return execute();
    }

    const afterCommit: Array<() => Promise<unknown>> = [];
    const result = await withTenant(
      this.db,
      { orgId, audience: "INTERNAL" },
      (tx) =>
        runWithTenantContext(
          { orgId, audience: "INTERNAL", tx, afterCommit },
          execute,
        ),
    );
    await Promise.allSettled(afterCommit.map((hook) => hook()));
    return result;
  }
}
