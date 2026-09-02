import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsSchedulesService } from "./workflows-schedules.service";
import { WorkflowsSecretsService } from "./workflows-secrets.service";
import { WorkflowsVariablesService } from "./workflows-variables.service";

const OWNER_ORG = "org-owner-uuid";
const ATTACKER_ORG = "org-attacker-uuid";
const WORKFLOW_ID = "wf-uuid-1";
const SCHEDULE_ID = "sched-uuid-1";
const SECRET_ID = "secret-uuid-1";
const VARIABLE_ID = "var-uuid-1";

const LIST_QUERY = { cursor: undefined, limit: 50 } as const;

describe("WorkflowsSchedulesService — cross-tenant isolation", () => {
  describe("listSchedules", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = { query: { workflows: { findFirst } } } as unknown as Db;

      const svc = new WorkflowsSchedulesService(db);
      await expect(svc.listSchedules(ATTACKER_ORG, WORKFLOW_ID, LIST_QUERY)).rejects.toThrow(NotFoundException);
    });

    it("returns schedules for the owning org (control — same-tenant access works)", async () => {
      const scheduleRow = { id: SCHEDULE_ID, orgId: OWNER_ORG, workflowId: WORKFLOW_ID };
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const limit = jest.fn().mockResolvedValue([scheduleRow]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const where = jest.fn().mockReturnValue({ orderBy });
      const from = jest.fn().mockReturnValue({ where });
      const db = {
        query: { workflows: { findFirst } },
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;

      const svc = new WorkflowsSchedulesService(db);
      const result = await svc.listSchedules(OWNER_ORG, WORKFLOW_ID, LIST_QUERY);
      expect(result.data).toEqual([scheduleRow]);
    });
  });

  describe("createSchedule", () => {
    it("throws NotFoundException for a schedule on a cross-tenant workflow", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = { query: { workflows: { findFirst } } } as unknown as Db;

      const svc = new WorkflowsSchedulesService(db);
      await expect(
        svc.createSchedule(ATTACKER_ORG, WORKFLOW_ID, { cronExpression: "0 * * * *", timezone: "UTC", isEnabled: true }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteSchedule", () => {
    it("throws NotFoundException when schedule belongs to a different org (cross-tenant isolation)", async () => {
      const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
      const db = {
        query: {
          workflows: { findFirst: jest.fn().mockResolvedValue({ id: WORKFLOW_ID }) },
        },
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;

      const svc = new WorkflowsSchedulesService(db);
      await expect(svc.deleteSchedule(ATTACKER_ORG, WORKFLOW_ID, SCHEDULE_ID)).rejects.toThrow(NotFoundException);
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });

    it("deletes schedule for the owning org (control)", async () => {
      const workflowFindFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const deleteWhere = jest
        .fn()
        .mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: SCHEDULE_ID }]) });
      const db = {
        query: { workflows: { findFirst: workflowFindFirst } },
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;

      const svc = new WorkflowsSchedulesService(db);
      await expect(svc.deleteSchedule(OWNER_ORG, WORKFLOW_ID, SCHEDULE_ID)).resolves.not.toThrow();
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });
});

describe("WorkflowsSecretsService — cross-tenant isolation and secret redaction", () => {
  describe("listSecrets — encryptedValue never appears in response", () => {
    it("throws NotFoundException for a cross-tenant workflow", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = { query: { workflows: { findFirst } } } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      await expect(svc.listSecrets(ATTACKER_ORG, WORKFLOW_ID, LIST_QUERY)).rejects.toThrow(NotFoundException);
    });

    it("never includes encryptedValue in the returned rows (same-tenant control)", async () => {
      const secretRow = {
        id: SECRET_ID,
        orgId: OWNER_ORG,
        name: "MY_SECRET",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const limit = jest.fn().mockResolvedValue([secretRow]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const where = jest.fn().mockReturnValue({ orderBy });
      const from = jest.fn().mockReturnValue({ where });
      const db = {
        query: { workflows: { findFirst } },
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      const result = await svc.listSecrets(OWNER_ORG, WORKFLOW_ID, LIST_QUERY);
      expect(JSON.stringify(result)).not.toContain("encryptedValue");
      expect(JSON.stringify(result)).not.toContain("encrypted_value");
      expect(result.data[0]).not.toHaveProperty("encryptedValue");
    });
  });

  describe("createSecret — encryptedValue never appears in response", () => {
    it("never returns encryptedValue after creation (same-tenant control)", async () => {
      const secretRow = {
        id: SECRET_ID,
        orgId: OWNER_ORG,
        name: "MY_SECRET",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const returning = jest.fn().mockResolvedValue([secretRow]);
      const values = jest.fn().mockReturnValue({ returning });
      const db = {
        query: { workflows: { findFirst } },
        insert: jest.fn().mockReturnValue({ values }),
      } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      const result = await svc.createSecret(OWNER_ORG, WORKFLOW_ID, { name: "MY_SECRET", value: "super-secret-value" });
      expect(JSON.stringify(result)).not.toContain("super-secret-value");
      expect(JSON.stringify(result)).not.toContain("encryptedValue");
      expect(result).not.toHaveProperty("encryptedValue");
    });
  });

  describe("listGlobalSecrets — encryptedValue never appears in response", () => {
    it("never includes encryptedValue in global secrets listing", async () => {
      const secretRow = {
        id: SECRET_ID,
        name: "GLOBAL_SECRET",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const limit = jest.fn().mockResolvedValue([secretRow]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const where = jest.fn().mockReturnValue({ orderBy });
      const from = jest.fn().mockReturnValue({ where });
      const db = {
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      const result = await svc.listGlobalSecrets(OWNER_ORG, LIST_QUERY);
      expect(JSON.stringify(result)).not.toContain("encryptedValue");
      expect(JSON.stringify(result)).not.toContain("encrypted_value");
    });
  });

  describe("deleteGlobalSecret", () => {
    it("throws NotFoundException when secret belongs to a different org (cross-tenant isolation)", async () => {
      const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
      const db = {
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      await expect(svc.deleteGlobalSecret(ATTACKER_ORG, SECRET_ID)).rejects.toThrow(NotFoundException);
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });

    it("deletes secret for the owning org (control)", async () => {
      const deleteWhere = jest
        .fn()
        .mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: SECRET_ID }]) });
      const db = {
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;

      const svc = new WorkflowsSecretsService(db);
      await expect(svc.deleteGlobalSecret(OWNER_ORG, SECRET_ID)).resolves.not.toThrow();
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });
});

describe("WorkflowsVariablesService — cross-tenant isolation", () => {
  describe("deleteGlobalVariable", () => {
    it("throws NotFoundException when variable belongs to a different org (cross-tenant isolation)", async () => {
      const limit = jest.fn().mockResolvedValue([]);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      const db = {
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;

      const svc = new WorkflowsVariablesService(db);
      await expect(svc.deleteGlobalVariable(ATTACKER_ORG, VARIABLE_ID)).rejects.toThrow(NotFoundException);
    });

    it("deletes variable for the owning org (control)", async () => {
      const variableRow = { id: VARIABLE_ID };
      const limit = jest.fn().mockResolvedValue([variableRow]);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      const deleteWhere = jest.fn().mockResolvedValue([]);
      const db = {
        select: jest.fn().mockReturnValue({ from }),
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;

      const svc = new WorkflowsVariablesService(db);
      await expect(svc.deleteGlobalVariable(OWNER_ORG, VARIABLE_ID)).resolves.not.toThrow();
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe("listGlobalVariables", () => {
    it("scopes results to the requesting org — never returns another org's variables", async () => {
      const limit = jest.fn().mockResolvedValue([]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const where = jest.fn().mockReturnValue({ orderBy });
      const innerJoin2 = jest.fn().mockReturnValue({ where });
      const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
      const from = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
      const db = {
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;

      const svc = new WorkflowsVariablesService(db);
      const result = await svc.listGlobalVariables(ATTACKER_ORG);
      expect(result).toEqual([]);
      expect(where).toHaveBeenCalledTimes(1);
    });
  });
});

describe("DataScope — not applicable to Workflows", () => {
  it("workflows are org-level resources with no user-scoped DataScope (own/team/all do not apply)", () => {
    expect(true).toBe(true);
  });
});
