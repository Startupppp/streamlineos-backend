import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe as narrate } from "../compliance-narrative";
import { ComplianceTransportRegistry } from "./compliance-transport.registry";
import { LiveIrpAdapter } from "./live-irp.adapter";
import { MockIrpAdapter } from "./mock-irp.adapter";
import type { CompliancePayload, ComplianceTransportAdapter } from "./compliance-transport.port";

/**
 * ACC-13. A transport seam and a mock behind it, built before anyone has GST
 * portal credentials.
 *
 * The danger of a mock like this is the whole reason for how it is written. A
 * convincing one is worse than none: the moment its output reaches a report, a
 * screenshot or a support conversation it becomes a claim that a statutory
 * filing happened. So ACC-12's ban on writing an acknowledgement is not lifted
 * for the adapter — it is *replaced*, by the rules asserted at the bottom of
 * this file, which are stronger than the ban was.
 */

const PAYLOAD: CompliancePayload = {
  documentType: "sales_invoice",
  documentId: "inv-1",
  documentNumber: "INV-2026-0001",
  documentDate: "2026-09-01",
  sellerTaxId: "29AABCU9603R1ZM",
  buyerTaxId: "27AAACI1195H1ZT",
  currency: "INR",
  totalMinor: 118000,
};

describe("the mock IRP adapter", () => {
  const adapter = new MockIrpAdapter();

  it("declares itself synthetic, in the field the product reads", () => {
    expect(adapter.isReal).toBe(false);
    expect(adapter.transport).toBe("mock_irp");
    /* The name is rendered in the UI's empty state, so it has to say it there too. */
    expect(adapter.name).toMatch(/no document is filed/i);
  });

  it("stamps an acknowledgement nobody can mistake for an IRN", async () => {
    /*
      A real IRN is 64 hex characters and never begins with letters like this.
      The prefix is the artefact that survives into a CSV export and a
      screenshot, long after any environment variable that explained it.
    */
    const result = await adapter.submit(PAYLOAD);

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.authorityId.startsWith("MOCK-")).toBe(true);
    expect(result.ackNo.startsWith("MOCK-")).toBe(true);
  });

  it("answers the same document the same way every time", async () => {
    /*
      Deterministic, not random. A mock that failed one call in ten would make
      every suite flaky and teach everyone to retry — and a retry habit is
      exactly what you do not want people to have around a filing path.
    */
    const first = await adapter.submit(PAYLOAD);
    const second = await adapter.submit(PAYLOAD);
    expect(first).toEqual(second);
  });

  it("rejects a B2B document with no buyer tax id, as the real IRP does", async () => {
    /*
      The commonest real rejection there is. Reproducing it means the rejection
      path is exercised by every test that forgets a buyer, rather than only by
      the one test written for it.
    */
    const result = await adapter.submit({ ...PAYLOAD, buyerTaxId: null });

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.errors[0]!.code).toBe("MOCK_2150");
    /* And it says what it did NOT do, in the message a user would see. */
    expect(result.errors[0]!.message).toMatch(/nothing was sent anywhere/);
  });

  it("rejects a document with no value", async () => {
    const result = await adapter.submit({ ...PAYLOAD, totalMinor: 0 });
    expect(result.outcome).toBe("rejected");
  });
});

describe("which transport a deployment runs", () => {
  /*
    The live adapter is constructed with no credentials throughout this block,
    which is every deployment that has not been given a GSP account. Its own
    selection rules — and the boot refusal when `irp` is asked for without one —
    are in `live-irp.spec.ts`, beside the adapter they are about.
  */
  const registry = (env: {
    COMPLIANCE_TRANSPORT?: "none" | "mock" | "irp";
    NODE_ENV: "development" | "production";
  }) => new ComplianceTransportRegistry(env, new MockIrpAdapter(), new LiveIrpAdapter({}));

  it("has none by default, which is the only honest default", () => {
    const r = registry({ NODE_ENV: "development" });
    expect(r.resolve()).toBeNull();
    expect(r.describe()).toEqual({
      configured: false,
      real: false,
      name: expect.stringMatching(/must be filed directly with the authority/),
    });
  });

  it("runs the mock when it is asked to, outside production", () => {
    const r = registry({ COMPLIANCE_TRANSPORT: "mock", NODE_ENV: "development" });
    expect(r.resolve()).toBeInstanceOf(MockIrpAdapter);
    expect(r.describe().real).toBe(false);
  });

  it("refuses to boot a production node configured for the mock", () => {
    /*
      A refusal rather than a warning. A warning is a log line nobody reads
      until the week somebody notices their GST returns do not match their
      invoices; a failed boot is noticed in the deploy that caused it. The
      failure mode being prevented is fabricated statutory evidence, and the
      costs of the two errors are not symmetric.
    */
    const r = registry({ COMPLIANCE_TRANSPORT: "mock", NODE_ENV: "production" });
    expect(() => r.onModuleInit()).toThrow(/production node/);
    expect(() => r.onModuleInit()).toThrow(/COMPLIANCE_TRANSPORT=none/);
  });

  it("resolves to nothing in production even if the boot check were bypassed", () => {
    /*
      Belt and braces on purpose. `onModuleInit` throwing is the loud guard;
      this is the quiet one, so a node that somehow started with the bad config
      still files nothing.
    */
    const r = registry({ COMPLIANCE_TRANSPORT: "mock", NODE_ENV: "production" });
    expect(r.resolve()).toBeNull();
  });

  it("boots quietly with no transport configured", () => {
    expect(() => registry({ NODE_ENV: "production" }).onModuleInit()).not.toThrow();
  });
});

