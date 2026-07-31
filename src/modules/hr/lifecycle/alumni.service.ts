import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { alumniProfiles, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { AlumniCreateInput } from "./dto/hr-lifecycle.schemas";

@Injectable()
export class AlumniService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, limit: number) {
    return this.db.query.alumniProfiles.findMany({
      where: eq(alumniProfiles.orgId, orgId),
      with: { user: { columns: { name: true, email: true, image: true } } },
      orderBy: [desc(alumniProfiles.createdAt)],
      limit,
    });
  }

  async create(orgId: string, input: AlumniCreateInput) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, input.userId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
      with: { user: { columns: { isActive: true } } },
    });

    if (!member) throw new NotFoundException("Employee not found in this organization");
    if (member.user?.isActive) {
      throw new BadRequestException("Cannot add an active employee as alumni. Employee must be separated first.");
    }

    const existing = await this.db.query.alumniProfiles.findFirst({
      where: and(eq(alumniProfiles.userId, input.userId), eq(alumniProfiles.orgId, orgId)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("This employee is already in the alumni network.");

    const [record] = await this.db
      .insert(alumniProfiles)
      .values({
        orgId,
        userId: input.userId,
        currentCompany: input.currentCompany ?? null,
        currentRole: input.currentRole ?? null,
        linkedinUrl: input.linkedinUrl || null,
        email: input.email || null,
        leftDate: input.leftDate ?? null,
        isOptedIn: input.isOptedIn ?? true,
      })
      .returning();

    return record;
  }
}
