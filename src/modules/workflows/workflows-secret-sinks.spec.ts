import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsSecretsService } from "./workflows-secrets.service";
import { readRunState, writeRunState } from "./engine/workflow-execution-context";

describe("Secret sink: execution record — executionContextSchema strips injected secret fields", () => {
  it("readRunState discards a 'secrets' field injected into execution context (structural proof)", () => {
    const state = readRunState({
      cursor: "node-1",
      resumeAt: null,
      variables: {},
      steps: 0,
      secrets: { MY_SECRET: "plaintext-super-secret-sentinel" },
    });
    expect(JSON.stringify(state)).not.toContain("plaintext-super-secret-sentinel");
    expect(state).not.toHaveProperty("secrets");
  });

  it("writeRunState output never emits a 'secrets' key (round-trip proof)", () => {
    const out = writeRunState({
      cursor: null,
      resumeAt: null,
      variables: { x: 1 },
      steps: 3,
      infraAttempt: 0,
    });
    expect(out).not.toHaveProperty("secrets");
  });
});

describe("Secret sink: error message — NotFoundException messages are static and never embed submitted values", () => {
  it("deleteGlobalSecret message is static 'Secret not found', does not embed secretId", async () => {
    const SENTINEL = "super-secret-value-sentinel";
    const db = {
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);

    let caught: unknown;
    try {
      await svc.deleteGlobalSecret("org-1", SENTINEL);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).message).not.toContain(SENTINEL);
    expect((caught as NotFoundException).message).toBe("Secret not found");
  });

  it("listSecrets message is static 'Workflow not found', does not embed workflowId", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: { workflows: { findFirst } },
    } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);

    let caught: unknown;
    try {
      await svc.listSecrets("org-1", "wf-sentinel-id-that-should-not-appear", { limit: 50 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).message).not.toContain("wf-sentinel-id-that-should-not-appear");
    expect((caught as NotFoundException).message).toBe("Workflow not found");
  });

  it("deleteSecret message is static 'Secret not found', does not embed secretId", async () => {
    const SENTINEL_SECRET_ID = "secret-id-sentinel";
    const workflowFindFirst = jest.fn().mockResolvedValue({ id: "wf-uuid" });
    const db = {
      query: { workflows: { findFirst: workflowFindFirst } },
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);

    let caught: unknown;
    try {
      await svc.deleteSecret("org-1", "wf-uuid", SENTINEL_SECRET_ID);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).message).not.toContain(SENTINEL_SECRET_ID);
    expect((caught as NotFoundException).message).toBe("Secret not found");
  });
});

describe("Secret sink: cache — WorkflowsSecretsService has no Redis/cache injection path", () => {
  it("listGlobalSecrets completes using only the db mock (no cache methods are called)", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);

    const result = await svc.listGlobalSecrets("org-1", { limit: 50 });
    expect(result.data).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("createGlobalSecret returns projected columns without encryptedValue (client payload + cache proof)", async () => {
    const secretRow = {
      id: "secret-1",
      name: "MY_SECRET",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const returning = jest.fn().mockResolvedValue([secretRow]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);

    const result = await svc.createGlobalSecret("org-1", { name: "MY_SECRET", value: "plaintext-sentinel" });
    expect(JSON.stringify(result)).not.toContain("plaintext-sentinel");
    expect(result).not.toHaveProperty("encryptedValue");
    expect(result).not.toHaveProperty("value");
  });
});

describe("Secret sink: log — WorkflowsSecretsService has no Logger instance (structural proof)", () => {
  it("creating the service does not install a Logger on the instance", () => {
    const db = {
      query: {},
      select: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new WorkflowsSecretsService(db);
    const proto = Object.getPrototypeOf(svc) as Record<string, unknown>;
    const ownKeys = Object.getOwnPropertyNames(svc);
    expect(ownKeys).not.toContain("logger");
    expect(proto).not.toHaveProperty("logger");
  });
});