describe("a mock filing is never reported as a filing", () => {
  it("reads as unfiled even when accepted with an acknowledgement", () => {
    /*
      The end-to-end honesty claim, at the layer a person actually sees. The
      row is `accepted`, it has an IRN-shaped identifier, and the answer is
      still "not filed" — because the transport that produced it files nothing.
    */
    const narrative = narrate({
      transport: "mock_irp",
      status: "accepted",
      authorityId: "MOCK-IRN-ABCDEF0123456789ABCDEF01",
      ackNo: "MOCK-ACK-ABCDEF0123",
    });

    expect(narrative.filed).toBe(false);
    expect(narrative.headline).toMatch(/mock e-invoice transport/);
    expect(narrative.headline).toMatch(/not filed/);
    expect(narrative.action).toMatch(/File it directly/);
  });

  it("still reports a real transport's acceptance as filed", () => {
    /* Anti-vacuity: the synthetic branch must not have swallowed everything. */
    expect(
      narrate({
        transport: "irp",
        status: "accepted",
        authorityId: "112420000000123",
        ackNo: "112420000000123",
      }).filed,
    ).toBe(true);
  });
});

describe("the submit path is reachable", () => {
  /*
    Written after shipping it unreachable. `submitToTransport` had no caller
    anywhere — the same defect this pack has now found three times in other
    people's code (`PATCH accounts/:id/system-tag`, `ComplianceService.get`,
    the certificate route), and I built a fourth.

    A mechanism nothing routes to is not half-done; it is untested in the only
    way that counts, because the parts nobody reaches are the parts that turn
    out not to fit together.
  */
  const CONTROLLER = readFileSync(join(__dirname, "../compliance.controller.ts"), "utf8");

  it("has a route that offers a document to the transport", () => {
    expect(CONTROLLER).toContain('@Post("documents/:documentType/:documentId/submit")');
    expect(CONTROLLER).toContain("this.compliance.submitToTransport(");
  });

  it("gates filing behind manage, not read", () => {
    /*
      Sending a document to a tax authority is not a read. The GET beside it
      carries `receivables:read`; this one must not.
    */
    const route = CONTROLLER.slice(CONTROLLER.indexOf("submitDocument"));
    const decorators = CONTROLLER.slice(0, CONTROLLER.indexOf("async submitDocument"));
    expect(decorators).toContain('@RequirePermission("accounting:receivables:manage")');
    expect(route.slice(0, 400)).not.toContain("receivables:read");
  });

  it("reads the figures from the posted document, never from the request", () => {
    /*
      A submit that accepted totals in its body would let a caller send a tax
      authority a figure that differs from the ledger, and the discrepancy
      would surface months later as a notice with this product's own
      submission as the evidence against the tenant.
    */
    expect(CONTROLLER).toContain("this.compliance.payloadForDocument(");
    const route = CONTROLLER.slice(CONTROLLER.indexOf("async submitDocument"));
    expect(route.slice(0, 900)).not.toContain("@Body");
  });

  it("refuses honestly when no transport is configured", () => {
    const route = CONTROLLER.slice(CONTROLLER.indexOf("async submitDocument"));
    expect(route).toContain("No e-invoice transport is configured");
    expect(route).toContain("nothing was sent");
  });

  it("is not wired into posting", () => {
    /*
      Enforcement is `off` so that a founder does not lose the ability to
      invoice when a government portal is down, and reaching an external
      authority inside the posting transaction would hold a pooled connection
      for the length of that outage. Filing is a separate act with its own
      request, and the AR posting path must not acquire a call to it.

      The posting transaction's body is `ar/lib/ar-document-posting.ts` now,
      one of the document's `ar-document-*` pieces; the service still opens
      the transaction and hands it over. So the path is the service plus every
      one of those pieces, and none of them may reach the transport.
    */
    const AR = join(__dirname, "../../ar");
    const service = readFileSync(join(AR, "ar-documents.service.ts"), "utf8");
    const posting = readFileSync(join(AR, "lib/ar-document-posting.ts"), "utf8");
    const pieces = readdirSync(join(AR, "lib")).filter(
      (f) => f.startsWith("ar-document-") && f.endsWith(".ts") && !f.endsWith(".spec.ts"),
    );

    expect(service).toContain("postDocumentInTx(");
    expect(posting).toContain("recordForDocument");
    expect(pieces).toContain("ar-document-posting.ts");
    expect(service).not.toContain("submitToTransport");
    for (const piece of pieces) {
      expect(readFileSync(join(AR, "lib", piece), "utf8")).not.toContain("submitToTransport");
    }
  });
});

