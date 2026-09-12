# Materials pack — construction & interior materials inventory

> The `materials` pack: what it adds to StreamlineOS inventory, how to run it,
> and which of its claims are proven by a test rather than by a screenshot.

StreamlineOS inventory is a generic multi-tenant WMS. Any organisation that
holds stock runs it — a kirana, a pharmacy, a distributor, a manufacturer, a
warehouse operator. The `materials` pack is one optional, off-by-default layer
on top of it, for tenants whose catalogue is construction and interior goods:
grades, finishes and pack sizes on the product, a facility type and delivery
zone on the warehouse, and construction projects as a demand source.

No tenant, brand or city is special-cased anywhere in this module. Zones,
facility types and delivery promises are per-tenant data, entered by the
organisation that uses them.

## What this is not

It is **not** a second inventory system. The stock ledger, reservations,
receiving, picking, packing, dispatch, transfers, adjustments, cycle counts,
purchase orders, the webhook outbox and the audit trail were already here and are
reused unchanged. A second reservation table or a second availability formula
would be a second answer to *how much can we promise*, which is the one question
this system exists to answer once.

## What the pack adds

| Area | Added |
| --- | --- |
| Catalogue | `brand`, `material_grade`, `finish`, `colour`, `dimension_label`, `material_family`, `pack_size`, `supplier_code`, `lead_time_days`, `reorder_quantity` on `inv_products` |
| Facilities | `facility_type`, `zone`, `zone_label`, `delivery_promise_minutes`, `service_radius_km`, `latitude`, `longitude` on `inv_warehouses` |
| Demand | `inv_projects` and `inv_project_requirements` — construction sites and the material each still needs |
| Screens | `/inventory/dark-stores`, `/inventory/projects`, `/inventory/projects/[id]`, plus the Position and Needs Attention sections on `/inventory` |
| API | `/inventory/ops/summary`, `/inventory/ops/attention`, `/inventory/ops/zones`, `/inventory/projects/*` |
| Events | eleven producer events that had no subscriber-facing name now have one |

## The pack flag

`materials` is one of the `inv_settings` packs, beside `warehouse`, `kirana`,
`pharmacy`, `gst` and `quickCommerce`. It is **off by default**.

```bash
curl -X PATCH "$API/inventory/settings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"packMaterials": true}'
```

With the pack off:

- the catalogue attributes are **stripped from every response** (absent, not
  null — a client cannot start depending on them),
- writing any of them returns `400 MATERIALS_PACK_DISABLED` naming the fields,
- the dark-store fields on a warehouse are refused the same way,
- every `/inventory/projects` route returns `404 MATERIALS_PACK_DISABLED`.

Hiding a field in the UI is not a gate. An organisation that cannot see a column
must not end up holding data in it.

## Running it locally

### 1. Database

`db:migrate` is unusable here; `db:bootstrap` applies the journal and fails
loudly with the statement that broke.

```bash
createdb streamline_dev
psql -d streamline_dev -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION "uuid-ossp"; CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gin;'
psql -d streamline_dev -c 'CREATE SCHEMA build; CREATE SCHEMA build_events;'
psql -d postgres -c 'CREATE ROLE neondb_owner;'   # a migration GRANTs to it

DATABASE_URL=postgresql://$USER@127.0.0.1:5432/streamline_dev \
DIRECT_DATABASE_URL=postgresql://$USER@127.0.0.1:5432/streamline_dev \
  node src/scripts/db-bootstrap.mjs           # RESULT: REACHED_HEAD 528/528

APP_DB_ROLE=streamline_app APP_DB_PASSWORD=<pw> APP_DB_SCHEMA=public,build,build_events \
DATABASE_URL=postgresql://$USER@127.0.0.1:5432/streamline_dev \
  node src/scripts/db-bootstrap-app-role.mjs
```

`APP_DATABASE_URL` must point at the **non-owner** role. Running the app as the
owner has `BYPASSRLS` and hides every tenant-isolation bug.

### 2. Seed

No branded or tenant-specific seed ships with this module, by design: a seed
that creates one named company's warehouses and catalogue is that company's
data, not a fixture every other tenant has to step around. Create an
organisation through the normal onboarding path and turn the pack on.

