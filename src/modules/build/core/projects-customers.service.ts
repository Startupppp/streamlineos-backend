import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { crmOrganizations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ListProjectCustomersInput } from "./dto/projects-customers.schemas";

@Injectable()
export class ProjectsCustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, params: ListProjectCustomersInput) {
    const { page, limit, search } = params;
    const offset = (page - 1) * limit;

    const where = and(
      eq(crmOrganizations.orgId, orgId),
      search ? ilike(crmOrganizations.name, `%${search}%`) : undefined,
    );

    const [organizations, countRow] = await Promise.all([
      this.db
        .select({
          id: crmOrganizations.id,
          name: crmOrganizations.name,
          domain: crmOrganizations.domain,
          industry: crmOrganizations.industry,
          size: crmOrganizations.size,
          website: crmOrganizations.website,
          linkedinUrl: crmOrganizations.linkedinUrl,
          description: crmOrganizations.description,
          createdAt: crmOrganizations.createdAt,
        })
        .from(crmOrganizations)
        .where(where)
        .orderBy(desc(crmOrganizations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(crmOrganizations)
        .where(where)
        .then((rows) => rows[0]),
    ]);

    const totalCount = Number(countRow?.count ?? 0);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);

    return { organizations, totalCount, page, totalPages };
  }
}
