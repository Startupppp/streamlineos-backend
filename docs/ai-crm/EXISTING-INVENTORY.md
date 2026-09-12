# StreamlineOS CRM — EXISTING vs GAP Inventory

**Purpose:** Map working CRM code vs gaps for an India AI CRM PRD. This is NOT a feature spec—it's a baseline to keep the working system while building on top.

**Date:** 2026-08-26  
**Scope:** Backend only (`src/modules/crm`, `party`, `deals`, `leads`, `clients`, `contacts`, `autonomy`, `ingress`, `data-quality`, `activities`, `quotes`, `email`)

---

## 1. KEEP — Working Features That Must Not Be Replaced

### 1.1 Party Identity Model ✅
**The Canonical Identity System**

**Tables:**
- `business_parties` — the single person/company record
- `party_roles` — CUSTOMER · VENDOR · PARTNER · PROSPECT (one party, many roles)
- `party_contacts` — contact persons attached to a party
- `party_identifiers` — phone/email/domain claims for resolution
- `party_roles`, `party_merges`, `party_duplicate_candidates`

**Legacy Mappings (for expand-contract migration):**
- `lead_party_map` — which party a legacy lead ID means
- `client_party_map` — which party a legacy client ID means
- `contact_party_map` — which party a legacy contact ID means
- `crm_org_party_map` — which party a legacy crm_organizations ID means

**Modules:**
- `src/modules/party/` — all party operations
  - `party.service.ts` — CRUD + list + soft delete
  - `party-seam.ts` — resolution (lead/client/contact → party)
  - `party-legacy-writer.ts` — bidirectional sync with legacy tables
  - `party-merge.service.ts` — merge parties with undo
  - `party-duplicates.ts` — duplicate detection logic
  - `party-identifiers.ts` — identifier claiming/matching

**Why Keep:**
- Unified identity across lifecycle stages (lead → client → vendor)
- Duplicate detection via identifiers (phone/email/domain)
- Merge with full reversal capability
- 4 legacy tables map to this during migration

**Code Volume:** ~11 files in `leads`/`clients`/`contacts` still reference legacy schema via party mappings

---

### 1.2 Pipeline & Deals ✅
**Sales Pipeline Management**

**Tables:**
- `deals` — the deal record (value, stage, party, subject, probability)
- `deal_stage_transitions` — audit trail of every stage move (human/system actor)
- `deal_activities` — legacy activity log (still in use)
- `deal_meetings` + `deal_meeting_attendees` — meeting scheduling
- `deal_approvals` + `deal_approval_rules` — approval workflows
- `crm_deal_competitors` — competitor tracking per deal
- `crm_deal_stakeholders` — contact roles in a deal
- `crm_forecast_snapshots` — revenue forecast snapshots
- `sales_quotas`, `commissions`, `commission_rules` — quota/commission tracking
- `territories` + `territory_reps` + `territory_locations` — geographic/criteria-based territories
- `crmPipelines` (metadata table) — custom pipelines

**Modules:**
- `src/modules/deals/` — all deal operations
  - `deals.service.ts` — CRUD, lifecycle transitions
  - `deals-stage-ledger.ts` — stage history ledger
  - `deals-analytics.service.ts` — pipeline reporting
  - `deals-approvals.service.ts` — approval workflow
  - `deals-forecast.spec.ts` — forecast calculations

**Why Keep:**
- Complete deal lifecycle tracking
- Audit trail of stage transitions (actor + reason)
- Forecast snapshots (point-in-time revenue projections)
- Territory assignment and quota management
- Approval workflows for large deals

---

### 1.3 Activities & Timeline ✅
**Unified Activity Stream**

**Tables:**
- `activities` — single table for all activity kinds (call/email/meeting/note/task)
- `activity_participants` — who was on it (party/user/unresolved address)

**Schema:** `src/db/schema/crm/activities.ts`

