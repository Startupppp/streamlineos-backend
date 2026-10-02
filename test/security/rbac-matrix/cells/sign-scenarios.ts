import type { Type } from "@nestjs/common";
import type { Table } from "drizzle-orm";
import { signAuditEvents, signDocuments, signEnvelopes, signFields, signRecipients } from "src/db/schema";
import { SignFieldsController } from "src/modules/e-sign/sign-fields.controller";
import { SignRecipientsController } from "src/modules/e-sign/sign-recipients.controller";
import { SignDocumentsController } from "src/modules/e-sign/sign-documents.controller";
import { SignCertificatesController } from "src/modules/e-sign/sign-certificates.controller";
import { SignEnvelopesController } from "src/modules/e-sign/sign-envelopes.controller";
import { SignAiController } from "src/modules/e-sign/sign-ai.controller";
import type { DataScope } from "src/modules/access/access.types";
import type { AdapterKind, ExpectedOutcome, Observation, Scenario, ScenarioState } from "../matrix.types";
import { SIGN_ENTRY_SHIM, sendSign, type SignActor, type SignRequest } from "../adapters/sign-adapter";
import { ORG_A, ORG_B, membershipIdOf, userOf } from "../standings";
import type { Row, WorldDb } from "../world-db";

export const ENVELOPE_A = 4401;
export const EMPTY_ENVELOPE_A = 4402;
export const ABSENT_ENVELOPE = 999_999;
export const FIELD_A = 4411;
export const RECIPIENT_A = 4421;
export const DOCUMENT_A = 4431;
export const ABSENT_DOCUMENT = 999_998;

const SENDER = membershipIdOf("org:member", ORG_A);

function envelope(id: number): Row {
  return { id, orgId: ORG_A, senderMembershipId: SENDER, title: "Contract", status: "sent", routingMode: "parallel", expiresAt: null, allowDecline: true };
}

export function signRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [signEnvelopes, [envelope(ENVELOPE_A), envelope(EMPTY_ENVELOPE_A)]],
    [signFields, [{ id: FIELD_A, orgId: ORG_A, envelopeId: ENVELOPE_A, recipientId: RECIPIENT_A, pageNumber: 1, orderIndex: 0 }]],
    [
      signRecipients,
      [
        {
          id: RECIPIENT_A,
          orgId: ORG_A,
          envelopeId: ENVELOPE_A,
          routingOrder: 1,
          name: "Signer",
          email: "signer@example.com",
          status: "invited",
          accessCodeHash: "hidden",
          otpCodeHash: "hidden",
          signingTokenHash: "hidden",
        },
      ],
    ],
    [
      signDocuments,
      [{ id: DOCUMENT_A, orgId: ORG_A, envelopeId: ENVELOPE_A, orderIndex: 0, currentFileKey: `${ORG_A}/sign/${DOCUMENT_A}.pdf`, originalFileKey: `${ORG_A}/sign/${DOCUMENT_A}.pdf`, mimeType: "application/pdf" }],
    ],
    [signAuditEvents, [{ id: 4441, orgId: ORG_A, envelopeId: ENVELOPE_A, createdAt: new Date("2026-09-01T00:00:00Z") }]],
  ]);
}

const KEYS = ["sign:envelope:create", "sign:envelope:send", "sign:envelope:void", "sign:envelope:correct", "sign:documents:view", "sign:documents:upload", "sign:audit:view"];

function scopes(view: DataScope): Record<string, DataScope> {
  return Object.fromEntries([...KEYS.map((key): [string, DataScope] => [key, "all"]), ["sign:envelope:view", view]]);
}

const SENDER_OWN: SignActor = { standing: "org:member", orgId: ORG_A, scopes: scopes("own") };
const NON_SENDER_OWN: SignActor = { standing: "module:member", orgId: ORG_A, scopes: scopes("own") };
const ADMIN: SignActor = { standing: "org:admin", orgId: ORG_A, scopes: scopes("all") };
const FOREIGN: SignActor = { standing: "org:admin", orgId: ORG_B, scopes: scopes("all") };

