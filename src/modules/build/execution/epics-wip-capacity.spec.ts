import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EpicsService } from "./epics.service";
import { BuildTicketCreationService } from "../core/tickets";
import { ProjectsWebhooksDispatchService } from "../core";
import { BuildAutomationRunnerService } from "../core";
import { CacheService } from "../../../common/cache/cache.service";

it("refuses an epic when its destination column has no remaining capacity", async () => {
  const tx = {
    execute: async () => [{ start: 10, name: "TODO", wip_limit: 1, current_count: 1 }],
    insert: () => { throw new Error("A full column reached the insert boundary"); },
  };
  const module = await Test.createTestingModule({ providers: [
    EpicsService,
    BuildTicketCreationService,
    {
      provide: DRIZZLE,
      useValue: {
        query: { projects: { findFirst: async () => ({ id: 1 }) } },
        transaction: async <T>(work: (connection: typeof tx) => Promise<T>) => work(tx),
      },
    },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn() } },
    { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  try {
    await expect(module.get(EpicsService).createEpic("org-a", "user-a", 1, { title: "Epic", startDate: undefined, dueDate: undefined }))
      .rejects.toThrow("WIP limit");
  } finally {
    await module.close();
  }
});

it.each([false, true])("refuses a missing destination with configured workflow=%s", async configured => {
  const tx = {
    execute: async () => [{ name: "TODO", wip_limit: null, current_count: 0, status_exists: false, has_statuses: configured }],
    insert: () => { throw new Error("An unknown destination reached the insert boundary"); },
  };
  const module = await Test.createTestingModule({ providers: [
    EpicsService,
    BuildTicketCreationService,
    {
      provide: DRIZZLE,
      useValue: {
        query: { projects: { findFirst: async () => ({ id: 1 }) } },
        transaction: async <T>(work: (connection: typeof tx) => Promise<T>) => work(tx),
      },
    },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn() } },
    { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  try {
    await expect(module.get(EpicsService).createEpic("org-a", "user-a", 1, { title: "Epic", startDate: undefined, dueDate: undefined }))
      .rejects.toThrow("no longer exists");
  } finally {
    await module.close();
  }
});

it("permits an existing unlimited destination", async () => {
  const tx = {
    execute: jest.fn().mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "TODO", wip_limit: null, current_count: 0, status_exists: true, has_statuses: true }])
      .mockResolvedValueOnce([{ start: 10 }]),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 10, title: "Epic" }] }) }),
  };
  const module = await Test.createTestingModule({ providers: [
    EpicsService,
    BuildTicketCreationService,
    {
      provide: DRIZZLE,
      useValue: {
        query: { projects: { findFirst: async () => ({ id: 1 }) } },
        transaction: async <T>(work: (connection: typeof tx) => Promise<T>) => work(tx),
      },
    },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn() } },
    { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  try {
    await expect(module.get(EpicsService).createEpic("org-a", "user-a", 1, { title: "Epic", startDate: undefined, dueDate: undefined }))
      .resolves.toMatchObject({ id: 10, title: "Epic" });
  } finally {
    await module.close();
  }
});
