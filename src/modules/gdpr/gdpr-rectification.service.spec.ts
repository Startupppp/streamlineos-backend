import { ConflictException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { GdprRectificationService } from "./gdpr-rectification.service";

function rows<T>(value: T[], conditions: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn((condition: unknown) => {
        conditions.push(condition);
        return { limit: jest.fn().mockResolvedValue(value) };
      }),
    }),
  };
}

function whereParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as SQL).params;
}

function buildService(options: {
  membership?: boolean;
  membershipStatus?: string;
  currentName?: string | null;
  updatedName?: string | null;
} = {}) {
  const membership = options.membership ?? true;
  const membershipStatus = options.membershipStatus ?? "ACTIVE";
  const currentName = options.currentName === undefined ? "Ananya Roy" : options.currentName;
  const updatedName = options.updatedName === undefined ? "Ananya Rao" : options.updatedName;
  const updateReturning = jest.fn().mockResolvedValue(updatedName === null ? [] : [{ name: updatedName }]);
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: updateReturning }),
    }),
  });
  const requestValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 17 }]),
  });
  const auditValues = jest.fn().mockResolvedValue(undefined);
  const conditions: unknown[] = [];
  const insert = jest
    .fn()
    .mockReturnValueOnce({ values: requestValues })
    .mockReturnValueOnce({ values: auditValues });
  const tx = {
    select: jest
      .fn()
      .mockReturnValueOnce(rows(membership ? [{ id: 1, status: membershipStatus }] : [], conditions))
      .mockReturnValueOnce(rows(currentName === undefined ? [] : [{ id: "user-1", name: currentName }], conditions)),
    update,
    insert,
  };
  const db = { transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };
  return { service: new GdprRectificationService(db as unknown as Db), tx, update, requestValues, auditValues, conditions };
}

describe("GdprRectificationService", () => {
  it("applies and verifies a self-service profile-name correction with an auditable completed request", async () => {
    const { service, update, requestValues, auditValues } = buildService();

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" }, "127.0.0.1"),
    ).resolves.toEqual({ requestId: 17, field: "profile.name", changed: true, status: "completed" });

    expect(update).toHaveBeenCalledTimes(1);
    expect(requestValues).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      subjectUserId: "user-1",
      type: "correction",
      status: "completed",
      reason: "profile.name",
    }));
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "gdpr.rectification.completed",
      orgId: "org-1",
      userId: "user-1",
      metadata: expect.objectContaining({ field: "profile.name", changed: true }),
    }));
    expect(JSON.stringify(auditValues.mock.calls[0][0])).not.toContain("Ananya Rao");
  });

  it("refuses a request when the subject is not a member of the active organization", async () => {
    const { service, update, requestValues } = buildService({ membership: false });

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    expect(requestValues).not.toHaveBeenCalled();
  });

  it("binds the membership lookup to active organization membership", async () => {
    const { service, conditions } = buildService();

    await service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" });

    expect(whereParams(conditions[0])).toContain("ACTIVE");
  });

  it("fails closed when the profile changed after it was read", async () => {
    const { service, update, auditValues } = buildService({ currentName: "Ananya Roy", updatedName: null });

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).toHaveBeenCalledWith(expect.anything());
    expect(auditValues).not.toHaveBeenCalled();
  });

  it("fails closed when the updated field cannot be verified", async () => {
    const { service, auditValues } = buildService({ updatedName: "Different name" });

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditValues).not.toHaveBeenCalled();
  });

  it("records an auditable no-change request without rewriting the profile", async () => {
    const { service, update, auditValues } = buildService({ currentName: "Ananya Rao" });

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "Ananya Rao" }),
    ).resolves.toEqual({ requestId: 17, field: "profile.name", changed: false, status: "completed" });

    expect(update).not.toHaveBeenCalled();
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "gdpr.rectification.no_change",
      metadata: expect.objectContaining({ changed: false }),
    }));
  });
});