interface Case {
  readonly suffix: string;
  readonly actor: SignActor;
  readonly state: ScenarioState;
  readonly expected: ExpectedOutcome;
  readonly because: string;
  readonly run: () => Promise<Observation>;
}

function family(prefix: string, resource: string, action: string, adapter: AdapterKind, entry: string, cases: readonly Case[]): Scenario[] {
  const allowed = cases.find((item) => item.expected === "allow");
  return cases.map((item) => ({
    id: `${prefix}-${item.suffix}`,
    actor: item.actor.standing,
    resource,
    action,
    tenant: item.actor.orgId === ORG_A ? "same" : "other",
    state: item.state,
    expected: item.expected,
    because: item.because,
    pairedWith: item.expected === "allow" || allowed === undefined ? undefined : `${prefix}-${allowed.suffix}`,
    bindings: [{ adapter, entry, run: item.run }],
  }));
}

function bodyText(body: unknown): string {
  return JSON.stringify(body);
}

interface ChildRoute {
  readonly child: "fields" | "recipients" | "documents";
  readonly controller: Type<unknown>;
  readonly table: string;
  readonly key: string;
}

const CHILDREN: readonly ChildRoute[] = [
  { child: "fields", controller: SignFieldsController, table: "sign_fields", key: "sign:envelope:view" },
  { child: "recipients", controller: SignRecipientsController, table: "sign_recipients", key: "sign:envelope:view" },
  { child: "documents", controller: SignDocumentsController, table: "sign_documents", key: "sign:documents:view" },
];

function childList(world: WorldDb, route: ChildRoute, actor: SignActor, envelopeId: number): Promise<Observation> {
  const req: SignRequest = { controller: route.controller, wiring: "lists", verb: "get", path: `/sign/envelopes/${envelopeId}/${route.child}`, permissionKey: route.key };
  return sendSign(world, actor, req).then((exchange) => {
    const allowed = exchange.outcome === "allow";
    const rows = Array.isArray(exchange.body) ? exchange.body : [];
    const checks: Record<string, boolean> = {
      controllerResolvedTheEnvelopeViewScope: exchange.asked.includes("sign:envelope:view"),
      childTableReadOnlyWhenEnvelopeVisible: allowed === exchange.reads.includes(route.table),
      returnsOnlyTheEnvelopesOwnChildren: !allowed || (rows.length === 1 && rows.every((row) => row !== null && typeof row === "object" && "envelopeId" in row && row.envelopeId === envelopeId)),
    };
    if (route.child === "documents") checks.documentsKeyAskedOnlyByTheGuard = exchange.asked.filter((key) => key === "sign:documents:view").length === 1;
    if (route.child === "recipients") checks.recipientSecretsNeverReturned = rows.every((row) => row !== null && typeof row === "object" && !("signingTokenHash" in row) && !("accessCodeHash" in row));
    return { outcome: exchange.outcome, checks };
  });
}

async function sameAsCrossTenant(absent: () => Promise<{ outcome: Observation["outcome"]; body: unknown }>, cross: () => Promise<{ outcome: Observation["outcome"]; body: unknown }>): Promise<Observation> {
  const left = await absent();
  const right = await cross();
  return { outcome: left.outcome, checks: { answeredExactlyAsACrossTenantId: right.outcome === left.outcome && bodyText(right.body) === bodyText(left.body) } };
}

