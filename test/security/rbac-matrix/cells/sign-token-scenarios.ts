import type { Table } from "drizzle-orm";
import { signBulkSendJobs, signBulkSendRows, signDocuments, signEnvelopes, signFields, signRecipients } from "src/db/schema";
import type { ExpectedOutcome, Observation, Scenario, ScenarioActor } from "../matrix.types";
import { BULK_ENTRY_SHIM, bulkSend, emitted, publicSigning, sweeps, tokenHash } from "../adapters/sign-token-adapter";
import { SIGN_ENTRY_SHIM } from "../adapters/sign-adapter";
import { ORG_A, ORG_B } from "../standings";
import type { Row, WorldDb } from "../world-db";
import { evaluate, propertyOf } from "../world-db-sql";
import { DOCUMENT_A } from "./sign-scenarios";

export const TOKEN_ENVELOPE = 4501;
export const VOIDED_ENVELOPE = 4502;
export const EXPIRED_ENVELOPE = 4503;
export const TOKEN_DOCUMENT = 4531;
export const MY_FIELD = 4511;
export const THEIR_FIELD = 4512;
export const BULK_JOB_A = 4601;
const FUTURE = new Date("2999-01-01T00:00:00Z");
const PAST = new Date("2020-01-01T00:00:00Z");

const TOKENS = {
  active: "tok-active-signer",
  other: "tok-other-signer",
  expired: "tok-expired-signer",
  revoked: "tok-revoked-signer",
  unproven: "tok-unproven-signer",
  voided: "tok-voided-envelope",
  unknown: "tok-never-minted",
};

function tokenEnvelope(id: number, status: string, expiresAt: Date | null): Row {
  return { id, orgId: ORG_A, senderMembershipId: null, title: "Contract", status, routingMode: "parallel", allowDecline: true, expiresAt, subject: null, message: null };
}

function recipient(id: number, envelopeId: number, token: string, overrides: Partial<Record<string, unknown>>): Row {
  return {
    id,
    orgId: ORG_A,
    envelopeId,
    routingOrder: 1,
    name: "Signer",
    email: "signer@example.com",
    status: "authenticated",
    authMethod: "email_link",
    authenticatedAt: new Date("2026-09-01T00:00:00Z"),
    consentAcceptedAt: new Date("2026-09-01T00:00:00Z"),
    viewedAt: new Date("2026-09-01T00:00:00Z"),
    tokenExpiresAt: FUTURE,
    tokenRevokedAt: null,
    signingTokenHash: tokenHash(token),
    accessCodeHash: null,
    otpCodeHash: null,
    ...overrides,
  };
}

export function signTokenRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [signEnvelopes, [tokenEnvelope(TOKEN_ENVELOPE, "sent", FUTURE), tokenEnvelope(VOIDED_ENVELOPE, "voided", FUTURE), tokenEnvelope(EXPIRED_ENVELOPE, "sent", PAST)]],
    [
      signRecipients,
      [
        recipient(4521, TOKEN_ENVELOPE, TOKENS.active, {}),
        recipient(4522, TOKEN_ENVELOPE, TOKENS.other, { status: "invited" }),
        recipient(4523, TOKEN_ENVELOPE, TOKENS.expired, { tokenExpiresAt: PAST }),
        recipient(4524, TOKEN_ENVELOPE, TOKENS.revoked, { tokenRevokedAt: new Date("2026-09-02T00:00:00Z") }),
        recipient(4525, TOKEN_ENVELOPE, TOKENS.unproven, { status: "invited", authMethod: "access_code", authenticatedAt: null }),
        recipient(4526, VOIDED_ENVELOPE, TOKENS.voided, {}),
        recipient(4527, EXPIRED_ENVELOPE, "tok-expiring-envelope", { status: "invited" }),
      ],
    ],
    [signDocuments, [{ id: TOKEN_DOCUMENT, orgId: ORG_A, envelopeId: TOKEN_ENVELOPE, orderIndex: 0, currentFileKey: `${ORG_A}/sign/${TOKEN_DOCUMENT}.pdf`, originalFileKey: `${ORG_A}/sign/${TOKEN_DOCUMENT}.pdf`, fileName: "a.pdf", pageCount: 1, mimeType: "application/pdf" }]],
    [
      signFields,
      [
        { id: MY_FIELD, orgId: ORG_A, envelopeId: TOKEN_ENVELOPE, recipientId: 4521, fieldType: "text", readonly: false, optionsJson: null, pageNumber: 1, orderIndex: 0 },
        { id: THEIR_FIELD, orgId: ORG_A, envelopeId: TOKEN_ENVELOPE, recipientId: 4522, fieldType: "text", readonly: false, optionsJson: null, pageNumber: 1, orderIndex: 1 },
      ],
    ],
    [signBulkSendJobs, [{ id: BULK_JOB_A, orgId: ORG_A, status: "pending", failedCount: 1 }]],
    [signBulkSendRows, [{ id: 4611, jobId: BULK_JOB_A, rowNumber: 1, status: "failed" }]],
  ]);
}

