jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import type { ComposioGateway } from "./composio.gateway";
import type { Db } from "../../../db/drizzle.module";
import type { AppConfig } from "../../../config/env.validation";

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
  const config = { APP_URL: "https://app.example.com" } as AppConfig;

  it("finalize rejects an account not owned by the caller", async () => {
    const gateway = {
      getOwnedConnectedAccount: jest.fn().mockResolvedValue(null),
    } as unknown as ComposioGateway;
    const service = new IntegrationsService({} as Db, config, gateway);
    await expect(service.finalize("org-1", "user-A", "ca_x")).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.getOwnedConnectedAccount).toHaveBeenCalledWith("user-A", "ca_x");
  });

  it("finalize rejects a connection that is not active yet", async () => {
    const gateway = {
      getOwnedConnectedAccount: jest.fn().mockResolvedValue({
        id: "ca_x",
        status: "INITIATED",
        userId: "user-A",
        toolkitSlug: "googlecalendar",
        email: null,
      }),
    } as unknown as ComposioGateway;
    const service = new IntegrationsService({} as Db, config, gateway);
    await expect(service.finalize("org-1", "user-A", "ca_x")).rejects.toBeInstanceOf(BadRequestException);
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
      "https://app.example.com/calendar",
    );
  });
});