function childScenarios(world: WorldDb): Scenario[] {
  return CHILDREN.flatMap((route) => {
    const raw = (actor: SignActor, envelopeId: number) => () =>
      sendSign(world, actor, { controller: route.controller, wiring: "lists", verb: "get", path: `/sign/envelopes/${envelopeId}/${route.child}`, permissionKey: route.key });
    return family(`sign-${route.child}-list`, `sign:${route.child}`, "list", "http", `GET /sign/envelopes/:envelopeId/${route.child} (${SIGN_ENTRY_SHIM})`, [
      { suffix: "sender", actor: SENDER_OWN, state: "scope-narrowed", expected: "allow", because: "an own-scoped sender sees its own envelope's children", run: () => childList(world, route, SENDER_OWN, ENVELOPE_A) },
      { suffix: "org-admin", actor: ADMIN, state: "normal", expected: "allow", because: "an unrestricted view scope reaches every envelope of the organisation", run: () => childList(world, route, ADMIN, ENVELOPE_A) },
      { suffix: "own-scope-excluded", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "an in-org envelope the caller's own scope excludes is not found and its children are never read", run: () => childList(world, route, NON_SENDER_OWN, ENVELOPE_A) },
      { suffix: "cross-tenant", actor: FOREIGN, state: "normal", expected: "404", because: "another organisation's envelope id is a 404, never 403 and never an empty 200", run: () => childList(world, route, FOREIGN, ENVELOPE_A) },
      { suffix: "absent", actor: ADMIN, state: "normal", expected: "404", because: "an id belonging to no organisation answers exactly as a cross-tenant one", run: () => sameAsCrossTenant(raw(ADMIN, ABSENT_ENVELOPE), raw(FOREIGN, ENVELOPE_A)) },
    ]);
  });
}

function auditScenarios(world: WorldDb): Scenario[] {
  const run = (actor: SignActor, envelopeId: number) => async (): Promise<Observation> => {
    const exchange = await sendSign(world, actor, { controller: SignCertificatesController, wiring: "lists", verb: "get", path: `/sign/envelopes/${envelopeId}/audit`, permissionKey: "sign:audit:view" });
    return { outcome: exchange.outcome, checks: { auditEventsReadOnlyWhenVisible: (exchange.outcome === "allow") === exchange.reads.includes("sign_audit_events") } };
  };
  return family("sign-audit-list", "sign:audit", "list", "http", "GET /sign/envelopes/:envelopeId/audit -> SignAuditService.listForEnvelope", [
    { suffix: "org-admin", actor: ADMIN, state: "normal", expected: "allow", because: "the audit list resolves the envelope under the caller's scope first", run: run(ADMIN, ENVELOPE_A) },
    { suffix: "cross-tenant", actor: FOREIGN, state: "normal", expected: "404", because: "another organisation's envelope id is not found and no audit row is selected", run: run(FOREIGN, ENVELOPE_A) },
    { suffix: "own-scope-excluded", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "an envelope the own scope excludes yields no audit trail", run: run(NON_SENDER_OWN, ENVELOPE_A) },
  ]);
}

function previewScenarios(world: WorldDb): Scenario[] {
  const raw = (actor: SignActor, documentId: number) => () =>
    sendSign(world, actor, { controller: SignDocumentsController, wiring: "lists", verb: "get", path: `/sign/documents/${documentId}/preview`, permissionKey: "sign:documents:view" });
  const run = (actor: SignActor, documentId: number) => async (): Promise<Observation> => {
    const exchange = await raw(actor, documentId)();
    const allowed = exchange.outcome === "allow";
    return {
      outcome: exchange.outcome,
      checks: {
        mintsAUrlOnlyWhenTheEnvelopeIsVisible: allowed ? exchange.signed.length === 1 && exchange.signed[0]?.orgId === actor.orgId : exchange.signed.length === 0,
        controllerResolvedTheEnvelopeViewScope: exchange.asked.includes("sign:envelope:view"),
      },
    };
  };
  return family("sign-document-preview", "sign:document", "preview", "file", `GET /sign/documents/:documentId/preview -> signed URL (${SIGN_ENTRY_SHIM})`, [
    { suffix: "sender", actor: SENDER_OWN, state: "scope-narrowed", expected: "allow", because: "the preview URL is minted when the caller's envelope view scope admits the envelope", run: run(SENDER_OWN, DOCUMENT_A) },
    { suffix: "own-scope-excluded", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "sign:documents:view is not scopable, so the preview binds to the envelope's view scope and mints nothing for an excluded envelope", run: run(NON_SENDER_OWN, DOCUMENT_A) },
    { suffix: "excluded-matches-missing", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "a withheld document answers the same 404 body as a missing one, so it is no existence oracle", run: () => sameAsCrossTenant(raw(NON_SENDER_OWN, DOCUMENT_A), raw(ADMIN, ABSENT_DOCUMENT)) },
    { suffix: "cross-tenant", actor: FOREIGN, state: "normal", expected: "404", because: "another organisation's document id is not found and no URL is minted", run: run(FOREIGN, DOCUMENT_A) },
  ]);
}