interface Case {
  readonly suffix: string;
  readonly actor: ScenarioActor;
  readonly tenant: "same" | "other";
  readonly expected: ExpectedOutcome;
  readonly because: string;
  readonly run: () => Promise<Observation>;
}

function family(prefix: string, resource: string, action: string, adapter: "http" | "file" | "job", entry: string, cases: readonly Case[]): Scenario[] {
  const allowed = cases.find((item) => item.expected === "allow");
  return cases.map((item) => ({
    id: `${prefix}-${item.suffix}`,
    actor: item.actor,
    resource,
    action,
    tenant: item.tenant,
    state: "normal",
    expected: item.expected,
    because: item.because,
    pairedWith: item.expected === "allow" || allowed === undefined ? undefined : `${prefix}-${allowed.suffix}`,
    bindings: [{ adapter, entry, run: item.run }],
  }));
}

function stateOf(body: unknown): unknown {
  return body !== null && typeof body === "object" && "state" in body ? body.state : undefined;
}

function signingLinkScenarios(world: WorldDb): Scenario[] {
  const session = (token: string, state: string) => async (): Promise<Observation> => {
    const exchange = await publicSigning(world, "get", `/public/sign/${token}/session`);
    return {
      outcome: exchange.outcome,
      checks: {
        sessionClosedWithTheExpectedState: exchange.outcome !== "allow" || stateOf(exchange.body) === state,
        closedSessionCarriesNoDocuments: exchange.outcome !== "allow" || (exchange.body !== null && typeof exchange.body === "object" && !("documents" in exchange.body)),
      },
    };
  };
  const preview = (token: string, documentId: number) => async (): Promise<Observation> => {
    const exchange = await publicSigning(world, "get", `/public/sign/${token}/documents/${documentId}/preview`);
    return {
      outcome: exchange.outcome,
      checks: { urlMintedOnlyForTheTokensOwnDocument: exchange.outcome === "allow" ? exchange.minted.length === 1 && exchange.minted[0]?.key === `${ORG_A}/sign/${TOKEN_DOCUMENT}.pdf` : exchange.minted.length === 0 },
    };
  };
  const field = (token: string, fieldId: number) => async (): Promise<Observation> => {
    const exchange = await publicSigning(world, "post", `/public/sign/${token}/fields/${fieldId}`, { value: "x" });
    const fieldWrites = exchange.writes.filter((write) => write.table === "sign_fields");
    return { outcome: exchange.outcome, checks: { fieldWrittenOnlyWhenOwned: (exchange.outcome === "allow") === (fieldWrites.length === 1) } };
  };
  const decline = (token: string) => async (): Promise<Observation> => {
    const exchange = await publicSigning(world, "post", `/public/sign/${token}/decline`, { reason: "no" });
    const recipientWrites = exchange.writes.filter((write) => write.table === "sign_recipients");
    return { outcome: exchange.outcome, checks: { declineWrittenOnlyWhenProven: (exchange.outcome === "allow") === (recipientWrites.length === 1) } };
  };
  const entry = (route: string) => `@Public ${route} -> SignPublicService (${SIGN_ENTRY_SHIM})`;
  return [
    ...family("sign-link-session", "sign:signing-link", "open-session", "http", entry("GET /public/sign/:token/session"), [
      { suffix: "expired", actor: "tenant-only", tenant: "same", expected: "allow", because: "an expired tokenExpiresAt answers a closed session in state expired with no documents or fields", run: session(TOKENS.expired, "expired") },
      { suffix: "revoked", actor: "tenant-only", tenant: "same", expected: "allow", because: "a revoked token closes the session even while tokenExpiresAt is in the future", run: session(TOKENS.revoked, "revoked") },
      { suffix: "voided-envelope", actor: "tenant-only", tenant: "same", expected: "allow", because: "a voided envelope closes the session regardless of the recipient's own state", run: session(TOKENS.voided, "envelope_voided") },
      { suffix: "unknown-token", actor: "tenant-only", tenant: "same", expected: "404", because: "an unknown token is a 404, so a signing link cannot be enumerated into a session", run: session(TOKENS.unknown, "") },
    ]),
    ...family("sign-link-preview", "sign:signing-link", "preview-document", "file", entry("GET /public/sign/:token/documents/:documentId/preview"), [
      { suffix: "own-document", actor: "tenant-only", tenant: "same", expected: "allow", because: "a token previews a document of its own envelope", run: preview(TOKENS.active, TOKEN_DOCUMENT) },
      { suffix: "other-envelope-document", actor: "tenant-only", tenant: "same", expected: "404", because: "a real document id from a different envelope is not found and no URL is minted", run: preview(TOKENS.active, DOCUMENT_A) },
      { suffix: "expired-token", actor: "tenant-only", tenant: "same", expected: "403", because: "an expired token cannot mint a document URL", run: preview(TOKENS.expired, TOKEN_DOCUMENT) },
    ]),
    ...family("sign-link-field", "sign:signing-link", "write-field", "http", entry("POST /public/sign/:token/fields/:fieldId"), [
      { suffix: "own-field", actor: "tenant-only", tenant: "same", expected: "allow", because: "a token writes its own recipient's field", run: field(TOKENS.active, MY_FIELD) },
      { suffix: "other-recipients-field", actor: "tenant-only", tenant: "same", expected: "404", because: "a field of another recipient of the same envelope is not found and nothing is written", run: field(TOKENS.active, THEIR_FIELD) },
    ]),
    ...family("sign-link-decline", "sign:signing-link", "decline", "http", entry("POST /public/sign/:token/decline"), [
      { suffix: "proven", actor: "tenant-only", tenant: "same", expected: "allow", because: "an authenticated recipient may decline", run: decline(TOKENS.active) },
      { suffix: "unproven", actor: "tenant-only", tenant: "same", expected: "403", because: "a recipient who never proved identity cannot decline on the link alone, and nothing is written", run: decline(TOKENS.unproven) },
    ]),
  ];
}