**Key Features:**
- Keyset pagination on `(occurred_at, activity_id)` — stable scrolling through high-volume timelines
- Thread grouping via `thread_id` (RFC 5322 or synthesized)
- Explicit `actor_kind` (human/system) so AI actions are visible
- Replaces 5 legacy activity tables (lead_activities, deal_activities, client_account_activities, tasks, crm_activities)

**Modules:**
- `src/modules/activities/` — activity CRUD
  - `activities.service.ts` — create, list by party/deal/subject
  - `activity-timeline.ts` — timeline assembly logic

**Why Keep:**
- Single source of truth for "what happened"
- Thread continuity (emails, WhatsApp)
- AI transparency (system actor tracked)
- Efficient timeline reads with partial indexes

---

### 1.4 Autonomy & Holds ✅
**AI Decision Tracking & Review**

**Tables:**
- `autonomous_decisions` — every AI action + reversibility
- `autonomy_holds` — messages held before send (cancel window)
- `autonomy_corrections` — human reversals
- `autonomy_scoring` — confidence/accuracy tracking
- `autonomy_switches` — kill switches per action type

**Schema:** `src/db/schema/crm/autonomous-decisions.ts`, `autonomy-holds.ts`, etc.

**Modules:**
- `src/modules/autonomy/` — autonomy framework
  - `autonomy.service.ts` — decision recording
  - `autonomy-hold.service.ts` — hold window management
  - `autonomy-review.controller.ts` — review feed API
  - `autonomy-scoring.service.ts` — accuracy measurement
  - `decision-record.ts` — decision structure
  - `hold-window.ts` — configurable hold intervals
  - `kill-switch.ts` — per-action-type disablement
  - `reversal-plan.ts` — undo planning
  - `quote-draft.ts` — quote drafting logic

**Decision Kinds:**
- `task.extracted` — AI extracted a task from a message
- `stage.advanced` — AI moved a deal forward
- `party.created` — AI created a party from inbound
- `activity.logged` — AI logged a call/email
- `quote.sent` — AI drafted and sent a quote

**Reversibility Classes:**
- `instant` — single write undoes it
- `hold` — can be cancelled before it leaves
- `irreversible` — reached customer, only correction possible

**Why Keep:**
- Complete audit trail of AI actions
- Configurable hold windows (e.g., 5-min cancel window for quotes)
- Per-action kill switches
- Accuracy scoring (reversal rate per model/prompt version)

---

### 1.5 Ingress — Omnichannel Capture ✅
**Inbound Message Handling**

**Tables:**
- `inbound_events` — idempotent receipt for all channels
- `crm_mailbox_sync` — email sync watermarks (Gmail/Outlook)

**Schema:** `src/db/schema/crm/inbound-events.ts`, `mailbox-sync.ts`

**Modules:**
- `src/modules/ingress/` — ingress framework
  - `inbound-ingress.service.ts` — seam that creates party/activity
  - `inbound-ingress.workflow.ts` — durable ingress workflow (Temporal)
  - `adapters/whatsapp-ingress.service.ts` — WhatsApp Cloud API adapter
  - `adapters/whatsapp-webhook.ts` — webhook signature verification
  - `adapters/whatsapp-to-inbound-event.ts` — WhatsApp → normalized event
  - `adapters/crm-mailbox.service.ts` — email sync (Gmail/Outlook via Composio)
  - `adapters/mailbox-sync.ts` — watermark-based sync sweep
  - `adapters/mailbox-push.ts` — webhook push for new mail
  - `adapters/telephony-call-log.service.ts` — call logging
  - `adapters/telephony-to-inbound-event.ts` — call → normalized event
  - `adapters/web-form-submission.ts` — web form capture
  - `adapters/web-form-to-inbound-event.ts` — form → normalized event

**Supported Channels:**
- **Email** — Gmail/Outlook via Composio (push + sweep)
- **WhatsApp** — Cloud API webhook
- **Telephony** — call logs (adapter exists, provider TBD)
- **Web Forms** — embedded forms with public token

