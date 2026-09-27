import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KB_ROOT = join(__dirname);

const TRANSACTION_OPENERS = [
  "runInTenantTransaction(",
  ".transaction(",
];

const PROVIDER_CALLS = [
  "aiGateway.invokeTextWithUsage(",
  "aiGateway.streamTextWithUsage(",
  "aiGateway.embedQueryWithCredit(",
  "aiGateway.embedBatchWithCredit(",
  "embedOrDegrade(",
  "embedBatchWithCredit(",
];

interface Offence {
  file: string;
  line: number;
  call: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

function scan(source: string): {
  transactionBlocks: number;
  providerCalls: number;
  offences: Array<{ line: number; call: string }>;
} {
  const lines = source.split(/\r?\n/);
  let depth = 0;
  let insideFrom = -1;
  let transactionBlocks = 0;
  let providerCalls = 0;
  const offences: Array<{ line: number; call: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (insideFrom === -1 && TRANSACTION_OPENERS.some((t) => line.includes(t))) {
      transactionBlocks += 1;
      insideFrom = i;
      depth = 0;
    }

    const hit = PROVIDER_CALLS.find((p) => line.includes(p));
    if (hit !== undefined) {
      providerCalls += 1;
      if (insideFrom !== -1) offences.push({ line: i + 1, call: hit });
    }

    if (insideFrom !== -1) {
      for (const ch of line) {
        if (ch === "(" || ch === "{") depth += 1;
        if (ch === ")" || ch === "}") depth -= 1;
      }
      if (depth <= 0 && i > insideFrom) insideFrom = -1;
    }
  }

  return { transactionBlocks, providerCalls, offences };
}

describe("BE-84: no KB provider or embedding call runs inside a database transaction", () => {
  const files = sourceFiles(KB_ROOT);
  const offences: Offence[] = [];
  let totalTransactionBlocks = 0;
  let totalProviderCalls = 0;

  for (const file of files) {
    const result = scan(readFileSync(file, "utf8"));
    totalTransactionBlocks += result.transactionBlocks;
    totalProviderCalls += result.providerCalls;
    for (const offence of result.offences) {
      offences.push({ file, line: offence.line, call: offence.call });
    }
  }

  it("locates transaction blocks and provider calls to scan, because a scanner that resolves nothing reports zero offences vacuously", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(totalTransactionBlocks).toBeGreaterThan(0);
    expect(totalProviderCalls).toBeGreaterThan(0);
  });

  it("finds no provider or embedding call lexically inside a transaction callback, because such a call holds a pooled connection open across someone else's outage and caps concurrency at the pool size", () => {
    const rendered = offences
      .map((o) => `${o.file.replace(KB_ROOT, "kb")}:${o.line} ${o.call}`)
      .join("\n");

    expect(rendered).toBe("");
  });

  it("CONTROL: the scanner reports an offence for a constructed transaction that wraps a provider call, proving the assertion above can fail", () => {
    const constructed = [
      "await runInTenantTransaction(this.db, async (tx) => {",
      "  const r = await this.aiGateway.invokeTextWithUsage({ feature: 'x' });",
      "  await tx.insert(table).values({ r });",
      "});",
    ].join("\n");

    const result = scan(constructed);

    expect(result.offences).toHaveLength(1);
    expect(result.offences[0]?.call).toBe("aiGateway.invokeTextWithUsage(");
  });

  it("CONTROL: the scanner does not report a provider call that follows a closed transaction block, so it is not simply flagging every file that contains both", () => {
    const constructed = [
      "await runInTenantTransaction(this.db, async (tx) => {",
      "  await tx.insert(table).values({ a: 1 });",
      "});",
      "const r = await this.aiGateway.invokeTextWithUsage({ feature: 'x' });",
    ].join("\n");

    const result = scan(constructed);

    expect(result.transactionBlocks).toBe(1);
    expect(result.providerCalls).toBe(1);
    expect(result.offences).toHaveLength(0);
  });
});
