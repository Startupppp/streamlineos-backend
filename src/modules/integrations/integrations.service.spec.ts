jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import type { ComposioGateway } from "./composio.gateway";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";

function selectChain(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
    }),
  };
}

describe("IntegrationsService", () => {
  const config = { APP_URL: "http://localhost:1000" } as AppConfig;

  it("finalize rejects an account owned by another user", async () => {
    const gateway = {
      getConnectedAccount: jest.fn().mockResolvedValue({
        id: "ca_x",
        status: "ACTIVE",
        userId: "user-B",
        toolkitSlug: "googlecalendar",
        email: "b@x.com",
      }),
    } as unknown as ComposioGateway;
    const service = new IntegrationsService({} as Db, config, gateway);
    await expect(service.finalize("org-1", "user-A", "ca_x")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("finalize rejects when the account has no owning user id", async () => {
    const gateway = {
      getConnectedAccount: jest.fn().mockResolvedValue({
        id: "ca_x",
        status: "ACTIVE",
        userId: null,
        toolkitSlug: "googlecalendar",
        email: null,
      }),
    } as unknown as ComposioGateway;
    const service = new IntegrationsService({} as Db, config, gateway);
    await expect(service.finalize("org-1", "user-A", "ca_x")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("disconnect 404s when the connection belongs to someone else", async () => {
    const db = { select: jest.fn().mockReturnValue(selectChain([])) } as unknown as Db;
    const service = new IntegrationsService(db, config, {} as ComposioGateway);
    await expect(service.disconnect("org-1", "user-A", 7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("initiate builds the calendar callback URL", async () => {
    const gateway = {
      initiateConnection: jest.fn().mockResolvedValue({ redirectUrl: "https://composio/redirect" }),
    } as unknown as ComposioGateway;
    const service = new IntegrationsService({} as Db, config, gateway);
    const result = await service.initiate("user-A", "googlecalendar");
    expect(result.redirectUrl).toBe("https://composio/redirect");
    expect(gateway.initiateConnection).toHaveBeenCalledWith(
      "user-A",
      "googlecalendar",
      "http://localhost:1000/calendar",
    );
  });
});
