import { z } from "zod";
import type { ModuleRef } from "@nestjs/core";
import { CONFIRMABLE_ACTION_DEFINITIONS } from ".";
import {
  defineConfirmableAction,
  externalEffectKeyFor,
  type ConfirmableActionContext,
} from "./confirmable-action.types";
import { ExternalEffectLedger } from "../../../../common/outbox/external-effect-ledger";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";

const LEAVES_THE_PROCESS = ["mail.send", "mail.reply", "mail.archive"];
const STAYS_IN_OUR_DATABASE = ["chat.postChannel", "chat.sendDirect"];

function actor(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

function contextWith(ledger: unknown, proposalId = 42): ConfirmableActionContext {
  return {
    actor: actor(),
    db: {} as unknown as Db,
    proposalId,
    moduleRef: { get: () => ledger } as unknown as ModuleRef,
  };
}

describe("a confirmable action whose effect leaves the process is recorded before it is attempted", () => {
  it("declares an external effect for every action that calls a third-party provider inline", () => {
    const declared = CONFIRMABLE_ACTION_DEFINITIONS.filter(
      (definition) => definition.external !== undefined,
    ).map((definition) => definition.action);

    expect(declared.sort()).toEqual([...LEAVES_THE_PROCESS].sort());
  });

  it("leaves actions that only write our own database undeclared, so the ledger is not paid for a local write", () => {
    for (const action of STAYS_IN_OUR_DATABASE) {
      const definition = CONFIRMABLE_ACTION_DEFINITIONS.find((d) => d.action === action);
      expect(definition).toBeDefined();
      expect(definition?.external).toBeUndefined();
    }
  });

  it("routes the send through the ledger rather than calling the executor directly", async () => {
    const order: string[] = [];
    const ledger = {
      execute: jest.fn(async (_effect: unknown, send: () => Promise<void>) => {
        order.push("ledger-claim");
        await send();
        order.push("ledger-finish");
        return "EXECUTED" as const;
      }),
    };

    const action = defineConfirmableAction({
      action: "test.externalSend",
      permission: "mail:messages:send",
      payload: z.object({ to: z.string() }),
      external: { effectType: "test.effect", providerIdempotency: "NONE" },
      resolve: () => ({}),
      execute: async () => {
        order.push("provider-call");
        return { result: { sent: true }, summary: "sent" };
      },
    });

    const outcome = await action.execute({ to: "a@b.c" }, contextWith(ledger));

    expect(order).toEqual(["ledger-claim", "provider-call", "ledger-finish"]);
    expect(outcome).toEqual({ result: { sent: true }, summary: "sent" });
  });

  it("keys the effect on the proposal, so confirming the same proposal twice cannot send twice", async () => {
    const ledger = {
      execute: jest.fn(async (_effect: unknown, send: () => Promise<void>) => {
        await send();
        return "EXECUTED" as const;
      }),
    };

    const action = defineConfirmableAction({
      action: "test.externalSend",
      permission: "mail:messages:send",
      payload: z.object({ to: z.string() }),
      external: { effectType: "test.effect", providerIdempotency: "NONE" },
      resolve: () => ({}),
      execute: async () => ({ result: {}, summary: "s" }),
    });

    await action.execute({ to: "a@b.c" }, contextWith(ledger, 99));

    expect(ledger.execute.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "org-1",
      effectKey: externalEffectKeyFor("test.externalSend", 99),
      producerEventId: "ai-proposal:99",
      effectType: "test.effect",
      providerIdempotency: "NONE",
    });
  });

  it("reports an already-delivered effect instead of claiming a second send happened", async () => {
    const provider = jest.fn();
    const ledger = { execute: jest.fn(async () => "ALREADY_SUCCEEDED" as const) };

    const action = defineConfirmableAction({
      action: "test.externalSend",
      permission: "mail:messages:send",
      payload: z.object({ to: z.string() }),
      external: { effectType: "test.effect", providerIdempotency: "NONE" },
      resolve: () => ({}),
      execute: async () => {
        provider();
        return { result: { sent: true }, summary: "sent" };
      },
    });

    const outcome = await action.execute({ to: "a@b.c" }, contextWith(ledger));

    expect(provider).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({ alreadyDelivered: true });
  });

  it("propagates a provider failure so the ledger records FAILED and the caller still sees the error", async () => {
    const boom = new Error("provider rejected the message");
    const ledger = {
      execute: jest.fn(async (_effect: unknown, send: () => Promise<void>) => {
        await send();
        return "EXECUTED" as const;
      }),
    };

    const action = defineConfirmableAction({
      action: "test.externalSend",
      permission: "mail:messages:send",
      payload: z.object({ to: z.string() }),
      external: { effectType: "test.effect", providerIdempotency: "NONE" },
      resolve: () => ({}),
      execute: async () => {
        throw boom;
      },
    });

    await expect(action.execute({ to: "a@b.c" }, contextWith(ledger))).rejects.toThrow(boom);
  });

  it("does not reach for the ledger at all when no external effect is declared", async () => {
    const get = jest.fn();
    const action = defineConfirmableAction({
      action: "test.localWrite",
      permission: "chat:messages:write",
      payload: z.object({ message: z.string() }),
      resolve: () => ({}),
      execute: async () => ({ result: { ok: true }, summary: "written" }),
    });

    const outcome = await action.execute(
      { message: "hi" },
      {
        actor: actor(),
        db: {} as unknown as Db,
        proposalId: 1,
        moduleRef: { get } as unknown as ModuleRef,
      },
    );

    expect(get).not.toHaveBeenCalled();
    expect(outcome.summary).toBe("written");
  });

  it("resolves the real ledger class by token, so the wrapper cannot silently bind to nothing at runtime", async () => {
    const get = jest.fn(() => ({
      execute: async (_effect: unknown, send: () => Promise<void>) => {
        await send();
        return "EXECUTED" as const;
      },
    }));

    const action = defineConfirmableAction({
      action: "test.externalSend",
      permission: "mail:messages:send",
      payload: z.object({ to: z.string() }),
      external: { effectType: "test.effect", providerIdempotency: "NONE" },
      resolve: () => ({}),
      execute: async () => ({ result: {}, summary: "s" }),
    });

    await action.execute({ to: "a@b.c" }, {
      actor: actor(),
      db: {} as unknown as Db,
      proposalId: 5,
      moduleRef: { get } as unknown as ModuleRef,
    });

    expect(get).toHaveBeenCalledWith(ExternalEffectLedger, { strict: false });
  });
});
