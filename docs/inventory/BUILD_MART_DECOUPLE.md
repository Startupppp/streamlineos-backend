# Buildmart coupling removed from StreamlineOS inventory

**Date:** 2026-09-10
**Branch:** `feat/inventory-world-class-implementation`
**Status:** done, and gated

## Decision

StreamlineOS inventory is a generic multi-tenant WMS. Every organisation that
holds stock is a tenant of it on the same terms — a kirana, a pharmacy, a
distributor, a manufacturer, a warehouse operator, a construction-materials
supplier. No customer is named in it.

Buildmart is a different product. If Buildmart ever runs on StreamlineOS
inventory it does so as an ordinary organisation, with its own rows, in the same
schema as everybody else: it turns on the packs it wants, names its own
warehouses and zones, and loads its own catalogue. It does not get a pack, a
route prefix, a seed, a migration, a settings key or a component folder of its
own. A fork for one customer is the thing this removal exists to prevent.

## What was actually coupled

Very little of the capability, and all of the packaging. The `materials` pack
itself was already generic when this started — the settings flag is
`pack_materials`, the enums are `inv_facility_type` and `inv_material_family`,
and the DDL names no company, city or brand. It is kept, unchanged, off by
default.

What carried the customer's name:

| Removed | Was | Now |
| --- | --- | --- |
| `src/scripts/seed-buildmart.ts` (1,150 lines) | one org, four named Hyderabad dark stores with 60–120 minute promises, 20 products / 23 variants under two house brands, five staff on `@buildmart.local` | deleted; no branded seed ships |
| `package.json` `seed:buildmart` | ran the above | deleted |
| `migrations/0820_buildmart_materials_pack.sql` | the materials-pack DDL under a customer's name | renamed `0820_materials_pack.sql`, journal tag with it, **content byte-identical**; since 2026-09-11 `0820a_materials_pack.sql`, suffixed off origin/main's 0820 |
| `docs/buildmart-inventory.md` | the pack documented as one company's system | rewritten as `docs/inventory-materials-pack.md`, tenant-neutral |
| `.env.example` materials block | `buildmart_dev` database, `buildmart_app` role | `streamline_dev`, `streamline_app` |
| `frontend/features/inventory/components/buildmart/` (17 files) | generic projects / requirements / facility screens in a customer-named folder | `components/materials/` |
| `frontend/lib/query-keys/inventory-buildmart.ts` | `inventoryBuildmartQueryKeys` | `inventory-materials.ts`, `inventoryMaterialsQueryKeys`; **key values unchanged** |
| `.next-buildmart` | a local Next `distDir` example in a .gitignore comment, a tsconfig exclude and seven gate-script headers | `.next-local` |
| `cornerstone_cold`, `cornerstone_neo16` | local database names in two spec headers and a handoff doc | `streamline_cold`, `streamline_neo16` |
| `"Gachibowli DC"`, zone `"Gachibowli"` | warehouse names in four frontend test fixtures | `"North DC"`, `"NORTH"` |
| a Kompally/Uppal example in `inv-reports-extended.service.ts` | one city's localities explaining PO scoping | the rule stated without an example |

## Two things that were deliberately *not* changed

**The migration's contents.** `db-bootstrap` keys
`drizzle.__drizzle_migrations` on the SHA-256 of the file, not on the tag. The
rename is therefore free: every database that has already applied this migration
still resolves it to the same hash and SKIPs it. Editing so much as a comment
inside the file would change that hash and make an applied database re-run a
script whose `ADD CONSTRAINT` statements are not idempotent. The stale comment
about seeded zones was left alone for exactly this reason; the rewritten doc
carries the correct statement instead.

**The query-key values.** Renaming the exported object is a compile-time change.
Renaming the strings inside it is not: they are what a running client's cache is
keyed on, and changing one silently orphans every entry under it.

## What is generic and stays

Industry vocabulary is not branding. `DARK_STORE` is a facility type Blinkit,
Instamart and Zepto all operate and any q-commerce or last-mile tenant needs.
A `zone` is any business's own carve-up of a city, which is why it is free text
and not an enum. `delivery_promise_minutes` is optional per-warehouse metadata;
where a tenant sets one it ranks urgency, and where none is set nothing reads it.
None of these hardcode a city, a pin or a promise.

The `materials` pack stays, off by default, for any tenant with a construction
or interiors catalogue: grade, finish, colour, dimension label, material family,
pack size, supplier code, lead time and reorder quantity on the product; facility
type and zone on the warehouse; `inv_projects` / `inv_project_requirements` as a
demand source. See [docs/inventory-materials-pack.md](../inventory-materials-pack.md).

Untouched, because they were never coupled: the stock engine and
`MovementApplyService`, reservations, receiving, picking, dispatch, transfers,
adjustments, cycle counts, purchase orders, the webhook outbox, audit, and RLS /
tenant isolation.

## The ratchet

`pnpm check:tenant-neutral` fails the build on a customer proper noun —
`buildmart`, `cornerstone`, and the localities that came with them — anywhere in
`src`, `migrations`, `docs`, `scripts`, `test`, `.env.example` or `package.json`,
in a file's **path** as well as its contents. `seed-buildmart.ts` would have been
caught by its name alone.

It is a ratchet rather than a review item because this coupling never arrives as
an obvious mistake. It arrives as a seed script that is genuinely useful on the
day it is written, a migration filename that matches the ticket, a fixture named
after a warehouse somebody had open in another tab. Each is a small convenience.

The gate carries a vacuity floor (it exits 2 rather than 0 if it reaches fewer
than 500 files or fewer than 100 migrations) and a `--self-test` that asserts
both halves: that the matcher fires on the shapes that really occurred
(`seed-buildmart`, `packBuildmart`, `buildmart_dev`, `.next-buildmart`) and
stays silent on the vocabulary the packs are built out of (`DARK_STORE`,
`pack_materials`, `zone`, `HYD_NORTH` as tenant data). A correct matcher over a
walker that visits nothing is the failure these scripts have had before.

The frontend repository carries the same gate, `pnpm check:tenant-neutral`
in `frontend/scripts/check-tenant-neutral.mjs`, with its own allowlist and its
own vacuity floor. It checks paths as well as contents for the same reason:
`components/buildmart/` contained no banned word in any of its seventeen files.
The folder name was the whole coupling.

This document is the one acknowledged exception in the allowlist: a decision
record has to be able to name what it removed, or the next person re-adds it
not knowing it was ever a decision.
