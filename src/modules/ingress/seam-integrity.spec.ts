import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INBOUND_CHANNELS, PARTICIPANT_ROLES } from "./inbound-event";

/**
 * The claim this file exists to falsify.
 *
 * Phase 1 put the ingress seam at the highest point it could defend, on the
 * argument that adding a channel would then cost an adapter and nothing else.
 * Phase 2 adds telephony, WhatsApp and web forms — three chances for that to be
 * wrong.
 *
 * An argument nobody checks becomes a thing that was true once. Each assertion
 * below is a way the seam could quietly move: a new field appended to the event
 * because one channel needed it, a `provider ===` branch below the seam, an
 * adapter reaching down into the workflow instead of handing off. None of those
 * announces itself in review — they look like small, reasonable edits.
 *
 * **A failure here is not necessarily a bug.** It means the seam moved, and the
 * PRD is explicit that discovering that is the most valuable finding in the
 * phase. The right response is to update the pin deliberately and say so, never
 * to widen it quietly to get green.
 */
describe("the ingress seam still holds", () => {
  const ingressDir = __dirname;
  const read = (relative: string): string => readFileSync(join(ingressDir, relative), "utf8");

  /**
   * Everything downstream of the seam, which no channel may require a change to.
   *
   * The two `lib/` files are the workflow's step bodies, moved out of
   * `inbound-ingress.workflow.ts` by the file-size split. They are below the seam
   * for exactly the reasons the workflow is, so they are read by every rule here
   * that reads it.
   */
  const BELOW_THE_SEAM = [
    "inbound-ingress.workflow.ts",
    "inbound-ingress.service.ts",
    "lib/ingress-resolve-party.ts",
    "lib/ingress-filing.ts",
  ];
  /** The workflow and its step bodies: what no adapter may import. */
  const WORKFLOW_PARTS = ["inbound-ingress.workflow", "lib/ingress-resolve-party", "lib/ingress-filing"];

  it("keeps the seam itself pure", () => {
    // `inbound-event.ts` is imported by every adapter. The moment it imports a
    // service, a schema or a database handle, every adapter drags that with it
    // and the rules here stop being provable without a tenant and a network.
    const imports = [...read("inbound-event.ts").matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map(
      (m) => m[1]!,
    );
    expect(imports).toEqual([]);
  });

  /**
   * The event's fields, pinned.
   *
   * A channel that needs a field the event does not carry is the single most
   * likely way this seam moves, because appending one is a two-line diff that
   * reads as obviously fine. Adding a field here is allowed — it just has to be
   * a decision somebody made on purpose, which is what updating this list is.
   */
  it("carries exactly the fields the seam was designed with", () => {
    const fieldsOf = (name: string): string[] => {
      const body = read("inbound-event.ts").match(
        new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`),
      )?.[1];
      if (!body) throw new Error(`${name} is no longer declared in inbound-event.ts`);
      return [...body.matchAll(/^\s*readonly\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1]!).sort();
    };

    expect(fieldsOf("InboundCommunicationEvent")).toEqual([
      "body",
      "channel",
      "occurredAt",
      "organizationId",
      "participants",
      "provider",
      "providerMessageId",
      "providerThreadId",
      "subject",
    ]);
    /**
     * `identifierKind` was added by ticket 22, deliberately, and this line is
     * where that decision is recorded.
     *
     * It is the one field Phase 2 could not do without, and the reason is
     * specific rather than general. Below the seam a sender is matched against
     * `party_identifiers`, which is keyed on `(kind, value)` — so something has
     * to say what kind of address arrived. The channel cannot: WhatsApp and web
     * forms both arrive as `message`, one carrying a telephone number and one an
     * email address. Inferring it from the string is worse still, and is exactly
     * how a telephone number came to be written into `business_parties.email`.
     *
     * The field is optional, so events already stored in
     * `inbound_events.payload` still parse and fall back to the channel.
     */
    expect(fieldsOf("InboundParticipant")).toEqual([
      "address",
      "displayName",
      "identifierKind",
      "role",
    ]);
  });

  /**
   * `provider` is an opaque label for deduplication, and `inbound-event.ts` says
   * so in as many words: "Nothing branches on it — the moment something does,
   * the seam has leaked."
   *
   * That is the leak worth catching, because it is how "adding a channel is
   * free" stops being true without anyone noticing. The first
   * `if (provider === "gmail")` below the seam is the moment every future
   * channel inherits a special case.
   */
  it("never branches on which provider produced an event", () => {
    const offenders: string[] = [];
    for (const file of BELOW_THE_SEAM) {
      const source = read(file);
      const branches = [
        /\bprovider\s*===/g,
        /\bswitch\s*\(\s*[a-zA-Z.]*\bprovider\b/g,
        /\bprovider\s*==\s*["']/g,
      ];
      for (const pattern of branches)
        for (const hit of source.matchAll(pattern)) offenders.push(`${file}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Two different jobs live in `adapters/`, and only one of them is the seam.
   *
   * A **normaliser** turns a provider's payload into an `InboundCommunicationEvent`
   * and returns it. It is pure, which is what lets every rule about it be proved
   * from a fixture with no tenant and no network. It must reach nothing below.
   *
   * A **transport** — a sweep, a webhook receiver, a controller — drives the
   * channel and then hands the event over. Calling `InboundIngressService` *is*
   * the handing over, so that import is the seam working, not leaking.
   *
   * What neither may do is import the workflow. The service is the entry point;
   * a transport that starts a workflow run itself has built a second way in, and
   * the next channel then has two places it might need to touch.
   */
  it("keeps normalisers pure and transports above the workflow", () => {
    const adaptersDir = join(ingressDir, "adapters");
    const pureOffenders: string[] = [];
    const workflowOffenders: string[] = [];

    for (const file of readdirSync(adaptersDir).filter((f) => f.endsWith(".ts"))) {
      if (file.endsWith(".spec.ts")) continue;
      const source = readFileSync(join(adaptersDir, file), "utf8");
      const isNormaliser = file.endsWith("-to-inbound-event.ts");

      for (const match of source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)"/gm)) {
        const target = match[1]!;
        if (WORKFLOW_PARTS.some((part) => target.includes(part)))
          workflowOffenders.push(`${file} -> ${target}`);
        if (isNormaliser && BELOW_THE_SEAM.some((b) => target.includes(b.replace(/\.ts$/, ""))))
          pureOffenders.push(`${file} -> ${target}`);
      }
    }

    expect(pureOffenders).toEqual([]);
    expect(workflowOffenders).toEqual([]);
  });

  /**
   * Every channel has a normaliser, and it is the only place its payload shape is
   * known. A channel whose provider-specific parsing has spread into its
   * transport has no single place left to test from a fixture.
   */
  it("gives every channel exactly one normaliser", () => {
    const normalisers = readdirSync(join(ingressDir, "adapters"))
      .filter((f) => f.endsWith("-to-inbound-event.ts"))
      .sort();
    /**
     * Pinned, not counted. A channel arriving without a normaliser means its
     * provider-specific parsing went somewhere else — into a transport, or into
     * the workflow — and there is then no single place to test it from a fixture.
     *
     * Each entry was a deliberate edit when that channel landed. Three of them
     * arrived together in Phase 2, and all three adapters left this line alone
     * and said so, which is the behaviour this file is trying to encourage:
     * widening the pin is a decision, never a step in getting green.
     */
    expect(normalisers).toEqual([
      "mail-to-inbound-event.ts",
      "telephony-to-inbound-event.ts",
      "web-form-to-inbound-event.ts",
      "whatsapp-to-inbound-event.ts",
    ]);
  });

  /**
   * The channel vocabulary is a fixed list, so a new channel takes an existing
   * slot rather than inventing a free-text label nothing downstream understands.
   * `call` and `message` were reserved in Phase 1 for exactly the adapters
   * Phase 2 is adding.
   */
  it("reserves a slot for every channel this phase adds", () => {
    expect(INBOUND_CHANNELS).toContain("call");
    expect(INBOUND_CHANNELS).toContain("message");
    // Web forms arrive as a message from the form's own identity rather than as
    // a fifth channel; if that changes, it is a seam decision, not an adapter one.
    expect([...INBOUND_CHANNELS].sort()).toEqual(["calendar", "call", "email", "message"]);
    expect([...PARTICIPANT_ROLES].sort()).toEqual([
      "attendee",
      "cc",
      "from",
      "organiser",
      "to",
    ]);
  });
});
