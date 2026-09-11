import { Logger } from "@nestjs/common";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { validateEnv } from "../../../../config/env.validation";
import { ComplianceTransportRegistry } from "./compliance-transport.registry";
import { LiveIrpAdapter, idempotencyKeyFor } from "./live-irp.adapter";
import { MockIrpAdapter } from "./mock-irp.adapter";
import { buildIrpRequest } from "./live-irp.request";
import { interpretIrpResponse, parseIrpTimestamp } from "./live-irp.response";
import type { CompliancePayload } from "./compliance-transport.port";

/**
 * ACC-14. The live IRP provider, exercised against a stub HTTP server on
 * loopback.
 *
 * A stub, and never a recording from a real account, for two reasons. A captured
 * response from a live IRP carries a real IRN against a real taxpayer's GSTIN,
 * and a fixture that convincing is one copy-paste away from being presented as
 * evidence of a filing — the risk ACC-13's mock is shaped around. And a
 * recording cannot produce the failures that matter most here: the socket that
 * accepts and never answers, the gateway that returns HTML, the provider that
 * quotes a credential back in an error message.
 *
 * What is asserted throughout is one property: **the only outcome that may be
 * called a filing is an acknowledgement the portal actually issued.** Every
 * other path — refused credentials, a 5xx, a timeout, an unreadable body, a
 * document that was never sent — comes back `unavailable`, which
 * `ComplianceService` records as still-`pending`, because the authority has
 * judged nothing.
 */

const PAYLOAD: CompliancePayload = {
  documentType: "sales_invoice",
  documentId: "inv-1",
  documentNumber: "INV-2026-0001",
  documentDate: "2026-09-01",
  sellerTaxId: "29AABCU9603R1ZM",
  buyerTaxId: "27AAACI1195H1ZT",
  currency: "INR",
  totalMinor: 118_000,
};

/** Distinctive on purpose: every one is grepped for by the redaction tests. */
const CLIENT_ID = "gsp-client-id-7f21";
const CLIENT_SECRET = "gsp-client-secret-a41c9d";
const USERNAME = "gst-api-user";
const PASSWORD = "gst-api-password-b83e7f";
const SECRETS = [CLIENT_ID, CLIENT_SECRET, PASSWORD];

const ACCEPTED = {
  Status: "1",
  Data: {
    Irn: "a5c12dca9b3c1f3d4ee1c0ef5cbb2b2a0f3eaf8f9e2b3c4d5e6f7a8b9c0d1e2f",
    AckNo: 112_420_000_000_123,
    AckDt: "2026-09-01 14:20:00",
    SignedQRCode: "eyJhbGciOiJSUzI1NiJ9.signed-qr-payload.signature",
  },
};

interface Stub {
  url: string;
  /** Everything the adapter sent, so the request itself can be asserted on. */
  received: Array<{ method: string; headers: Record<string, string>; body: string }>;
  close: () => Promise<void>;
}

type Responder = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * A one-endpoint HTTP server on an ephemeral loopback port.
 *
 * Ephemeral because several of these run in one file, and a fixed port makes a
 * suite that fails only while somebody else is running the other one.
 */
