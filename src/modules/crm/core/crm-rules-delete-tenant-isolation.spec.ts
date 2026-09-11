import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { CrmRulesService } from "./crm-rules.service";

function makeDeleteChain(returning: unknown[]) {
  const returning_ = jest.fn().mockResolvedValue(returning);
  const where = jest.fn().mockReturnValue({ returning: returning_ });
  const delete_ = jest.fn().mockReturnValue({ where });
  const db = { delete: delete_ } as unknown as Db;
  return { db };
}

const mockCache = {
  cachedVersioned: jest.fn(),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};

const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";

describe("CrmRulesService — delete cross-tenant isolation", () => {
  describe("deleteAssignmentRule", () => {
    it("deletes the rule when it belongs to the caller's org (own → success)", async () => {
      const { db } = makeDeleteChain([{ id: 5 }]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteAssignmentRule(OWN_ORG, 5)).resolves.toMatchObject({ success: true });
    });

    it("throws 404 when the rule belongs to a different org (cross-tenant → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteAssignmentRule(OTHER_ORG, 5)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when the rule id does not exist (unknown → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteAssignmentRule(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("deleteScoringRule", () => {
    it("deletes the rule when it belongs to the caller's org (own → success)", async () => {
      const { db } = makeDeleteChain([{ id: 8 }]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteScoringRule(OWN_ORG, 8)).resolves.toMatchObject({ success: true });
    });

    it("throws 404 when the rule belongs to a different org (cross-tenant → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteScoringRule(OTHER_ORG, 8)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when the rule id does not exist (unknown → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteScoringRule(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("deleteEmailTemplate", () => {
    it("deletes the template when it belongs to the caller's org (own → success)", async () => {
      const { db } = makeDeleteChain([{ id: 12 }]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteEmailTemplate(OWN_ORG, 12)).resolves.toMatchObject({ success: true });
    });

    it("throws 404 when the template belongs to a different org (cross-tenant → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteEmailTemplate(OTHER_ORG, 12)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when the template id does not exist (unknown → 404)", async () => {
      const { db } = makeDeleteChain([]);
      const svc = new CrmRulesService(db, mockCache as never, {} as never);
      await expect(svc.deleteEmailTemplate(OWN_ORG, 99999)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
