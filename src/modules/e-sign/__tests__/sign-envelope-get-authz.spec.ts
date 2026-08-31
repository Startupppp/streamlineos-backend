/**
 * Regression specs for the GET /sign/envelopes/:envelopeId BOLA gap.
 *
 * Before the fix, getFull() only checked orgId, so any holder of
 * sign:envelope:view (including "own"-scoped members) could read any
 * org envelope by guessing its numeric ID.
 *
 * After the fix, getFull() accepts a scope arg and throws ForbiddenException
 * when viewAll is false and the envelope belongs to a different sender.
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SignEnvelopesService } from "../sign-envelopes.service";
import type { Request } from "express";
import { SignEnvelopesController } from "../sign-envelopes.controller";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-test";
const SENDER_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 20;
const ENVELOPE_ID = 42;

const makeEnvelope = (senderMembershipId = SENDER_MEMBERSHIP) => ({
  id: ENVELOPE_ID,
  orgId: ORG,
  senderMembershipId,
  title: "Test Envelope",
  status: "draft",
  routingMode: "parallel",
  ccTiming: "on_complete",
  allowDecline: true,
  reminderEnabled: true,
  reminderFirstAfterDays: 3,
  reminderRepeatDays: 3,
  reminderMaxCount: 5,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function makeDb(envelope: ReturnType<typeof makeEnvelope> | null): Db {
  const findFirst = jest.fn().mockResolvedValue(envelope);
  const findMany = jest.fn().mockResolvedValue([]);
  return {
    query: {
      signEnvelopes: { findFirst, findMany },
      signDocuments: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      signFields: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      signRecipients: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
}

function makeService(envelope: ReturnType<typeof makeEnvelope> | null) {
  const db = makeDb(envelope);
  const recipients = { listForEnvelope: jest.fn().mockResolvedValue([]) };
  return new SignEnvelopesService(
    db,
    {} as never,
    recipients as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("SignEnvelopesService.getFull — scope gate", () => {
  it("returns the envelope when viewAll is true regardless of sender", async () => {
    const svc = makeService(makeEnvelope(SENDER_MEMBERSHIP));
    const result = await svc.getFull(ORG, ENVELOPE_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: true });
    expect(result.envelope.id).toBe(ENVELOPE_ID);
  });

  it("returns the envelope when viewAll is false and the caller is the sender", async () => {
    const svc = makeService(makeEnvelope(SENDER_MEMBERSHIP));
    const result = await svc.getFull(ORG, ENVELOPE_ID, { membershipId: SENDER_MEMBERSHIP, viewAll: false });
    expect(result.envelope.id).toBe(ENVELOPE_ID);
  });

  it("throws ForbiddenException when viewAll is false and caller is NOT the sender — BOLA gate bites", async () => {
    const svc = makeService(makeEnvelope(SENDER_MEMBERSHIP));
    await expect(
      svc.getFull(ORG, ENVELOPE_ID, { membershipId: OTHER_MEMBERSHIP, viewAll: false }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws NotFoundException when the envelope does not exist in the org", async () => {
    const svc = makeService(null);
    await expect(
      svc.getFull(ORG, ENVELOPE_ID, { membershipId: SENDER_MEMBERSHIP, viewAll: false }),
    ).rejects.toThrow(NotFoundException);
  });

  it("requires a scope argument, so an unscoped read is unrepresentable rather than merely discouraged", () => {
    expect(SignEnvelopesService.prototype.getFull.length).toBe(3);
  });
});

describe("SignEnvelopesController.get — scope forwarded from request", () => {
  const makeUser = (): CurrentUserContext =>
    ({
      orgId: ORG,
      userId: "user-other",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: OTHER_MEMBERSHIP, isOrgOwner: false },
    }) as unknown as CurrentUserContext;

  it("passes viewAll:true to getFull when rbacScope is 'all'", async () => {
    const svc = { getFull: jest.fn().mockResolvedValue({ envelope: {}, documents: [], recipients: [], fields: [] }) } as unknown as SignEnvelopesService;
    const ctrl = new SignEnvelopesController(svc);
    const req = { rbacScope: "all" } as Request;

    await ctrl.get(ENVELOPE_ID, makeUser(), req);

    expect(svc.getFull).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.objectContaining({ viewAll: true, membershipId: OTHER_MEMBERSHIP }),
    );
  });

  it("passes viewAll:false to getFull when rbacScope is 'own'", async () => {
    const svc = { getFull: jest.fn().mockResolvedValue({ envelope: {}, documents: [], recipients: [], fields: [] }) } as unknown as SignEnvelopesService;
    const ctrl = new SignEnvelopesController(svc);
    const req = { rbacScope: "own" } as Request;

    await ctrl.get(ENVELOPE_ID, makeUser(), req);

    expect(svc.getFull).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.objectContaining({ viewAll: false, membershipId: OTHER_MEMBERSHIP }),
    );
  });

  it("passes viewAll:false to getFull when rbacScope is absent — fails closed", async () => {
    const svc = { getFull: jest.fn().mockResolvedValue({ envelope: {}, documents: [], recipients: [], fields: [] }) } as unknown as SignEnvelopesService;
    const ctrl = new SignEnvelopesController(svc);
    const req = {} as Request;

    await ctrl.get(ENVELOPE_ID, makeUser(), req);

    expect(svc.getFull).toHaveBeenCalledWith(
      ORG,
      ENVELOPE_ID,
      expect.objectContaining({ viewAll: false }),
    );
  });
});