async function startStub(respond: Responder): Promise<Stub> {
  const received: Stub["received"] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      received.push({
        method: request.method ?? "",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(request, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub server did not bind a port");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/einvoice/generate`,
    received,
    /* Idempotent: one test closes the server early to make the port refuse. */
    close: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            closed = true;
            /* The timeout test leaves a request open; it has to be cut. */
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
  };
}

/** Start a stub, run one test against it, and always shut it down. */
async function withStub<T>(respond: Responder, run: (stub: Stub) => Promise<T>): Promise<T> {
  const stub = await startStub(respond);
  try {
    return await run(stub);
  } finally {
    await stub.close();
  }
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const respondWith = (status: number, body: unknown): Responder => {
  return (_request, response) => json(response, status, body);
};

function adapterFor(url: string | undefined, timeoutMs = 2_000): LiveIrpAdapter {
  return new LiveIrpAdapter({
    COMPLIANCE_IRP_URL: url,
    COMPLIANCE_IRP_CLIENT_ID: CLIENT_ID,
    COMPLIANCE_IRP_CLIENT_SECRET: CLIENT_SECRET,
    COMPLIANCE_IRP_USERNAME: USERNAME,
    COMPLIANCE_IRP_PASSWORD: PASSWORD,
    COMPLIANCE_IRP_TIMEOUT_MS: timeoutMs,
  });
}

describe("the live IRP adapter files a document", () => {
  it("records the portal's acknowledgement, and only the portal's", async () => {
    const result = await withStub(respondWith(200, ACCEPTED), (stub) =>
      adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.authorityId).toBe(ACCEPTED.Data.Irn);
    expect(result.ackNo).toBe("112420000000123");
    /*
      The IRP writes IST with no offset. Asserted as an instant rather than as a
      local string, because reading it in the host's timezone is how an
      acknowledgement moves by five and a half hours — and by a day, for one
      issued near midnight.
    */
    expect(result.ackAt.toISOString()).toBe("2026-09-01T08:50:00.000Z");
  });

  it("sends the portal's own field names, and the document's own figures", async () => {
    const sent = await withStub(respondWith(200, ACCEPTED), async (stub) => {
      await adapterFor(stub.url).submit(PAYLOAD);
      expect(stub.received).toHaveLength(1);
      return JSON.parse(stub.received[0].body);
    });

    expect(sent).toMatchObject({
      TranDtls: { TaxSch: "GST", SupTyp: "B2B" },
      /* dd/mm/yyyy, not the ISO date the ledger stores — 01/09, never 09/01. */
      DocDtls: { Typ: "INV", No: "INV-2026-0001", Dt: "01/09/2026" },
      SellerDtls: { Gstin: "29AABCU9603R1ZM" },
      BuyerDtls: { Gstin: "27AAACI1195H1ZT" },
      /* Minor units in the ledger, rupees on the wire: 118000 is 1180.00. */
      ValDtls: { TotInvVal: 1180 },
    });
  });

  it("carries the credentials as headers and the document's identity as an idempotency key", async () => {
    const received = await withStub(respondWith(200, ACCEPTED), async (stub) => {
      await adapterFor(stub.url).submit(PAYLOAD);
      await adapterFor(stub.url).submit(PAYLOAD);
      return stub.received;
    });

    const [first, second] = received;
    expect(first.method).toBe("POST");
    expect(first.headers["client_id"]).toBe(CLIENT_ID);
    expect(first.headers["user_name"]).toBe(USERNAME);
    expect(first.headers["gstin"]).toBe(PAYLOAD.sellerTaxId);
    /*
      Stable across submissions of the same document, so a GSP that dedupes on
      the header cannot be made to register one invoice twice by a retry.
    */
    expect(first.headers["idempotency-key"]).toBe(idempotencyKeyFor(PAYLOAD));
    expect(second.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(idempotencyKeyFor({ ...PAYLOAD, documentId: "inv-2" })).not.toBe(
      first.headers["idempotency-key"],
    );
  });

  it("returns the IRN the portal already issued rather than asking for a second one", async () => {
    /*
      The outermost idempotency fence, and the one that still holds when a crash
      lost the first response. A duplicate arrives as a FAILURE — status 0,
      error 2150 — with the existing registration tucked into `InfoDtls`. Read
      in order, it is a rejection, and somebody is sent to correct an invoice the
      government already holds.
    */
    const result = await withStub(
      respondWith(200, {
        Status: "0",
        ErrorDetails: [{ ErrorCode: "2150", ErrorMessage: "Duplicate IRN" }],
        InfoDtls: [{ InfCd: "DUPIRN", Desc: ACCEPTED.Data }],
      }),
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.authorityId).toBe(ACCEPTED.Data.Irn);
  });
});

describe("the live IRP adapter fails honestly", () => {
  it("records a provider rejection with the portal's own code", async () => {
    const result = await withStub(
      respondWith(200, {
        Status: "0",
        ErrorDetails: [
          {
            ErrorCode: "2172",
            ErrorMessage: "For intra-state transaction IGST amounts is not applicable",
          },
        ],
      }),
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.errors).toEqual([
      { code: "2172", message: "For intra-state transaction IGST amounts is not applicable" },
    ]);
  });

  it("calls a 5xx unavailable, never rejected", async () => {
    /*
      The distinction the port's third outcome exists for. A rejection is a
      judgement of the document and sends somebody to correct an invoice; a 502
      says the portal fell over and the invoice may be perfectly good.
    */
    const result = await withStub(respondWith(502, { message: "upstream down" }), (stub) =>
      adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("unavailable");
    if (result.outcome !== "unavailable") return;
    expect(result.reason).toMatch(/502/);
    expect(result.reason).toMatch(/not filed/);
  });

  it("calls a timeout unavailable, and says a retry is safe", async () => {
    /*
      The most dangerous of the five: the request reached the portal and the
      answer did not come back, so the document may well be registered. Neither
      "filed" nor "rejected" is a statement anybody can make about it.
    */
    const result = await withStub(
      () => {
        /* Accept the request and never answer it. */
      },
      (stub) => adapterFor(stub.url, 150).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("unavailable");
    if (result.outcome !== "unavailable") return;
    expect(result.reason).toMatch(/did not answer within 150ms/);
    expect(result.reason).toMatch(/may or may not have been registered/);
  });

  it("calls refused credentials unavailable, and never quotes the response", async () => {
    /*
      A 401 is not a judgement of the invoice, and it is the response most likely
      to echo what it was sent — so the body is not read at all.
    */
    const result = await withStub(
      respondWith(401, { message: `invalid credentials for ${PASSWORD}` }),
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("unavailable");
    if (result.outcome !== "unavailable") return;
    expect(result.reason).not.toContain(PASSWORD);
    expect(result.reason).toMatch(/did not accept this deployment's credentials/);
  });

  it("calls a body it cannot read unavailable rather than guessing at it", async () => {
    const result = await withStub(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body>Gateway timeout</body></html>");
      },
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("unavailable");
  });

  it("refuses to call a document filed when the portal's acknowledgement is incomplete", async () => {
    /*
      An IRN with no readable acknowledgement date. `accepted` is the one state
      the product renders as filed, and it renders it on the strength of the
      stored evidence — two thirds of an acknowledgement is not evidence. The
      IRN goes into the reason, where a person reads it, so nothing is lost.
    */
    const result = await withStub(
      respondWith(200, { Status: "1", Data: { Irn: ACCEPTED.Data.Irn, AckDt: "yesterday" } }),
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("unavailable");
    if (result.outcome !== "unavailable") return;
    expect(result.reason).toContain(ACCEPTED.Data.Irn);
    expect(result.reason).toMatch(/confirm it on the portal/);
  });

  it("calls a provider it cannot reach unavailable", async () => {
    const result = await withStub(respondWith(200, ACCEPTED), async (stub) => {
      await stub.close();
      return adapterFor(stub.url).submit(PAYLOAD);
    });

    expect(result.outcome).toBe("unavailable");
  });
});

describe("the live IRP adapter without credentials", () => {
  it("is not configured, and says which variables are missing without naming a value", () => {
    const adapter = new LiveIrpAdapter({});

    expect(adapter.isConfigured()).toBe(false);
    const problem = adapter.configurationProblem() ?? "";
    expect(problem).toMatch(/COMPLIANCE_IRP_URL/);
    expect(problem).toMatch(/COMPLIANCE_IRP_PASSWORD/);
  });

  it("is not configured when one of the five is missing", () => {
    /*
      The failure this ticket is named after. Four set and one forgotten would
      otherwise produce an adapter that looks live on a screen and sends a
      request with a blank header.
    */
    const adapter = new LiveIrpAdapter({
      COMPLIANCE_IRP_URL: "https://gsp.example.com/einvoice",
      COMPLIANCE_IRP_CLIENT_ID: CLIENT_ID,
      COMPLIANCE_IRP_CLIENT_SECRET: CLIENT_SECRET,
      COMPLIANCE_IRP_USERNAME: USERNAME,
    });

    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.configurationProblem()).toMatch(/COMPLIANCE_IRP_PASSWORD/);
  });

  it("refuses a plain-HTTP provider, which would put the password on the wire", () => {
    const adapter = adapterFor("http://gsp.example.com/einvoice");

    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.configurationProblem()).toMatch(/must be https/);
  });

  it("refuses to file, saying nothing was sent", async () => {
    const result = await new LiveIrpAdapter({}).submit(PAYLOAD);

    expect(result.outcome).toBe("unavailable");
    if (result.outcome !== "unavailable") return;
    expect(result.reason).toMatch(/No e-invoice credentials are configured/);
    expect(result.reason).toMatch(/nothing was sent/);
  });
});

describe("the live IRP adapter never echoes a credential", () => {
  it("strips a secret a provider quotes back in an error message", async () => {
    /*
      The error text lands in `gl_document_compliance.errors`, which is served to
      a screen and kept in every backup of that database. One GSP quoting a
      header back would otherwise leak the password into both.
    */
    const result = await withStub(
      respondWith(200, {
        Status: "0",
        ErrorDetails: [
          {
            ErrorCode: "1005",
            ErrorMessage: `Invalid token for client ${CLIENT_ID} / ${CLIENT_SECRET}`,
          },
        ],
      }),
      (stub) => adapterFor(stub.url).submit(PAYLOAD),
    );

    expect(result.outcome).toBe("rejected");
    const serialised = JSON.stringify(result);
    for (const secret of SECRETS) expect(serialised).not.toContain(secret);
    expect(serialised).toContain("[redacted]");
  });

  it("keeps every secret out of the logs, on the paths that log", async () => {
    const spies = [
      jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
    ];

    try {
      await withStub(respondWith(401, { message: PASSWORD }), (stub) =>
        adapterFor(stub.url).submit(PAYLOAD),
      );
      await withStub(
        () => {
          /* Never answers, so the timeout branch logs too. */
        },
        (stub) => adapterFor(stub.url, 100).submit(PAYLOAD),
      );

      const emitted = spies.flatMap((spy) =>
        spy.mock.calls.map((call) => call.map((argument) => String(argument)).join(" ")),
      );

      expect(emitted.length).toBeGreaterThan(0);
      for (const line of emitted) {
        for (const secret of SECRETS) expect(line).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("what the live adapter refuses to send at all", () => {
  /*
    `CompliancePayload` is eight fields shared with every e-reporting network,
    and the IRP's mandatory set is larger. Where the gap would have to be closed
    by inventing a fact about the tenant's supply, the adapter refuses — and the
    refusal is `unavailable`, so the row stays `pending` and the screen keeps
    saying the true thing: reportable, not filed, file it directly.

    Each of these is a gap in the port, not a quirk of this vendor. None of them
    opens a socket.
  */
  const refusal = async (payload: CompliancePayload): Promise<string> => {
    const result = await adapterFor("https://gsp.example.invalid/einvoice").submit(payload);
    expect(result.outcome).toBe("unavailable");
    return result.outcome === "unavailable" ? result.reason : "";
  };

  it("a document type the portal has no code for", async () => {
    expect(await refusal({ ...PAYLOAD, documentType: "proforma" })).toMatch(/no document type/);
  });

  it("a document in a currency it holds no rate for", async () => {
    /* The portal states a rupee figure; inventing one would send it to a tax authority. */
    expect(await refusal({ ...PAYLOAD, currency: "USD" })).toMatch(/made up/);
  });

  it("a document with no buyer tax id, whose supply type it cannot prove", async () => {
    /*
      Not provably a B2B supply, and the port carries no supply nature — so it is
      an export, an SEZ supply or a supply to an unregistered person, and filing
      it as B2B would be a wrong filing rather than a missing one.
    */
    expect(await refusal({ ...PAYLOAD, buyerTaxId: null })).toMatch(/wrong filing/);
  });

  it("builds a request for the one shape it can prove", () => {
    /* Anti-vacuity: the refusals above must not have swallowed everything. */
    expect(buildIrpRequest(PAYLOAD).ok).toBe(true);
  });
});

describe("reading the portal's answer", () => {
  it("reads both acknowledgement formats as the same instant", () => {
    expect(parseIrpTimestamp("2026-09-01 14:20:00")?.toISOString()).toBe(
      "2026-09-01T08:50:00.000Z",
    );
    expect(parseIrpTimestamp("01/09/2026 14:20:00")?.toISOString()).toBe(
      "2026-09-01T08:50:00.000Z",
    );
    expect(parseIrpTimestamp("1 Sep 2026")).toBeNull();
  });

  it("never reads an answer it does not understand as an acceptance", () => {
    for (const body of [null, "", 42, {}, { Status: "1" }, { Data: {} }, { ErrorDetails: [] }]) {
      expect(interpretIrpResponse(body).outcome).toBe("unavailable");
    }
  });

  it("does not depend on the Status flag, which every GSP spells differently", () => {
    /* The evidence is the IRN, not the flag: "1", 0 and absent all read alike. */
    expect(interpretIrpResponse({ Data: ACCEPTED.Data }).outcome).toBe("accepted");
    expect(interpretIrpResponse({ Status: 0, Data: ACCEPTED.Data }).outcome).toBe("accepted");
  });
});

describe("which adapter a deployment gets", () => {
  const registry = (
    transport: "none" | "mock" | "irp" | undefined,
    nodeEnv: "development" | "production",
    live: LiveIrpAdapter,
  ) =>
    new ComplianceTransportRegistry(
      { COMPLIANCE_TRANSPORT: transport, NODE_ENV: nodeEnv },
      new MockIrpAdapter(),
      live,
    );

  const configured = () => adapterFor("https://gsp.example.com/einvoice");
  const unconfigured = () => new LiveIrpAdapter({});

  it("selects the live adapter only when its credentials are present", () => {
    const resolved = registry("irp", "production", configured()).resolve();

    expect(resolved).toBeInstanceOf(LiveIrpAdapter);
    expect(resolved?.isReal).toBe(true);
    expect(resolved?.transport).toBe("irp");
  });

  it("resolves nothing when the live transport is asked for without credentials", () => {
    /*
      The quiet half of "block if no creds". The loud half is the boot refusal
      below; this is what a node that somehow started does anyway — which is
      nothing, rather than a request with blank headers.
    */
    expect(registry("irp", "production", unconfigured()).resolve()).toBeNull();
    expect(registry("irp", "production", unconfigured()).describe()).toEqual({
      configured: false,
      real: false,
      name: expect.stringMatching(/must be filed directly with the authority/),
    });
  });

  it("refuses to boot a node that claims a live transport it cannot use", () => {
    expect(() => registry("irp", "production", unconfigured()).onModuleInit()).toThrow(
      /COMPLIANCE_TRANSPORT=irp/,
    );
    expect(() => registry("irp", "production", unconfigured()).onModuleInit()).toThrow(
      /COMPLIANCE_IRP_URL/,
    );
  });

  it("never names a credential in the boot refusal", () => {
    /* A boot error lives as long as the logs do — variables only, never values. */
    let message = "";
    try {
      registry("irp", "production", unconfigured()).onModuleInit();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe("");
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it("leaves the mock and the refusal paths exactly as they were", () => {
    /*
      Today's behaviour, which the presence or absence of credentials must not
      change: nothing configured resolves nothing, and `mock` still resolves the
      mock outside production and nothing inside it.
    */
    expect(registry(undefined, "development", configured()).resolve()).toBeNull();
    expect(registry("none", "development", configured()).resolve()).toBeNull();
    expect(registry("mock", "development", configured()).resolve()).toBeInstanceOf(MockIrpAdapter);
    expect(registry("mock", "production", configured()).resolve()).toBeNull();
  });

  it("boots quietly when the live transport is configured and usable", () => {
    expect(() => registry("irp", "production", configured()).onModuleInit()).not.toThrow();
  });
});

describe("the environment cannot claim a live transport it has not been given", () => {
  /*
    The loud half of "block if no creds", one layer earlier than the registry:
    the schema refuses the boot outright, in every environment, so a partial
    credential set is a failed deploy rather than a node that advertises a live
    transport and files nothing. Kept here rather than in `env-coverage.spec.ts`
    because the rule is about this adapter, and it should fail beside it.
  */
  const BASE = {
    DATABASE_URL: "postgres://user:pass@host/db",
    BACKEND_JWT_SECRET: "a".repeat(44),
    PORTAL_JWT_SECRET: "b".repeat(44),
    CORS_ORIGINS: "https://app.example.com",
    APP_URL: "https://app.example.com",
    ENCRYPTION_KEY: "c".repeat(32),
  };

  const CREDENTIALS = {
    COMPLIANCE_IRP_URL: "https://gsp.example.com/einvoice",
    COMPLIANCE_IRP_CLIENT_ID: CLIENT_ID,
    COMPLIANCE_IRP_CLIENT_SECRET: CLIENT_SECRET,
    COMPLIANCE_IRP_USERNAME: USERNAME,
    COMPLIANCE_IRP_PASSWORD: PASSWORD,
  };

  it("refuses a partial credential set, naming what is missing", () => {
    const { COMPLIANCE_IRP_PASSWORD: _withheld, ...partial } = CREDENTIALS;

    expect(() => validateEnv({ ...BASE, ...partial, COMPLIANCE_TRANSPORT: "irp" })).toThrow(
      /COMPLIANCE_IRP_PASSWORD/,
    );
  });

  it("accepts the whole set", () => {
    expect(() =>
      validateEnv({ ...BASE, ...CREDENTIALS, COMPLIANCE_TRANSPORT: "irp" }),
    ).not.toThrow();
  });

  it("leaves every deployment that asks for nothing exactly as it was", () => {
    /* Including one that has credentials lying around but has not opted in. */
    expect(() => validateEnv(BASE)).not.toThrow();
    expect(() => validateEnv({ ...BASE, ...CREDENTIALS })).not.toThrow();
    expect(validateEnv({ ...BASE, ...CREDENTIALS }).COMPLIANCE_TRANSPORT).toBeUndefined();
  });
});