interface Mutation {
  readonly name: string;
  readonly controller: Type<unknown>;
  readonly verb: "post" | "patch" | "delete";
  readonly path: (id: number) => string;
  readonly id: number;
  readonly body?: object;
  readonly key: string;
  readonly method: string;
}

const MUTATIONS: readonly Mutation[] = [
  { name: "envelope-send", controller: SignEnvelopesController, verb: "post", path: (id) => `/sign/envelopes/${id}/send`, id: ENVELOPE_A, key: "sign:envelope:send", method: "send" },
  { name: "envelope-void", controller: SignEnvelopesController, verb: "post", path: (id) => `/sign/envelopes/${id}/void`, id: ENVELOPE_A, body: { reason: "x" }, key: "sign:envelope:void", method: "voidEnvelope" },
  { name: "envelope-correct", controller: SignEnvelopesController, verb: "post", path: (id) => `/sign/envelopes/${id}/correct`, id: ENVELOPE_A, body: {}, key: "sign:envelope:correct", method: "correct" },
  { name: "envelope-extend", controller: SignEnvelopesController, verb: "post", path: (id) => `/sign/envelopes/${id}/extend-expiration`, id: ENVELOPE_A, body: { expiresAt: "2030-01-01T00:00:00.000Z" }, key: "sign:envelope:correct", method: "extendExpiration" },
  { name: "recipient-update", controller: SignRecipientsController, verb: "patch", path: (id) => `/sign/recipients/${id}`, id: RECIPIENT_A, body: { name: "x" }, key: "sign:envelope:create", method: "update" },
  { name: "recipient-remove", controller: SignRecipientsController, verb: "delete", path: (id) => `/sign/recipients/${id}`, id: RECIPIENT_A, key: "sign:envelope:create", method: "remove" },
  { name: "field-update", controller: SignFieldsController, verb: "patch", path: (id) => `/sign/fields/${id}`, id: FIELD_A, body: { pageNumber: 1 }, key: "sign:envelope:create", method: "update" },
  { name: "field-remove", controller: SignFieldsController, verb: "delete", path: (id) => `/sign/fields/${id}`, id: FIELD_A, key: "sign:envelope:create", method: "remove" },
  { name: "document-remove", controller: SignDocumentsController, verb: "delete", path: (id) => `/sign/documents/${id}`, id: DOCUMENT_A, key: "sign:documents:upload", method: "delete" },
];

