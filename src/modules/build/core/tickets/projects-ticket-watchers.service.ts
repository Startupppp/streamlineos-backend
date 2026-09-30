import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  organizationPeople,
  ticketWatchers,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";
import type { AddWatcherInput } from "../dto/projects.schemas";
import {
  resolvePersonDisplayName,
} from "../../../../common/organization/person-display-name";

@Injectable()
export class ProjectsTicketWatchersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

  async getWatchers(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const rows = await this.db.query.ticketWatchers.findMany({
      where: and(
        eq(ticketWatchers.ticketId, ticketId),
        eq(ticketWatchers.orgId, u.orgId),
      ),
      columns: { id: true, ticketId: true, createdAt: true },
      with: {
        user: {
          columns: { userId: true },
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                firstName: true,
                lastName: true,
                image: true,
                email: true,
              },
            },
          },
        },
      },
      limit: 100,
    });
    return rows.map(({ user: membership, ...watcher }) => ({
      ...watcher,
      userId: membership?.userId ?? null,
      user: membership?.user ?? null,
    }));
  }

  async addWatcher(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddWatcherInput,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const userId = body.userId ?? u.userId;
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!member)
      throw new NotFoundException("Watcher is not an organization member");
    await this.db
      .insert(ticketWatchers)
      .values({ orgId: u.orgId, ticketId, membershipId: member.id })
      .onConflictDoNothing();
    const [person] = await this.db
      .select({
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        image: organizationPeople.avatarUrl,
      })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.userId, userId),
          eq(organizationPeople.organizationId, u.orgId),
        ),
      )
      .limit(1);
    const name = resolvePersonDisplayName(person ?? {});
    return {
      userId,
      name,
      image: person?.image ?? null,
      membershipId: member.id,
    };
  }

  async removeWatcher(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.userId, u.userId),
        ),
      )
      .limit(1);
    if (!member) return { success: true };
    await this.db
      .delete(ticketWatchers)
      .where(
        and(
          eq(ticketWatchers.orgId, u.orgId),
          eq(ticketWatchers.ticketId, ticketId),
          eq(ticketWatchers.membershipId, member.id),
        ),
      );
    return { success: true };
  }
}
