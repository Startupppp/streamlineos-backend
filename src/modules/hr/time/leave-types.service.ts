import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { leavePolicies, leaveRequests, leaveTypes } from "../../../db/schema";
import {
  DEFAULT_LEAVE_TYPES,
  provisionEmployeeSelfService,
} from "../../../common/org/provision-employee-self-service";
import type { CreateLeaveTypeInput, UpdateLeaveTypeInput } from "./dto/leaves.schemas";

@Injectable()
export class LeaveTypesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      orderBy: [asc(leaveTypes.name)],
      limit: 100,
    });
  }

  async seedDefaults(orgId: string) {
    const seeded = await this.db.transaction((tx) =>
      provisionEmployeeSelfService(tx, orgId),
    );
    return { seeded, skipped: DEFAULT_LEAVE_TYPES.length - seeded };
  }

  async update(orgId: string, leaveTypeId: number, patch: UpdateLeaveTypeInput) {
    if (patch.name) {
      const clash = await this.db.query.leaveTypes.findFirst({
        where: and(eq(leaveTypes.orgId, orgId), eq(leaveTypes.name, patch.name.trim())),
        columns: { id: true },
      });
      if (clash && clash.id !== leaveTypeId) {
        throw new ConflictException("A leave type with this name already exists");
      }
    }

    const [updated] = await this.db
      .update(leaveTypes)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.daysPerYear !== undefined ? { daysPerYear: patch.daysPerYear } : {}),
        ...(patch.carryForward !== undefined ? { carryForward: patch.carryForward } : {}),
      })
      .where(and(eq(leaveTypes.id, leaveTypeId), eq(leaveTypes.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Leave type not found");
    return updated;
  }

  async delete(orgId: string, leaveTypeId: number) {
    const [type] = await this.db
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(and(eq(leaveTypes.id, leaveTypeId), eq(leaveTypes.orgId, orgId)))
      .limit(1);
    if (!type) throw new NotFoundException("Leave type not found");

    const request = await this.db.query.leaveRequests.findFirst({
      where: and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.leaveTypeId, leaveTypeId)),
      columns: { id: true },
    });
    if (request) {
      throw new ConflictException(
        "This leave type has leave requests and cannot be deleted. Edit it instead.",
      );
    }

    const policy = await this.db.query.leavePolicies.findFirst({
      where: and(eq(leavePolicies.orgId, orgId), eq(leavePolicies.leaveTypeId, leaveTypeId)),
      columns: { id: true },
    });
    if (policy) {
      throw new ConflictException(
        "This leave type has policies attached. Delete or reassign the policies first.",
      );
    }

    await this.db
      .delete(leaveTypes)
      .where(and(eq(leaveTypes.id, leaveTypeId), eq(leaveTypes.orgId, orgId)));
    return { success: true };
  }

  async create(orgId: string, input: CreateLeaveTypeInput) {
    const existing = await this.db.query.leaveTypes.findFirst({
      where: and(eq(leaveTypes.orgId, orgId), eq(leaveTypes.name, input.name.trim())),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException("A leave type with this name already exists");
    }

    const [created] = await this.db
      .insert(leaveTypes)
      .values({
        orgId,
        name: input.name.trim(),
        daysPerYear: input.daysPerYear,
        carryForward: input.carryForward ?? false,
      })
      .returning();
    return created;
  }
}
