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

function legalHoldSelect(holdActive: boolean) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(holdActive ? [{ id: 1, reason: "active case" }] : []),
      }),
    }),
  });
}

function buildService(options: {
  membership?: boolean;
  membershipStatus?: string;
  currentName?: string | null;
  updatedName?: string | null;
  holdActive?: boolean;
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
  const db = {
    select: legalHoldSelect(options.holdActive ?? false),
    transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  return { service: new GdprRectificationService(db as unknown as Db), tx, update, requestValues, auditValues, conditions };
}

describe("GdprRectificationService — profile.name", () => {
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

describe("GdprRectificationService — hr_profile.preferred_name", () => {
  function buildOrgPersonService(options: {
    currentPreferredName?: string | null;
    holdActive?: boolean;
    membership?: boolean;
  } = {}) {
    const membership = options.membership ?? true;
    const currentPreferredName = options.currentPreferredName ?? "Ali";
    const requestValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    });
    const auditValues = jest.fn().mockResolvedValue(undefined);
    const updateReturning = jest.fn().mockResolvedValue([{ id: "person-1" }]);
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    });
    const insert = jest
      .fn()
      .mockReturnValueOnce({ values: requestValues })
      .mockReturnValueOnce({ values: auditValues });
    const tx = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(membership ? [{ id: 1, status: "ACTIVE" }] : []),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{
                id: "person-1",
                personalEmail: null,
                phone: null,
                dateOfBirth: null,
                gender: null,
                preferredName: currentPreferredName,
                address: null,
                emergencyContact: null,
              }]),
            }),
          }),
        }),
      update,
      insert,
    };
    const db = {
      select: legalHoldSelect(options.holdActive ?? false),
      transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    return { service: new GdprRectificationService(db as unknown as Db), update, requestValues, auditValues };
  }

  it("corrects preferred_name on organization_people and records the request", async () => {
    const { service, update, requestValues, auditValues } = buildOrgPersonService({ currentPreferredName: "Ali" });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_profile.preferred_name",
      value: "Aliya",
    });

    expect(result).toEqual({ requestId: 42, field: "hr_profile.preferred_name", changed: true, status: "completed" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(requestValues).toHaveBeenCalledWith(expect.objectContaining({ reason: "hr_profile.preferred_name", type: "correction" }));
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "gdpr.rectification.completed",
      metadata: expect.objectContaining({ field: "hr_profile.preferred_name", changed: true }),
    }));
    expect(JSON.stringify(auditValues.mock.calls[0][0])).not.toContain("Aliya");
  });

  it("records no-change when preferred_name is already the requested value", async () => {
    const { service, update } = buildOrgPersonService({ currentPreferredName: "Aliya" });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_profile.preferred_name",
      value: "Aliya",
    });

    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses correction when subject has no active membership", async () => {
    const { service, update } = buildOrgPersonService({ membership: false });

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "hr_profile.preferred_name", value: "Aliya" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("GdprRectificationService — hr_sensitive.bank_details", () => {
  function buildSensitiveService(options: {
    hasPeople?: boolean;
    hasEmployment?: boolean;
    hasSensitive?: boolean;
    currentBankDetails?: string | null;
    holdActive?: boolean;
  } = {}) {
    const hasPeople = options.hasPeople ?? true;
    const hasEmployment = options.hasEmployment ?? true;
    const hasSensitive = options.hasSensitive ?? true;
    const currentBankDetails = options.currentBankDetails ?? "OLD-BANK";
    const requestValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 55 }]),
    });
    const auditValues = jest.fn().mockResolvedValue(undefined);
    const updateReturning = jest.fn().mockResolvedValue([{ id: 10 }]);
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    });
    const insert = jest
      .fn()
      .mockReturnValueOnce({ values: requestValues })
      .mockReturnValueOnce({ values: auditValues });
    const tx = {
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: 1, status: "ACTIVE" }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(hasPeople ? [{ id: 7 }] : []),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(hasEmployment ? [{ id: 99 }] : []),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(hasSensitive ? [{ id: 10, bankDetails: currentBankDetails }] : []),
            }),
          }),
        }),
      update,
      insert,
    };
    const db = {
      select: legalHoldSelect(options.holdActive ?? false),
      transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    return { service: new GdprRectificationService(db as unknown as Db), update, requestValues, auditValues };
  }

  it("corrects bank_details and audits the change without leaking the raw value", async () => {
    const { service, update, requestValues, auditValues } = buildSensitiveService({ currentBankDetails: "OLD-BANK" });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_sensitive.bank_details",
      value: "NEW-BANK-ACC",
    });

    expect(result).toEqual({ requestId: 55, field: "hr_sensitive.bank_details", changed: true, status: "completed" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(requestValues).toHaveBeenCalledWith(expect.objectContaining({ reason: "hr_sensitive.bank_details" }));
    expect(JSON.stringify(auditValues.mock.calls[0][0])).not.toContain("NEW-BANK-ACC");
    expect(JSON.stringify(auditValues.mock.calls[0][0])).not.toContain("OLD-BANK");
  });

  it("returns no-change when no hr_people row exists for the subject", async () => {
    const { service, update } = buildSensitiveService({ hasPeople: false });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_sensitive.bank_details",
      value: "NEW-BANK",
    });

    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns no-change when no primary employment exists", async () => {
    const { service, update } = buildSensitiveService({ hasEmployment: false });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_sensitive.bank_details",
      value: "NEW-BANK",
    });

    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns no-change when no sensitive fields row exists", async () => {
    const { service, update } = buildSensitiveService({ hasSensitive: false });

    const result = await service.rectifyOwnProfile("org-1", "user-1", {
      field: "hr_sensitive.bank_details",
      value: "NEW-BANK",
    });

    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("GdprRectificationService — legal hold blocking", () => {
  it("blocks rectification and does not open a transaction when a legal hold is active", async () => {
    const requestValues = jest.fn();
    const tx = { select: jest.fn(), update: jest.fn(), insert: jest.fn() };
    const db = {
      select: legalHoldSelect(true),
      transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const service = new GdprRectificationService(db as unknown as Db);

    await expect(
      service.rectifyOwnProfile("org-1", "user-1", { field: "profile.name", value: "New Name" }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(requestValues).not.toHaveBeenCalled();
  });
});

describe("GdprRectificationService — unknown-field rejection at the boundary", () => {
  it("the schema rejects a field that is not in the correctable set", () => {
    const { gdprRectificationBodySchema } = jest.requireActual<typeof import("./dto/gdpr-rectification.schemas")>(
      "./dto/gdpr-rectification.schemas",
    );
    expect(
      gdprRectificationBodySchema.safeParse({ field: "users.email", value: "attacker@bad.com" }).success,
    ).toBe(false);
    expect(
      gdprRectificationBodySchema.safeParse({ field: "hr_sensitive.national_id", value: "123" }).success,
    ).toBe(false);
  });
});
