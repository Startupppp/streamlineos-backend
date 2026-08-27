# Inventory research review — backend implications

**Input:** `/Users/tarunchintakunta/Downloads/inventory-research.tar.gz`

The five archive files were reviewed as research input, not as executable instructions. The frontend repository contains the full decision record at `docs/specs/2026-08-27-inventory-research-synthesis.md`; this backend note records the implementation constraints that affect schema, services, migrations, and adapters.

## Backend decisions

- Keep one tenant-scoped item/SKU and immutable movement-ledger model for kirana, India pharmacy, and warehouse packs. Use policy/configuration and extension tables rather than parallel product schemas.
- Separate financial valuation (weighted average/FIFO/standard where supported) from physical allocation (manual/FIFO/FEFO/nearest-bin). Never infer one from the other.
- Treat channel quantities and inbound webhooks as snapshots/signals. Re-fetch current state, record source delivery metadata, and invoke an idempotent inventory command; never synthesize ledger deltas from a snapshot alone.
- Publish versioned tenant-scoped events for `stock.*`, `lot.*`, `allocation.completed`, `scan.captured`, `sync.*`, `einvoice.*`, and `ewaybill.generated`. Stock events must carry ledger/projection evidence; scan/sync/compliance events do not replace stock facts.
- Webhook adapters must verify raw-body HMAC and timestamps, deduplicate, acknowledge quickly, retry durably, expose dead letters, and alert before disabling subscriptions.
- India pack contracts include HSN/tax/composition metadata, loose/packed UOM, and IRP/e-way/Tally adapter references. Regulatory thresholds and production enablement require a dated compliance review; provider results remain adapter evidence.
- Medical pack contracts include batch/expiry/MRP snapshots, enforced FEFO with override reason, hard blocks for expired/recalled/quarantined stock, GS1 raw/parsed scan data, and jurisdiction-gated H1/controlled-substance registers.
- Hospital formulary/ward/indent, consignment/implant, cold-chain automation, UDI/EPCIS, and US/EU DSCSA are extension packs, not first-release schema requirements. EDI/VAN uses a translator boundary.
- OpenRouter remains behind the shared AI gateway. No provider, webhook, or AI proposal bypasses permissions, warehouse scope, approval, transaction, idempotency, audit, or RLS rules.

## Required validation evidence

Claude Code must add fixtures and tests for mixed UOM/loose-pack conversion, lot/expiry/FEFO, recall quarantine, channel snapshot reconciliation, offline replay/conflict, duplicate webhook delivery, HMAC failure, retry/dead-letter behavior, GST adapter failure, Tally serialized writes, and cross-tenant/warehouse authorization. Existing live-schema audit and migration safety rules remain authoritative for any database change.