**Why Keep:**
- Channel-agnostic ingress seam (one workflow, many adapters)
- Idempotency on `(org, provider, provider_message_id)` — no duplicate parties
- Watermark-based email sync (survives reconnection)
- Thread continuity via `provider_thread_id`

---

### 1.6 Data Quality & Duplicate Management ✅
**Dataset Health & Duplicate Queue**

**Tables:**
- `data_quality_findings` — queue of data issues (duplicates, unreachable, stale)
- `data_quality_resolutions` — bulk resolution decisions
- `data_quality_health_snapshots` — daily health score per org
- `party_duplicate_candidates` — auto-detected duplicate pairs
- `party_merges` — merge history with undo snapshot

**Schema:** `src/db/schema/crm/data-quality.ts`, `src/db/schema/party/party-roles.ts`

**Modules:**
- `src/modules/data-quality/` — data quality system
  - `data-quality.controller.ts` — queue API
  - `data-quality-producers.service.ts` — finding writers
  - `data-quality-resolution.service.ts` — bulk resolution
  - `data-quality-queue.service.ts` — assignment/prioritization
  - `dataset-health.service.ts` — health score calculation
  - `finding-vocabulary.ts` — finding kinds/severities
  - `producer-bands.ts` — producer grouping
- `src/modules/party/party-merge.service.ts` — merge execution + undo
- `src/modules/party/party-duplicates.ts` — duplicate detection logic

**Producers:**
- `duplicate` — two parties with matching identifiers
- `contradiction` — same identifier, different stronger ID (e.g., same email, different tax number)
- `reachability` — suppressed/malformed/no channel
- `staleness` — untouched for N days
- `import-uncertainty` — import row with ambiguous match

**Why Keep:**
- Weighted health score (high/medium/low severity)
- Bulk resolution (one decision, 400 findings)
- Merge with full snapshot (reversible)
- Age tracking (first_detected_at never resets)
- Group-based queuing (e.g., "all parties with suppressed email")

---

### 1.7 Pricebooks & Quotes ✅
**Product Pricing & Quote Generation**

**Tables:**
- `crm_pricebooks` — pricebook header (currency, default flag)
- `crm_pricebook_entries` — product prices per pricebook (tiered by min quantity)
- `crm_products` — product catalog
- `crm_quote_settings` — discount limits, expiry defaults
- `crm_quote_templates` — quote templates (branding, terms)
- `quotes` (in `src/db/schema/accounting/`) — quote records

**Schema:** `src/db/schema/crm/pricebooks.ts`, `products.ts`

**Modules:**
- `src/modules/crm/core/crm-products.service.ts` — product CRUD
- `src/modules/quotes/` — quote lifecycle
  - `quotes.service.ts` — quote CRUD
  - `quotes-lifecycle.service.ts` — draft → sent → accepted workflow

**Why Keep:**
- Multi-currency pricebooks
- Quantity-based pricing tiers
- Discount approval rules
- Quote templates with branding

**DO NOT TOUCH:** Quote kernel (`quotes.service.ts`, `quotes-lifecycle.service.ts`) — lifecycle logic is stable

---

### 1.8 Consent & Compliance ✅
**GDPR/DPDP Consent Management**

**Tables:**
- `crm_contact_channel_consent` — current consent state per channel (EMAIL/SMS/WHATSAPP/PHONE)
- `crm_contact_consent_events` — append-only consent history
- `crm_suppression_hashes` — opt-out hashes (survives erasure)

**Schema:** `src/db/schema/crm/consent.ts`

**Modules:**
- `src/modules/crm/consent/` — consent management
  - `crm-consent.service.ts` — consent CRUD + enforcement
  - `crm-consent.controller.ts` — consent API
  - `crm-outbound-email.service.ts` — email send with consent check
  - `unsubscribe-token.util.ts` — unsubscribe token generation

**Legal Basis:**
- `CONSENT` — explicit opt-in
- `LEGITIMATE_INTEREST` — legitimate interest
- `CONTRACT` — contractual necessity
- `LEGAL_OBLIGATION` — legal requirement