function bulkScenarios(world: WorldDb): Scenario[] {
  const entry = (route: string) => `${route} -> SignBulkSendService (${BULK_ENTRY_SHIM}; ${SIGN_ENTRY_SHIM})`;
  const routes: ReadonlyArray<readonly ["read" | "cancel" | "error-report", string]> = [
    ["read", "GET /sign/bulk-send/jobs/:jobId"],
    ["cancel", "POST /sign/bulk-send/jobs/:jobId/cancel"],
    ["error-report", "GET /sign/bulk-send/jobs/:jobId/error-report"],
  ];
  return routes.flatMap(([route, path]) =>
    family(`sign-bulk-job-${route}`, "sign:bulk-send-job", route, "http", entry(path), [
      { suffix: "own-org", actor: "org:admin", tenant: "same", expected: "allow", because: "the caller's own bulk job resolves under its org", run: () => bulkSend(world, route, "org:admin", ORG_A, BULK_JOB_A) },
      { suffix: "cross-tenant", actor: "org:admin", tenant: "other", expected: "404", because: "another organisation's bulk job id is not found, never forbidden", run: () => bulkSend(world, route, "org:admin", ORG_B, BULK_JOB_A) },
    ]),
  );
}

function predicateAdmits(where: unknown, row: Row): boolean {
  return evaluate(where, (column) => row[propertyOf(column)]) === true;
}

function sweepScenarios(world: WorldDb): Scenario[] {
  const ownRecipient = { orgId: ORG_A, envelopeId: EXPIRED_ENVELOPE, status: "invited" };
  const ownEnvelope = { id: EXPIRED_ENVELOPE, orgId: ORG_A, status: "sent", expiresAt: PAST };
  const run = (orgId: string) => async (): Promise<Observation> => {
    emitted.length = 0;
    const readMark = world.reads.length;
    const writeMark = world.writes.length;
    const count = await sweeps(world).runExpirationSweep(orgId);
    const candidates = world.reads.slice(readMark).filter((read) => read.table === "sign_envelopes");
    const writes = world.writes.slice(writeMark);
    const recipientWrite = writes.find((write) => write.table === "sign_recipients");
    const envelopeWrite = writes.find((write) => write.table === "sign_envelopes");
    const swept = count > 0;
    return {
      outcome: swept ? "allow" : "404",
      checks: {
        candidatesSelectedUnderTheSweptOrg: candidates.length === 1 && candidates.every((read) => predicateAdmits(read.where, { ...ownEnvelope, orgId }) && !predicateAdmits(read.where, { ...ownEnvelope, orgId: orgId === ORG_A ? ORG_B : ORG_A })),
        recipientRevocationBoundToTheSweptOrg: !swept || (recipientWrite !== undefined && predicateAdmits(recipientWrite.where, ownRecipient) && !predicateAdmits(recipientWrite.where, { ...ownRecipient, orgId: ORG_B })),
        envelopeStatusWriteBoundToTheSweptOrg: !swept || (envelopeWrite !== undefined && predicateAdmits(envelopeWrite.where, ownEnvelope) && !predicateAdmits(envelopeWrite.where, { ...ownEnvelope, orgId: ORG_B })),
        writesNothingWhenNothingIsDue: swept || writes.length === 0,
        emitsOnlyTheSweptOrgsEnvelopes: emitted.every((event) => event.orgId === orgId),
      },
    };
  };
  return family("sign-expiration-sweep", "sign:envelope", "expire", "job", "SignEnvelopeSweepsService.runExpirationSweep(orgId) — POST /sign/admin/run-expiration-sweep and the cron sweep", [
    { suffix: "own-org", actor: "tenant-only", tenant: "same", expected: "allow", because: "the sweep expires the swept organisation's due envelope and binds both writes to that organisation", run: run(ORG_A) },
    { suffix: "cross-tenant", actor: "tenant-only", tenant: "other", expected: "404", because: "a sweep for another organisation selects and writes none of this organisation's envelopes", run: run(ORG_B) },
  ]);
}

export function signTokenScenarios(world: WorldDb): Scenario[] {
  return [...signingLinkScenarios(world), ...bulkScenarios(world), ...sweepScenarios(world)];
}
