/**
 * A5 — every inventory domain event has somewhere to go.
 *
 * `OutboxPublisher` dispatches through `OutboxConsumerRegistry`, and an event
 * type with no registered consumer is not ignored: `deliver()` throws "no
 * dispatch handler", the event is retried, and it dead-letters. So adding an
 * `OutboxWriter.emit` with a new `eventType` and forgetting to route it does not
 * fail loudly at the call site — it fails later, in a background publisher, on
 * somebody else's shift.
 *
 * Inventory had no consumer registered at all, which is how it came to emit
 * seven event types that reached nobody while customers held webhook
 * subscriptions for nine names the system never produced.
 *
 * This scans the real sources rather than a maintained list, so a new event has
 * to be routed — or explicitly routed to `null`, which is a decision — before it
 * can be merged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INVENTORY_WEBHOOK_ROUTES } from "../webhooks/inventory-outbox-consumer";

const INVENTORY_ROOT = join(__dirname, "..");

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".spec.ts")) found.push(path);
    }
  };
  walk(INVENTORY_ROOT);
  return found.sort();
}

/** Every `inventory.*` string this module uses as an outbox `eventType`. */
function emittedEventTypes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    const file = path.slice(path.indexOf("modules/inventory/"));
    for (const m of source.matchAll(/eventType:\s*["'`](inventory\.[a-z0-9._]+)["'`]/g)) {
      found.set(m[1]!, file);
    }
    // The engine names its event through a constant rather than a literal.
    for (const m of source.matchAll(/export const [A-Z_]+ = ["'`](inventory\.[a-z0-9._]+)["'`]/g)) {
      found.set(m[1]!, file);
    }
    // A5, item 3. The command events are declared as one frozen map rather than
    // a constant apiece, so their call sites read `eventType: EVENTS.X` and the
    // literal never appears beside an `eventType:` key. Without this the scan
    // sees none of them and the guard silently stops guarding — which is the
    // same class of failure it exists to catch. `[A-Z_]+` cannot match the
    // lowercase `eventType:` key, so this does not re-find the literals above.
    for (const m of source.matchAll(/^\s*[A-Z_]+:\s*["'`](inventory\.[a-z0-9._]+)["'`]/gm)) {
      found.set(m[1]!, file);
    }
  }
  return found;
}

describe("A5 — outbox routing covers every inventory event", () => {
  it("routes every event type inventory emits", () => {
    const unrouted = [...emittedEventTypes().entries()]
      .filter(([type]) => !(type in INVENTORY_WEBHOOK_ROUTES))
      .map(([type, file]) => `${type} (emitted by ${file})`);

    expect(unrouted).toEqual([]);
  });

  it("routes nothing that is never emitted", () => {
    // The inverse drift: a route for a type no command produces is a subscriber
    // waiting for a message that will never arrive.
    const emitted = new Set(emittedEventTypes().keys());
    const orphans = Object.keys(INVENTORY_WEBHOOK_ROUTES).filter((type) => !emitted.has(type));

    expect(orphans).toEqual([]);
  });
});