**Why Keep:**
- Channel-specific consent (email ≠ WhatsApp ≠ SMS)
- Audit trail (every consent change logged)
- Suppression hashes (opt-out survives contact deletion)
- Unsubscribe tokens in outbound messages

---

### 1.9 Automation Studio ✅
**No-Code Workflows & Sequences**

**Tables:**
- `crm_sequences` — sequence definitions (email/task cadences)
- `crm_sequence_steps` — steps in a sequence (email/task/wait)
- `crm_sequence_enrollments` — active enrollments (entity → sequence)
- `crm_automation_rules` — event-triggered rules (if-this-then-that)
- `crm_automation_runs` — run history

**Schema:** `src/db/schema/crm/automation-studio.ts`, `automation-rules.ts`

**Modules:**
- `src/modules/crm/automation-studio/` — automation engine
  - `crm-sequences.service.ts` — sequence CRUD
  - `crm-sequences-runner.service.ts` — enrollment execution (Temporal worker)
  - `crm-automation-runner.service.ts` — rule execution
  - `crm-automation-condition-evaluator.ts` — condition matching
  - `crm-automation-bus.service.ts` — event bus integration

**Features:**
- **Sequences:** multi-step cadences (email → wait 2 days → task → email)
- **Stop-on conditions:** auto-unenroll when deal closes/lead replies
- **Rules:** event triggers (lead.created → assign territory → send welcome email)
- **Cooldowns:** prevent duplicate triggers within N hours

**Why Keep:**
- Durable workflow execution (Temporal)
- Condition-based enrollment/unenrollment
- Rule chaining with cycle detection
- Execution audit trail

---

### 1.10 Playbook ✅
**Sales Knowledge Base**

**Tables:**
- `playbook_entries` — articles (title, category, content, sort order)

**Schema:** `src/db/schema/crm/playbook.ts`

**Module:** `src/modules/crm/core/` (no dedicated module, CRUD in CRM core)

**Why Keep:**
- Simple, working knowledge base
- Category-based organization
- Sort order for custom arrangement

---

### 1.11 Attribution & Campaigns ✅
**Lead Source & Campaign Tracking**

**Tables:**
- `crm_lead_touchpoints` — lead touch history (utm data, campaign, source)
- `crm_campaigns` — campaign definitions
- `crm_attribution` (referenced but not in provided schemas)

**Schema:** `src/db/schema/crm/attribution.ts`, `campaigns.ts`

**Modules:**
- `src/modules/crm/core/crm-campaigns.service.ts` — campaign CRUD
- `src/modules/crm/core/crm-attribution-report.service.ts` — attribution reporting

**Why Keep:**
- Multi-touch attribution (first/last/all touches)
- UTM capture and storage
- Campaign ROI tracking

---

### 1.12 Web Forms ✅
**Embeddable Lead Capture Forms**

**Tables:**
- `web_lead_forms` — form definitions (fields, redirect, submit message)

**Schema:** `src/db/schema/crm/leads.ts` (same file as leads)

**Modules:**
- `src/modules/crm/core/crm-web-forms.service.ts` — form CRUD
- `src/modules/leads/leads.ingest.controller.ts` — public form submission endpoint
- `src/modules/ingress/adapters/web-form-submission.ts` — form → ingress adapter

**Why Keep:**
- Public token-based forms (no auth required)
- Custom field definitions
- Ingress integration (form → party + activity)

---

### 1.13 Subjects (Generic Transaction Objects) ✅
**Industry-Agnostic Entity Modeling**

**Tables:**
- `subject_types` — tenant-defined entity types (Property, Policy, Shipment, Candidate)
- `subjects` — entity instances with custom fields
- `subject_party_links` — relationship between subject and party (OWNER, BUYER, VENDOR, etc.)

**Schema:** `src/db/schema/party/subjects.ts`

**Modules:**
- `src/modules/party/subject.service.ts` — subject CRUD
- `src/modules/party/subject.controller.ts` — subject API
- `src/modules/party/subject-seam.ts` — subject resolution
- `src/modules/party/subject-values.ts` — custom field handling