If you write a local development seed, write the **ledger** rather than only the
balances: `inv_stock_levels` is a cache of `inv_stock_transactions`, and a seed
that wrote only balances produces a system whose movement history is empty and
whose reconciliation report says everything is wrong.
`chk_inv_stock_transactions_arithmetic` enforces `after = before + change`, so
no seed can write a balance the history cannot explain.

### 3. Servers

```bash
# backend — nest start alone fails env validation; pass the env file explicitly
node --max-old-space-size=8192 --env-file=.env ./node_modules/@nestjs/cli/bin/nest.js start --builder swc --watch

# frontend
npx next dev -p 1000
```

Add the frontend's origin to `CORS_ORIGINS`, or every request preflights to 404.
A second dev server on one checkout needs `NEXT_DIST_DIR=.next-local`.

## Inventory calculation rules

Availability is computed in exactly one place — `availableQtySql` in
`stock-engine/available-sql.ts`, and its arithmetic twin `availableQty` in
`decimal.ts`. Nothing else subtracts one bucket from another, and a frontend test
(`hooks/api/inventory/available-formula.test.ts`) fails the build if anything
starts to.

```
available =
    0                                        -- if the location is not sellable
    0                                        -- if the stock is not OWNED
    on_hand
  − committed        (reserved for an order, a project or an allocation)
  − blocked_qty      (damaged, awaiting write-off or return)
  − quality_hold_qty (quarantined, awaiting a quality decision)
  − outgoing_qty     (picked, on the packing bench, not yet dispatched)
```

Two gates matter and are easy to forget, which is why they live in the canonical
expression rather than in the five callers:

- **In transit.** A dispatched transfer parks its goods at the source
  warehouse's `TRANSIT` location, which is `is_sellable = false`. The stock is on
  hand — org-wide on-hand and valuation are conserved for the whole journey, which
  is the point — but it is in a van, and a van cannot be picked from.
- **Ownership.** Consigned goods stand in the building and belong to somebody
  else until sold. Only `OWNED` is available and only `OWNED` is valued.

The seven buckets are reported separately everywhere, never summed for the
reader. The failure this prevents is somebody reading on-hand as available and
selling material that is already held for a site.

## Status transitions

**Project** — `PLANNING → ACTIVE → COMPLETED`, with `ON_HOLD` and `CANCELLED`
reachable from any open state. `ON_HOLD` is deliberately not `CANCELLED`: held
material stays reserved and cancelled material must be released.

**Requirement** — `DRAFT`/`REQUESTED` → `PARTIALLY_FULFILLED` → `RESERVED` →
`FULFILLED`, or `CANCELLED`. Only `DRAFT`, `REQUESTED` and `CANCELLED` are
settable by hand: the rest are what reserving and dispatching make true, and a
hand-set one would claim stock is held that nothing is holding.

**At risk** is *derived on every read*, never stored. A line is at risk when it
is short and either (a) there is not enough available to close the gap, or
(b) the required-by date is inside the supplier lead time. A stored flag would be
wrong the morning after it was written and nothing would say which morning. The
rule is pure and clock-injected in `projects/lib/coverage.ts`, with twelve cases
in `__tests__/coverage.spec.ts`.

**Transfer** — `PENDING → RESERVED → IN_TRANSIT → COMPLETED`, or `CANCELLED`. A
partial receipt leaves the transfer `IN_TRANSIT`: the remainder is still in the
van.

## API

Every route is `@RequireModule("inventory")` behind `JwtAuthGuard` + `ModuleGuard`
+ `PermissionGuard`. Mutations marked *idempotent* accept an `Idempotency-Key`
header; a completed retry replays the stored response, a same-key different-body
request is `422`, and a concurrent duplicate is `409`.