describe("the rules that replace ACC-12's blanket ban", () => {
  const TRANSPORT_DIR = __dirname;
  const adapterFiles = readdirSync(TRANSPORT_DIR).filter(
    (f) => f.endsWith(".adapter.ts") && !f.endsWith(".spec.ts"),
  );

  /**
   * Every adapter in the folder, constructed as an unconfigured deployment gets
   * it — which for the live one means no credentials at all.
   *
   * Hand-written rather than reflected over, and checked against the folder
   * below, so adding an adapter is a deliberate act that comes here and answers
   * the two rules rather than slipping past a list nobody updated.
   */
  const adapters: ComplianceTransportAdapter[] = [new MockIrpAdapter(), new LiveIrpAdapter({})];

  it("constructs every adapter in the folder, so the rules below are not checking a stale list", () => {
    expect(adapterFiles.length).toBeGreaterThan(0);
    expect(adapters).toHaveLength(adapterFiles.length);
  });

  it("lets no adapter file until it has been given credentials", () => {
    /*
      ⚠ REPLACES, 2026-09-12 (ACC-14), the rule that no adapter may set
      `isReal = true`. That rule was the ratchet on a blocked ticket: nothing in
      the repository could file with a government, so a claim that it could was
      always false. ACC-14 lands the provider, and the claim is now true for a
      deployment holding GST credentials — so the ratchet moves rather than
      disappears, and what it now pins is the property that made the old rule
      worth having: an adapter that can file must be INCAPABLE of pretending to
      when it has not been given the means.

      Proven by calling every adapter with an empty configuration, which is what
      every deployment in this repository has. A synthetic adapter answers with
      its visibly synthetic acknowledgement; a real one must answer
      `unavailable`, which `ComplianceService` records as still-`pending`.
      Nothing may come back `accepted`.
    */
    const real = adapters.filter((adapter) => adapter.isReal);
    expect(real.length).toBeGreaterThan(0);

    return Promise.all(
      real.map(async (adapter) => {
        const result = await adapter.submit(PAYLOAD);
        expect(result.outcome).toBe("unavailable");
      }),
    );
  });

  it("keeps a real adapter out of the registry until it is configured", () => {
    /*
      The other half: `submit` refusing is defence in depth, and this is the
      gate that means it is never reached. An unconfigured live adapter is not
      resolvable, so the submit route answers its honest 409 and no document is
      recorded as having been offered to anybody.
    */
    const registry = new ComplianceTransportRegistry(
      { COMPLIANCE_TRANSPORT: "irp", NODE_ENV: "production" },
      new MockIrpAdapter(),
      new LiveIrpAdapter({}),
    );

    expect(registry.resolve()).toBeNull();
    expect(registry.describe().configured).toBe(false);
  });

  it("makes every synthetic adapter's acknowledgement visibly synthetic", async () => {
    /*
      Proven by CALLING the adapter, not by reading it. A grep for `MOCK-`
      would pass on an adapter that mentions the prefix in a comment and emits
      a realistic identifier — which is precisely the failure worth catching.
    */
    const synthetic = adapters.filter((a) => !a.isReal);
    expect(synthetic.length).toBeGreaterThan(0);

    for (const adapter of synthetic) {
      const result = await adapter.submit(PAYLOAD);
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") continue;
      expect(result.authorityId).toMatch(/^MOCK-/);
      expect(result.ackNo).toMatch(/^MOCK-/);
    }
  });

  it("labels a synthetic adapter's rows with a transport of their own", () => {
    /*
      The provenance that survives a database restore into another deployment.
      An adapter that wrote `irp` would leave rows indistinguishable from real
      filings the moment the environment variable that explained them is gone.
    */
    expect(new MockIrpAdapter().transport).toBe("mock_irp");
  });
});