**Why Keep:**
- Solves the "generic CRM" problem (where does the property/shipment/policy go?)
- Tenant-defined types without migrations
- Typed custom fields (text, email, phone, money, date, select, badge)
- Links deals/activities to subjects (e.g., deal for Property #123)

---

### 1.14 CRM Import & Connectors ✅
**Import from Other CRMs**

**Modules:**
- `src/modules/crm/import/` — import framework
  - `column-mapping.ts` — deterministic header → field mapping
  - `connectors/hubspot.connector.ts` — HubSpot import
  - `connectors/pipedrive.connector.ts` — Pipedrive import
  - `connectors/salesforce.connector.ts` — Salesforce import
  - `connectors/zoho.connector.ts` — Zoho import
  - `crm-connector.service.ts` — connector orchestration
  - `crm-connector.workflow.ts` — import workflow (Temporal)

**Why Keep:**
- 4 CRM connectors working
- Deterministic header mapping (no AI for "Email")
- Watermark-based incremental sync
- Import uncertainty → data quality queue

---

### 1.15 Legacy Tables (Still Active) ⚠️
**Phase 2 Expand-Contract Migration In Progress**

**Tables Still in Use:**
- `leads` (11 imports found) — still primary for lead operations
- `clients` (27 imports found) — still primary for client operations  
- `contacts` (27 imports found) — still primary for contact operations
- `crm_organizations` (converged to party in ticket 25, map exists)

**Why These Still Exist:**
- Expand-contract pattern: new party surface coexists with legacy
- Legacy modules (`leads`, `clients`, `contacts`) still operate on old tables
- Bidirectional sync via `party-legacy-writer.ts` keeps both sides live
- 15+ modules outside CRM still reference legacy tables (accounting, inventory, support, build, billing)

**Contract Phase Not Yet Started:**
- Leads module not yet rewritten to read from party
- Clients module not yet rewritten
- Contacts module not yet rewritten

---

## 2. EXTEND — Existing Pieces to Deepen (Not Rewrite)

### 2.1 WhatsApp Inbox UI
**Status:** Ingress adapter exists, no UI inbox

**What Exists:**
- `whatsapp-ingress.service.ts` — webhook receiver
- `whatsapp-to-inbound-event.ts` — normalization
- `inbound_events` table — messages stored
- `activities` table — messages become activities

**What's Missing:**
- UI inbox to read/reply to WhatsApp threads
- Message templates for outbound
- Media handling UI (images/PDFs in thread)
- Read receipts / delivery status

**How to Extend:**
- Build inbox UI reading `activities` where `channel = 'whatsapp'`
- Outbound via WhatsApp Cloud API (already integrated)
- Thread grouping via `thread_id` (already populated)

---

### 2.2 Party Duplicate UI
**Status:** Detection exists, UI for review/merge is minimal

**What Exists:**
- `party-duplicates.ts` — detection logic (phone/email/domain/name similarity)
- `party_duplicate_candidates` table — detected pairs
- `data_quality_findings` table — duplicates as findings
- `party-merge.service.ts` — merge execution with undo

**What's Missing:**
- Bulk review UI (approve/dismiss/merge)
- Confidence threshold tuning
- Auto-merge for high-confidence pairs
- Merge preview (field-by-field diff)

**How to Extend:**
- Expose `data_quality_findings` where `producer = 'duplicate'`
- Build review UI with confidence slider
- Auto-merge flag on high-confidence findings
- Merge preview using `party-merge-plan.ts`

---

### 2.3 Visit/Geo Tracking
**Status:** Telephony adapter logs calls, no geo tracking

**What Exists:**
- `activities` table — can hold location metadata
- `telephony-call-log.service.ts` — call logging

**What's Missing:**
- GPS check-in for field reps
- Visit activity type (distinct from call/meeting)
- Geo-fencing (alert when rep enters territory)
- Visit duration tracking

**How to Extend:**
- Add `visit` to `ACTIVITY_KINDS` (currently call/email/meeting/note/task)
- Add `location` field to activity metadata (lat/lng + address)
- Mobile app sends check-in → creates visit activity
- Territory match service checks location against `territory_locations`

---

### 2.4 AI Activity Extraction
**Status:** Framework exists in autonomy, not wired to all ingress

**What Exists:**
- `autonomous_decisions` table — tracks AI actions
- `autonomy-hold.service.ts` — hold window for review
- `decision-record.ts` — decision structure

**What Could Be Wired:**
- Email body → task extraction
- Call transcript → follow-up extraction
- WhatsApp message → next-action extraction

**How to Extend:**
- Wire LLM extraction to ingress workflow
- Each extraction writes `task.extracted` decision
- Extracted tasks create activities with `actor_kind = 'system'`
- Hold window for review (e.g., 5 min) via `autonomy_holds`

---

## 3. GAP — Missing Features for India AI CRM

### 3.1 WhatsApp Inbox UI ❌
**Status:** Ingress exists, no inbox

See **2.1 EXTEND** above — inbox is a frontend + outbound send feature, ingress is done.

---

### 3.2 Visit/Geo Tracking ❌
**Status:** Partial (call logs exist, no GPS check-in)

See **2.3 EXTEND** above — add visit activity type + mobile check-in.

---

### 3.3 Required Next-Action ❌
**Status:** No enforcement

**What's Missing:**
- Required next action per deal stage
- Block stage advance without next-action set
- Today queue of due actions

**Implementation Path:**
- Add `required_next_action` to `crm_pipelines` stage config
- Add `next_action` + `next_action_due` to `deals`
- Gate stage transition on `next_action` filled
- Today queue: `activities` where `assignee = me` and `due_at <= today`

---

### 3.4 Today Queue ❌
**Status:** Task list exists, no consolidated "Today" view

**What Exists:**
- `activities` table with `assignee_user_id` + `due_at`
- Index on `(org_id, assignee_user_id, due_at)` for open tasks

**What's Missing:**
- Unified "Today" view (tasks + follow-ups + SLA breaches)
- Prioritization (overdue → today → tomorrow)
- Quick actions (complete/snooze/reassign)

**Implementation Path:**
- Query `activities` where `assignee = me` and `due_at <= tomorrow`
- Join with `deals` where `follow_up_date <= today`
- Join with `crm_sla_breach_log` for SLA breaches
- Sort by priority (SLA > overdue > due today)

---

### 3.5 IndiaMART Lead Capture ❌
**Status:** Not found in codebase

**What's Missing:**
- IndiaMART webhook receiver
- IndiaMART → `inbound_event` adapter
- Lead deduplication by phone (India format normalization)

**Implementation Path:**
- New adapter: `src/modules/ingress/adapters/indiamart-ingress.service.ts`
- Webhook endpoint: `POST /webhooks/indiamart`
- Normalize Indian phone numbers (+91 prefix, 10 digits)
- Map to `inbound_event` → `party` + `activity`

---

### 3.6 GSTIN/Phone Duplicate Merge UI ❌
**Status:** Party merge exists, no GSTIN-specific UI

**What Exists:**
- `business_parties.tax_number` — stores GSTIN
- `party_identifiers` — stores phone/email
- `party_duplicate_candidates` — detected duplicates
- `party-merge.service.ts` — merge with undo

**What's Missing:**
- GSTIN duplicate detection (exact match + fuzzy)
- Phone duplicate detection (India format normalization)
- Bulk merge UI by GSTIN/phone

**Implementation Path:**
- Add GSTIN to `party-duplicates.ts` detector
- Add phone normalization (India +91 format)
- Wire to data quality queue (`producer = 'duplicate'`)
- Use existing merge UI (see **2.2 EXTEND**)

---

### 3.7 Click-to-Call Auto-Log ❌
**Status:** Telephony adapter exists, no auto-log

**What Exists:**
- `telephony-call-log.service.ts` — call logging adapter
- `activities` table — holds calls

**What's Missing:**
- Click-to-call UI (dial from party/deal screen)
- Auto-create call activity on dial
- Call duration tracking
- Call recording integration

**Implementation Path:**
- Frontend: click phone number → dial API
- Dial API creates `activity` with `kind = 'call'`, `actor_kind = 'human'`
- Telephony provider webhook updates duration + recording URL
- Activity shows in timeline immediately

---

### 3.8 Approve-Before-Write AI ❌
**Status:** Hold mechanism exists, not applied to all AI writes

**What Exists:**
- `autonomy_holds` table — hold window for quotes
- `autonomy-hold.service.ts` — hold management
- Hold workflow: create hold → wait → send or cancel

**What's Not Wired:**
- Task extraction (bypasses hold, writes immediately)
- Stage advance (bypasses hold)
- Party creation from inbound (bypasses hold)

**Implementation Path:**
- Add hold flag to `autonomous_decisions` decision config
- Holdable actions: create `autonomy_hold` row with `hold_until`
- Workflow waits for `hold_until` or `cancelled_at`
- UI shows pending holds with cancel button

---

## 4. DO NOT TOUCH — Off-Limits Areas

### 4.1 HR Module
**Path:** `src/modules/hr`, `src/db/schema/hr`
**Reason:** 70+ files, 170+ tables, table count frozen per CLAUDE.md

### 4.2 Payroll Module
**Path:** `src/modules/payroll`, `src/db/schema/payroll`
**Reason:** Separate from HR as of recent refactor, complex compliance logic

### 4.3 Accounting Write Paths
**Path:** `src/modules/accounting`, `src/modules/finance`
**Reason:** Ledger double-entry accounting, GST compliance

**Note:** Accounting *reads* CRM data (invoicing, revenue recognition) — that's fine. Do not modify accounting write paths.

### 4.4 Quotes Kernel
**Path:** `src/modules/quotes/quotes-lifecycle.service.ts`
**Reason:** Quote lifecycle (draft → sent → accepted) is stable and tested

**Note:** Pricebooks (`crm_pricebooks`) are CRM and editable. Quote lifecycle is not.

### 4.5 E-Sign Internals
**Path:** `src/modules/e-sign`
**Reason:** Integration with external e-signature providers (DocuSign, etc.)

### 4.6 Build Module
**Path:** `src/modules/build`
**Reason:** Product management / roadmap system, separate domain

---

## 5. Party Identity Rule

### The Canonical Model
**`business_parties` is the party. Everything else is a role or facet.**

- **One party record per human/company** in an organization
- **Roles are rows in `party_roles`** (CUSTOMER, VENDOR, PARTNER, PROSPECT)
- **One party can hold many roles** (same company is both customer and vendor)

### Legacy Tables Are Mirrors (During Migration)
- `leads` — **not the party**, a lifecycle stage
- `clients` — **not the party**, a customer facet
- `contacts` — **not the party**, a person facet
- `crm_organizations` — **not the party**, a company record (converged in ticket 25)

### Resolution Path
**Always resolve through the seam:**
- `party-seam.ts` — takes a `PersonSubject` (lead/client/contact ID) → returns party
- `party-legacy-seam.ts` — maps legacy IDs to party IDs
- Never query `leads`/`clients`/`contacts` directly to find a party

### Bidirectional Sync
**Writer keeps both sides live:**
- `party-legacy-writer.ts` — updates party → mirrors to legacy tables
- Updates to party write through to `leads`/`clients`/`contacts` via mapping
- Updates to legacy tables are **not yet bidirectional** (contract phase not started)

### Code References
**Legacy table imports found:**
- `leads` — 11 imports (mostly in `party` module + lead triggers)
- `contacts` — 27 imports (party, inventory, support, build, billing, accounting, finance, surveys, timesheets)
- `clients` — fewer, mostly in party module

**What This Means for New Code:**
- New CRM surfaces should read/write `business_parties`
- Legacy modules will continue using old tables until contract phase
- Party is forward-looking; legacy is compatibility

---

## 6. Key Folder Paths & Services

### Schema
- `src/db/schema/party/` — party, subjects, legacy maps
- `src/db/schema/crm/` — activities, leads, deals, contacts, campaigns, consent, data-quality, playbook, etc.

### Core Modules
- `src/modules/party/` — party identity, merge, duplicates, seam
- `src/modules/deals/` — pipeline, forecasting, approvals
- `src/modules/leads/` — lead management (legacy table), conversion
- `src/modules/clients/` — client management (legacy table)
- `src/modules/contacts/` — contact management (legacy table)
- `src/modules/activities/` — activity timeline
- `src/modules/autonomy/` — AI decisions, holds, scoring
- `src/modules/ingress/` — inbound message handling
- `src/modules/data-quality/` — duplicate queue, health score
- `src/modules/crm/core/` — campaigns, products, territories, SLA, dashboards
- `src/modules/crm/automation-studio/` — sequences, rules, conditions
- `src/modules/crm/consent/` — GDPR consent management
- `src/modules/crm/import/` — CRM connectors (HubSpot, Salesforce, etc.)

### Key Services (Main Entry Points)
- `PartyService` — party CRUD, list, merge, contacts
- `DealsService` — deal CRUD, stage transitions
- `LeadsService` — lead CRUD (legacy table)
- `ClientsService` — client CRUD (legacy table)
- `ContactsService` — contact CRUD (legacy table)
- `ActivitiesService` — activity CRUD, timeline
- `InboundIngressService` — ingress seam (message → party + activity)
- `DataQualityResolutionService` — bulk resolution
- `PartyMergeService` — merge parties with undo
- `AutonomyService` — record AI decisions
- `AutonomyHoldService` — hold window management

---

## 7. Summary

### What's Rock-Solid (KEEP)
✅ Party identity + merge with undo  
✅ Pipeline/deals with audit trail  
✅ Unified activity timeline  
✅ AI autonomy framework (decisions, holds, scoring)  
✅ Omnichannel ingress (WhatsApp, email, telephony, web forms)  
✅ Data quality queue with bulk resolution  
✅ Pricebooks + quote generation  
✅ Consent management (GDPR/DPDP)  
✅ Automation Studio (sequences, rules)  
✅ Subjects (generic transaction objects)  
✅ CRM import (HubSpot, Salesforce, Pipedrive, Zoho)  

### What's Halfway Done (EXTEND)
🔧 WhatsApp inbox (ingress ✅, UI inbox ❌)  
🔧 Duplicate merge UI (detection ✅, bulk UI ❌)  
🔧 Visit tracking (call logs ✅, GPS check-in ❌)  
🔧 AI extraction (framework ✅, not wired to all ingress ❌)  

### What's Missing (GAP)
❌ Visit/geo tracking (GPS check-in)  
❌ Required next-action enforcement  
❌ Today queue (unified view)  
❌ IndiaMART lead capture  
❌ GSTIN duplicate merge UI  
❌ Click-to-call auto-log  
❌ Approve-before-write AI (holds exist, not wired to all actions)  

### What's Off-Limits (DO NOT TOUCH)
🚫 HR (frozen table count)  
🚫 Payroll  
🚫 Accounting write paths  
🚫 Quotes kernel (lifecycle)  
🚫 E-sign internals  
🚫 Build module  

---

## Next Steps (For PRD Authors)

1. **Read this as the baseline** — do not redesign what works
2. **GAP features are net-new** — build on existing tables/modules
3. **EXTEND features deepen existing code** — do not rewrite ingress
4. **Party is the identity model** — new code uses `business_parties`, not `leads`/`clients`
5. **Autonomy framework is the AI pattern** — use it for all AI actions
6. **Test with legacy tables still live** — they're not gone until contract phase completes

**This inventory ensures the PRD builds forward, not sideways.**
