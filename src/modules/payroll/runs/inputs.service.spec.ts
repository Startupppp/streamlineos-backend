import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { InputsService } from "./inputs.service";
import { ScopedRead } from "../../access/scoped-read";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { encodeCursor } from "../../../common/pagination/cursor";
import { payrollCursorPosition } from "../payroll-cursor";

describe("InputsService.listInputs scope gate", () => {
  const orgId = "org-1";
  const runId = 10;
  const actorUserId = "actor-1";

  function createService(options: { rows?: unknown[]; run?: { id: number; status: string } | null }) {
    const resolved = options.rows ?? [];
    const inputWhere = jest.fn((_where: SQL) => ({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(resolved),
      }),
    }));
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(options.run ? [options.run] : []),
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue(resolved),
                }),
              }),
            }),
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: inputWhere,
          }),
        }),
      }),
    };
    return { service: new InputsService(db as never), inputWhere };
  }

  it("rejects cross-user filter when scope is not all", async () => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" } });
    await expect(
      service.listInputs(ScopedRead.of(orgId, actorUserId, "own"), runId, { limit: 50, userId: "other-user" }, 1),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inputWhere).not.toHaveBeenCalled();
  });

  it("allows cross-user filter when scope is all", async () => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" }, rows: [] });
    await expect(
      service.listInputs(ScopedRead.of(orgId, actorUserId, "all"), runId, { limit: 50, userId: "other-user" }, 1),
    ).resolves.toMatchObject({ data: [], pagination: { hasMore: false } });
    expect(inputWhere).toHaveBeenCalledTimes(1);
    const compiled = new PgDialect().sqlToQuery(inputWhere.mock.calls[0][0]);
    expect(compiled.params).toEqual(expect.arrayContaining([orgId, runId, "other-user"]));
    expect(compiled.sql).toContain('"payroll_inputs"."user_id" =');
    expect(compiled.sql).not.toContain('"payroll_inputs"."user_membership_id" =');
  });

  it("preserves own-membership and tenant predicates for a self filter", async () => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" } });
    await service.listInputs(ScopedRead.of(orgId, actorUserId, "own"), runId, { limit: 50, userId: actorUserId }, 91);
    expect(inputWhere).toHaveBeenCalledTimes(1);
    const compiled = new PgDialect().sqlToQuery(inputWhere.mock.calls[0][0]);
    expect(compiled.params).toEqual(expect.arrayContaining([orgId, runId, actorUserId, 91]));
    expect(compiled.sql).toContain('"payroll_inputs"."org_id" =');
    expect(compiled.sql).toContain('"payroll_inputs"."user_membership_id" =');
  });

  it("denies a caller without an active organization membership before the input query", async () => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" } });
    await expect(
      service.listInputs(ScopedRead.of(orgId, actorUserId, "all"), runId, { limit: 50 }, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inputWhere).not.toHaveBeenCalled();
  });

  it.each([
    ["another tenant", ["run-inputs", "org-2", runId, "other-user", "all", 1]],
    ["another payee", ["run-inputs", orgId, runId, "different-user", "all", 1]],
    ["another scope", ["run-inputs", orgId, runId, "other-user", "own", 1]],
    ["another membership", ["run-inputs", orgId, runId, "other-user", "all", 2]],
  ])("rejects a cursor bound to %s before the input query", async (_label, scope) => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" } });
    const cursor = encodeCursor(payrollCursorPosition(scope, ["Payee"], 42));
    await expect(
      service.listInputs(ScopedRead.of(orgId, actorUserId, "all"), runId, { limit: 50, userId: "other-user", cursor }, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inputWhere).not.toHaveBeenCalled();
  });

  it("keeps the requested payee and tuple bound on a valid cursor", async () => {
    const { service, inputWhere } = createService({ run: { id: runId, status: "PREPARING" } });
    const cursor = encodeCursor(payrollCursorPosition(["run-inputs", orgId, runId, "other-user", "all", 1], ["Payee"], 42));
    await service.listInputs(ScopedRead.of(orgId, actorUserId, "all"), runId, { limit: 50, userId: "other-user", cursor }, 1);
    expect(inputWhere).toHaveBeenCalledTimes(1);
    const compiled = new PgDialect().sqlToQuery(inputWhere.mock.calls[0][0]);
    expect(compiled.params).toEqual(expect.arrayContaining([orgId, runId, "other-user", "Payee", 42]));
    expect(compiled.sql).toContain(") > (");
  });
});
