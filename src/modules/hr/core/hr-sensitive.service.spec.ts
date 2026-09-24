import { NotFoundException } from "@nestjs/common";
import { HrSensitiveService } from "./hr-sensitive.service";
import type { HrAuditService } from "./hr-audit.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    (_db: unknown, _orgId: string, operation: () => Promise<unknown>) =>
      operation(),
  ),
}));

jest.mock("./hr-sensitive-record-compat", () => ({
  loadSensitiveRecordCollections: jest.fn().mockResolvedValue({
    disciplinaryRecords: [],
    grievanceRecords: [],
  }),
}));

const mockedRunInNewTenantTransaction = jest.mocked(runInNewTenantTransaction);

function selectChain(result: unknown[]) {
  const chain: {
    from: jest.Mock;
    where: jest.Mock;
    limit: jest.Mock;
  } = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

const EMPLOYMENT_ROW = { id: 1 };

const SENSITIVE_ROW = {
  id: 10,
  orgId: "org-1",
  employmentId: 1,
  salaryAmountCents: null,
  salaryCurrency: null,
  salaryFrequency: null,
  bankDetails: null,
  taxId: null,
  panNumber: null,
  nationalId: null,
  passportNumber: null,
  passportExpiry: null,
  visaType: null,
  visaExpiry: null,
  medicalNotes: null,
  bloodGroup: null,
  disciplinaryRecords: null,
  grievanceRecords: null,
  bgvStatus: null,
  bgvCompletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("HrSensitiveService.get", () => {
  beforeEach(() => {
    mockedRunInNewTenantTransaction.mockClear();
  });

  it(
    "records the sensitive-field view outside the request transaction, because a read holds no mutation to commit the audit with",
    async () => {
      const auditLog = jest.fn().mockResolvedValue(undefined);
      const db = {
        select: jest
          .fn()
          .mockReturnValueOnce(selectChain([EMPLOYMENT_ROW]))
          .mockReturnValueOnce(selectChain([SENSITIVE_ROW])),
      };
      const audit = { log: auditLog } as unknown as HrAuditService;
      const service = new HrSensitiveService(db as never, audit);

      await service.get("org-1", 1, "user-1", 42, "127.0.0.1");

      expect(mockedRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
      expect(mockedRunInNewTenantTransaction).toHaveBeenCalledWith(
        db,
        "org-1",
        expect.any(Function),
      );
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "sensitive.viewed",
          orgId: "org-1",
          entityType: "hr_employee_sensitive_fields",
          entityId: "1",
        }),
      );
    },
  );

  it("does not reach the audit path when the employment is not found", async () => {
    const auditLog = jest.fn();
    const db = {
      select: jest.fn().mockReturnValueOnce(selectChain([])),
    };
    const audit = { log: auditLog } as unknown as HrAuditService;
    const service = new HrSensitiveService(db as never, audit);

    await expect(service.get("org-1", 999, "user-1", 42, "127.0.0.1")).rejects.toThrow(
      NotFoundException,
    );
    expect(mockedRunInNewTenantTransaction).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