### Operations board

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/inventory/ops/summary` | `inventory:stock:read` | Seven buckets, SKU count, stock value, facility counts |
| GET | `/inventory/ops/attention` | `inventory:stock:read` | The exceptions board — count, severity, deep link, next verb |
| GET | `/inventory/ops/zones` | `inventory:stock:read` | Per facility: buckets, value, stockouts, promise |

All three are `inventory:stock:read`, not `inventory:reports:read`. Reports carry
cost and margin and are a finance surface; this is what is on the shelf and what
is wrong with it — exactly what a floor operator holds stock-read for.

### Projects

| Method | Path | Permission | Idempotent |
| --- | --- | --- | --- |
| GET | `/inventory/projects` | `inventory:projects:read` | — |
| GET | `/inventory/projects/at-risk` | `inventory:projects:read` | — |
| GET | `/inventory/projects/:id` | `inventory:projects:read` | — |
| POST | `/inventory/projects` | `inventory:projects:manage` | yes |
| PATCH | `/inventory/projects/:id` | `inventory:projects:manage` | — |
| DELETE | `/inventory/projects/:id` | `inventory:projects:manage` | — (soft delete) |
| POST | `/inventory/projects/:id/requirements` | `inventory:projects:manage` | yes |
| PATCH | `/inventory/projects/:id/requirements/:rid` | `inventory:projects:manage` | — |
| POST | `/inventory/projects/:id/requirements/:rid/reserve` | `inventory:stock:reserve` | yes |
| POST | `/inventory/projects/:id/requirements/:rid/release` | `inventory:stock:reserve` | yes |

Reserving is `inventory:stock:reserve` and not the project key on purpose:
holding stock is a claim on the warehouse, and who may make that claim is a
warehouse decision.

### Reserving against a project

A project reservation is an ordinary `inv_stock_reservations` row with
`source_type = 'PROJECT_REQUIREMENT'`, `source_id` = the project and
`source_line_id` = the requirement. The engine is the only writer of `committed`.

Two rules that are not obvious:

- **One active hold per line**, enforced by
  `uniq_inv_reservations_org_source_active`. Reserving again on a line that
  already holds stock *replaces* the hold with a larger one, inside one
  transaction, rather than failing with a uniqueness error nobody can act on.
- **A hold names a bin, not a store.** A site engineer names a facility; the
  service resolves the single pickable bin with the most available that can cover
  the whole quantity — crediting back what this same line is already sitting on,
  since the top-up releases it in the same transaction. When no single bin covers
  it, the call is refused *naming the largest single-bin figure*, so the operator
  can transfer, split, or name a bin rather than guess.

Refusals are named, not generic: `REQUIREMENT_FULLY_COVERED`,
`RESERVATION_EXCEEDS_REQUIREMENT`, `NO_SINGLE_LOCATION_COVERS_QTY`,
`REQUIREMENT_BELOW_COMMITTED`, `PROJECT_HAS_ACTIVE_RESERVATIONS`,
`NO_ACTIVE_RESERVATION`.

## Reorder suggestions

`GET /inventory/reports/reorder` is one row **per stock level** — a SKU low at
two facilities is two rows, and low in two bins of one store is two rows. Each
carries `locationId`/`warehouseId`, which is also its identity.

The suggested quantity is the order policy, most specific first:

1. a per-warehouse `inv_reorder_rules.max_qty` → top up to it,
2. that rule's `reorder_qty`,
3. the SKU's own `reorder_quantity`,
4. otherwise the bare deficit to the reorder point.

Then **what is already coming is subtracted**: outstanding quantity on
`SENT`/`PARTIAL` purchase orders bound for this warehouse, plus quantity on
transfers already dispatched to it. A suggestion that ignores those is how a
business ends up with three months of cement. The raw figure is returned beside
the net one (`rawSuggestedQty`, `onPurchaseOrderQty`, `inTransitQty`) so a buyer
can see why.

Lead time resolves rule → the SKU's catalogue `lead_time_days` → the default
vendor's. Nothing purchases automatically; a suggestion is reviewed and a
purchase order is raised by a person.

## Permissions

| Key | Grants |
| --- | --- |
| `inventory:stock:read` | The operations board, facilities, stock levels, movements |
| `inventory:stock:reserve` | Hold and release stock, including against a project |
| `inventory:stock:adjust` | Adjustments and cycle-count postings |
| `inventory:stock:transfer` | Transfers between facilities |
| `inventory:projects:read` | Projects, requirements, the at-risk feed |
| `inventory:projects:manage` | Create and edit projects and requirements |
| `inventory:products:create` / `:update` | The catalogue, including material attributes |
| `inventory:purchase-orders:receive` | Receiving against a purchase order |
| `inventory:reports:read` | Reporting, including cost and valuation |
| `inventory:webhooks:manage` | Endpoints, deliveries, replays |

Enforcement is on the **server**, by `PermissionGuard`, on every route. The
client gates are a courtesy: `useCan` hides what a person cannot do, and
`useAuthorizedMutation` refuses to fire, but neither is the boundary. Cross-tenant
misses return `404`, never `403` — a 403 on another organisation's id confirms
the record exists and turns a probe into an existence oracle.

The `INVENTORY_MANAGER` role template carries both project keys.

## Webhooks

Endpoints are registered at `POST /inventory/webhooks` with a URL and a list of
event types. The secret is generated on creation, returned **once**, and never
shown again.

Delivery is enqueue-then-deliver: `InventoryWebhookEmitter.emit` durably records
what is owed to whom inside the producing transaction, and
`InventoryWebhookDeliveryWorker` delivers it outside any transaction on an
exponential-backoff ladder. Each delivery carries an HMAC signature, a timestamp
header and a unique event id; a `dedupe_key` unique per `(org, webhook)` turns an
at-least-once replay into a no-op. Failures retry, then dead-letter
(`dead_lettered_at`), and an endpoint that dead-letters repeatedly is alerted on
and then disabled — alert strictly before disable, as a property of the data.

### Subscribable events

The original nine are a published contract and are spelled exactly as they always
were. Removing one would silently kill a live subscription.

```
inventory.product.created      inventory.stock.changed        inventory.stock.low
inventory.po.created           inventory.po.received          inventory.so.reserved
inventory.so.shipped           inventory.transfer.completed   inventory.adjustment.posted
```

Added by this work — each already had a producer that was routed to "delivered
nowhere, deliberately", because naming an event is a contract decision:

```
inventory.stock.out            inventory.stock.received       inventory.stock.reserved
inventory.stock.released       inventory.reservation.fulfilled
inventory.transfer.dispatched  inventory.picklist.completed   inventory.return.received
inventory.quality.hold.created inventory.quality.hold.released
inventory.count.posted
```

`inventory.stock.out` is a genuinely new producer. On-hand reaching zero used to
be announced as `inventory.stock.low`, which is true and useless: the buyer and
the person telling a customer no need different signals. Exactly one of the two
is emitted per variant per movement, because the outbox is unique on
`(org, aggregate_type, aggregate_id, aggregate_version)` and that version is a
millisecond clock — two emits for one variant in one transaction would collide on
that index and roll the stock movement back. The low-stock notifier is registered
for both names, so the buyer hears about an outage as before.

`inventory.stock.transfer.reserved` stays unrouted on purpose: a transfer holding
its own source stock is an internal step of a transfer a subscriber already hears
about at creation and dispatch, and announcing it separately delivers three
webhooks for one movement of goods.

### Example payload

```json
{
  "id": "0f1c2a7e-6d1b-4f0a-9d0e-9a2f5b7c1e33",
  "type": "inventory.stock.reserved",
  "createdAt": "2026-09-01T06:41:12.004Z",
  "data": {
    "reservationId": 12,
    "sourceType": "PROJECT_REQUIREMENT",
    "sourceId": "1",
    "sourceLineId": "2",
    "productVariantId": 4,
    "sku": "STL-TATA-FE500D-12-B5",
    "warehouseId": 4,
    "locationId": 55,
    "qty": "40.0000",
    "actorUserId": "b0000001-0000-4000-8000-000000000002"
  }
}
```

Headers: `X-Inventory-Signature` (HMAC-SHA256 of `timestamp.body` with the
endpoint secret), `X-Inventory-Timestamp`, `X-Inventory-Event-Id`,
`X-Inventory-Event-Type`.

Verify by recomputing the HMAC and comparing in constant time; reject a timestamp
outside your tolerance window; treat the event id as the idempotency key.

### Local development

Point an endpoint at any local receiver (`npx http-echo-server 4000`, an ngrok
tunnel, a `webhook.site` URL). `GET /inventory/webhooks/:id/deliveries` lists
attempts with status, response code, error and next retry; a delivery can be
retried by hand and a dead letter replayed.

## Images

Product images use the existing storage module and its provider configuration —
nothing new was added, and no third-party image URLs are used. `imageUrl` is
nullable throughout; every surface that shows an image renders a package glyph
when there is none, and images are lazily loaded and constrained by their
container. Ship **no** image URLs in any fixture: bundling copyrighted product
photography would be worse than a placeholder.

## Tests

```bash
# backend
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
pnpm jest src/modules/inventory src/common/outbox src/modules/rbac
node .scratch/inventory/e2e-api.mjs       # against a running API; see below