function mutationScenarios(world: WorldDb): Scenario[] {
  return MUTATIONS.flatMap((mutation) => {
    const run = (actor: SignActor) => async (): Promise<Observation> => {
      const exchange = await sendSign(world, actor, { controller: mutation.controller, wiring: "mutations", verb: mutation.verb, path: mutation.path(mutation.id), body: mutation.body, permissionKey: mutation.key });
      const allowed = exchange.outcome === "allow";
      const call = exchange.recorded.find((entry) => entry.method === mutation.method);
      return {
        outcome: exchange.outcome,
        checks: {
          serviceReachedOnlyThroughTheGate: allowed ? call !== undefined : exchange.recorded.length === 0,
          serviceReceivesTheCallersOrg: call === undefined || call.args[0] === actor.orgId,
          serviceReceivesTheAddressedId: call === undefined || call.args[1] === mutation.id,
          serviceReceivesTheCallerAsActor:
            call === undefined ||
            mutation.method === "delete" ||
            call.args.some((arg) => arg !== null && typeof arg === "object" && "userId" in arg && arg.userId === userOf(actor.standing, actor.orgId)),
          envelopeScopeAppliedInTheCallersOrg: actor.orgId !== ORG_A || exchange.reads.includes("sign_envelopes"),
        },
      };
    };
    return family(`sign-${mutation.name}`, `sign:${mutation.name.split("-")[0]}`, mutation.name.split("-")[1] ?? mutation.name, "http", `${mutation.verb.toUpperCase()} ${mutation.path(0).replace("/0", "/:id")} -> SignEnvelopeAccessService gate (service behind it is a recorder)`, [
      { suffix: "org-admin", actor: ADMIN, state: "normal", expected: "allow", because: "an unrestricted view scope admits the envelope and the gate hands the call to the service", run: run(ADMIN) },
      { suffix: "own-scope-excluded", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "a non-scopable mutation key does not let an own-scoped caller name an envelope its view scope withholds", run: run(NON_SENDER_OWN) },
      { suffix: "cross-tenant", actor: FOREIGN, state: "normal", expected: "404", because: "another organisation's id answers the same 404 a read would and the service is never reached", run: run(FOREIGN) },
    ]);
  });
}

function summarizeScenarios(world: WorldDb): Scenario[] {
  const raw = (actor: SignActor, envelopeId: number) => () =>
    sendSign(world, actor, { controller: SignAiController, wiring: "lists", verb: "post", path: `/sign/envelopes/${envelopeId}/ai/summarize`, permissionKey: "sign:envelope:view" });
  const run = (actor: SignActor, envelopeId: number) => async (): Promise<Observation> => {
    const exchange = await raw(actor, envelopeId)();
    const allowed = exchange.outcome === "allow";
    const body = exchange.body;
    return {
      outcome: exchange.outcome,
      checks: {
        documentsReadOnlyWhenVisible: allowed === exchange.reads.includes("sign_documents"),
        noObjectStoreOrAiCallOnRefusal: allowed || (exchange.streamed.length === 0 && exchange.invoked.length === 0),
        emptyEnvelopeSummarisedWithoutSpend:
          !allowed || (body !== null && typeof body === "object" && "summary" in body && body.summary === "No documents attached to this envelope." && exchange.invoked.length === 0),
        controllerResolvedTheEnvelopeViewScope: exchange.asked.filter((key) => key === "sign:envelope:view").length === 2,
      },
    };
  };
  return family("sign-envelope-summarize", "sign:envelope", "summarize", "http", `POST /sign/envelopes/:envelopeId/ai/summarize -> SignAiService.summarizeDocument (${SIGN_ENTRY_SHIM})`, [
    { suffix: "sender", actor: SENDER_OWN, state: "scope-narrowed", expected: "allow", because: "an own-scoped sender summarizes its own envelope", run: run(SENDER_OWN, EMPTY_ENVELOPE_A) },
    { suffix: "own-scope-excluded", actor: NON_SENDER_OWN, state: "scope-narrowed", expected: "404", because: "the escalation the fix closes: an envelope the caller's own scope excludes is not found, no document is read and no credit is spent", run: run(NON_SENDER_OWN, ENVELOPE_A) },
    { suffix: "cross-tenant", actor: FOREIGN, state: "normal", expected: "404", because: "another organisation's envelope id is NotFound, never Forbidden", run: run(FOREIGN, ENVELOPE_A) },
    { suffix: "absent", actor: ADMIN, state: "normal", expected: "404", because: "a cross-tenant id and an absent id answer identically", run: () => sameAsCrossTenant(raw(ADMIN, ABSENT_ENVELOPE), raw(FOREIGN, ENVELOPE_A)) },
  ]);
}

export function signScenarios(world: WorldDb): Scenario[] {
  return [...childScenarios(world), ...auditScenarios(world), ...previewScenarios(world), ...mutationScenarios(world), ...summarizeScenarios(world)];
}