# frontend
pnpm type-check
pnpm test
pnpm lint
```

The API walk needs a token and a running server:

```bash
API_BASE=http://localhost:1500 API_TOKEN=<jwt> node .scratch/inventory/e2e-api.mjs
```

It creates a product with material attributes, opens stock, searches for it,
raises a project requirement, reserves and tops up a hold, proves availability
moves by exactly the reserved amount, releases it, adjusts stock, reads the
movement history and audit trail, creates/dispatches/receives a
transfer, proves org-wide on-hand is conserved across it, drives the SKU below
its reorder point and reads the suggestion back — and checks that an
unauthenticated read is 401 and an unknown id is 404 rather than 403.

## Deployment

Nothing new is required. The migration (`0820a_materials_pack`) is
additive: every column is nullable or defaulted, both new tables are new, every
foreign key is added `NOT VALID` then validated separately, and `lock_timeout` is
set so a contended statement fails fast rather than queueing behind a table.

**Rollback.** The pack flag is the rollback: setting `packMaterials` back to
`false` hides every field, refuses every write and 404s the project routes,
without deleting anything. Reverting the migration itself is only necessary if
the columns must physically go — and dropping `inv_projects` destroys the
material history of every site, so prefer the flag.

## Assumptions

1. **Zones are the tenant's own carve-up of a city**, so `zone` is free text with
   an uppercase-token format, not an enum. A tenant names its own zones; a
   second city, or a country with different ones, needs no migration.
2. **A grade is not a variant axis.** Two grades of cement are two products with
   two reorder points; two finishes of one tile are two SKUs a picker must not
   confuse. Variants stay for genuine size/colour splits of one item.
3. **`dimension_label` is a label, not three numbers.** `inv_product_variants`
   already holds real millimetres for the packer; a picker matching a printed
   carton needs the trade's own string ("600x600 mm", "8 ft x 4 ft").
4. **A project is a demand source, not a stock location.** Material for a site is
   reserved out of the facility that will serve it and leaves the ledger only
   when dispatched, so there is no site-level balance to reconcile.
5. **Costs are `numeric`** throughout and are carried over the wire as text;
   the UI formats to the tenant's locale. There are no minor units in this path.
6. **The delivery promise is a property of the facility**, not of an order, and
   it is optional. Where a tenant sets one, it is what makes a stockout at that
   facility urgent rather than merely noteworthy; where none is set nothing is
   ranked by it.

## Known limitations

- **The promise is descriptive, not enforced.** `delivery_promise_minutes` is
  tenant-entered and optional; it ranks and labels, and nothing routes an order
  to the nearest store or measures whether the promise was kept. There is no
  courier integration.
- **No geospatial matching.** A site and the stores that can serve it are matched
  on the `zone` string. Latitude and longitude are stored and displayed but no
  distance query uses them.
- **One hold per requirement line.** Covering a line from two bins needs two
  requirement lines. This is the database constraint made honest rather than
  worked around; splitting a hold would fork availability.
- **`fulfilled_qty` has no dispatch writer yet.** The column, its constraint and
  the coverage arithmetic are in place and are read everywhere, but nothing
  currently increments it: dispatching against a project requirement (as opposed
  to a sales order) is the next unit of work. Until then a delivered line is
  closed by editing the requirement.
- **Barcode scanning on mobile** uses the existing RF surfaces
  (`/inventory/rf`, `/inventory/barcode`); the project screens do not scan.
- **The reorder trigger is on-hand, not available.** The `WHERE` clause is
  unchanged from before this work so existing behaviour is preserved; the
  *suggested quantity* accounts for availability, open orders and stock in transit.
