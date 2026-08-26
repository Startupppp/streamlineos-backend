import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

/**
 * Which way a contact travelled.
 *
 * Two values and no third, because a direction that could not be read is not a
 * third kind of direction — it is the absence of one, and the state records it
 * as a count rather than as a value it could later be mistaken for.
 * `directionOf` in `modules/relationships/relationship-state.ts` is the only
 * thing that decides which of these a row is.
 */
export const CONTACT_DIRECTIONS = ["inbound", "outbound"] as const;
export type ContactDirection = (typeof CONTACT_DIRECTIONS)[number];

/**
 * What normal looks like for one relationship, kept where a query can reach it.
 *
 * The inbound loop maps an event to a consequence. That is enough to file a
 * message and enough to extract a next step, and it can never notice that a
 * conversation stopped — because silence is not an event and there is nothing to
 * be triggered by. Noticing it needs the shape of the relationship itself: when
 * each side last spoke, how quickly this particular customer normally answers,
 * who is on the thread, and which conversations exist.
 *
 * Every column below is derived from `activities` and `activity_participants` by
 * `foldRelationshipState`, and by nothing else. That is the property the whole
 * design rests on, and it is why there is one fold rather than an updater and a
 * rebuilder: two computations that are supposed to agree eventually stop
 * agreeing, and then nothing says which of them is right. This is a
 * materialisation — throw all three tables away and the next rebuild puts them
 * back identically.
 *
 * There is one row per party and one per deal, never both on the same row.
 * `activities` has a CHECK permitting exactly one anchor, so a deal's history
 * and its customer's history are disjoint sets of activities, and folding them
 * into one row would merge two things a reader is entitled to see apart.
 */
export const relationshipStates = pgTable(
  "relationship_states",
  {
    relationshipStateId: text("relationship_state_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The anchor, as an exclusive arc: exactly one is set, enforced by a CHECK.
     *
     * Not an `entity_type` + `entity_id` pair, which is banned for new tables —
     * that shape has no foreign key, no referential integrity and no way to
     * carry the composite tenant edge.
     */
    partyId: text("party_id"),
    /**
     * `text`, matching `activities.deal_id`, and with no foreign key for the
     * same reason that column has none: `deals.id` is an integer and the
     * activity model stores whatever the anchor said it was — the cursor suite
     * deliberately proves a deal anchor that is not a number renders as data
     * rather than crashing. A column that had to be coercible here would make
     * this table refuse rows the timeline already holds.
     */
    dealId: text("deal_id"),

    /**
     * The oldest activity the window kept.
     *
     * The window is a count rather than a duration — see
     * `RELATIONSHIP_WINDOW_MAX_ACTIVITIES` — so this moves only when history is
     * added, never merely because time passed. A time-bounded window would make
     * a rebuild differ from the maintained state with no activity having
     * changed, which is exactly the drift a materialisation exists to avoid.
     */
    observedFrom: timestamp("observed_from"),

    lastContactAt: timestamp("last_contact_at"),
    lastInboundAt: timestamp("last_inbound_at"),
    lastOutboundAt: timestamp("last_outbound_at"),
    /** No FK to `activities`: this is a pointer for a reader, not an edge. */
    lastInboundActivityId: text("last_inbound_activity_id"),
    lastOutboundActivityId: text("last_outbound_activity_id"),

    /**
     * When the ball entered their court, null when it is our turn.
     *
     * The first unanswered outbound of the current run rather than the last, so
     * chasing somebody three times in an hour does not restart their clock. A
     * timestamp rather than a flag because the question ticket 02 asks is how
     * long it has been their turn, and a boolean has no answer to that.
     */
    awaitingReplySince: timestamp("awaiting_reply_since"),

    contactCount: integer("contact_count").default(0).notNull(),
    inboundCount: integer("inbound_count").default(0).notNull(),
    outboundCount: integer("outbound_count").default(0).notNull(),
    /**
     * Activities whose direction could not be read.
     *
     * Carried rather than swallowed. A direction we cannot read is not a
     * direction we may assume, and a baseline built on guesses would be worse
     * than no baseline — so the guesses are refused and counted, and a reader
     * can see how much of the history this row is silent about.
     */
    unreadableDirectionCount: integer("unreadable_direction_count").default(0).notNull(),

    /**
     * How quickly they answer, as a distribution.
     *
     * Percentiles rather than a mean, because a mean is the one summary that
     * cannot support a silence judgement: a customer who usually replies within
     * the hour and once took a fortnight has a mean nobody would recognise, and
     * a threshold built on it stays quiet for a week.
     */
    replySampleCount: integer("reply_sample_count").default(0).notNull(),
    replyP50Seconds: integer("reply_p50_seconds"),
    replyP90Seconds: integer("reply_p90_seconds"),
    replyMinSeconds: integer("reply_min_seconds"),
    replyMaxSeconds: integer("reply_max_seconds"),

    participantCount: integer("participant_count").default(0).notNull(),
    threadCount: integer("thread_count").default(0).notNull(),

    /**
     * When the fold last ran. Metadata about the materialisation, not part of
     * the state — two rows built from the same activities differ here and are
     * still identical, which is what `relationship-state.db.spec.ts` asserts.
     */
    builtAt: timestamp("built_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** One state per anchor. The upsert target, and the read. */
    uniqueIndex("uniq_relationship_states_party")
      .on(t.organizationId, t.partyId)
      .where(sql`party_id is not null`),
    uniqueIndex("uniq_relationship_states_deal")
      .on(t.organizationId, t.dealId)
      .where(sql`deal_id is not null`),

    /**
     * The sweep ticket 02 runs: everything where it is still their turn, oldest
     * first. Partial, because a relationship whose turn it is not can never be
     * silent and has no business in that scan.
     */
    index("idx_relationship_states_awaiting")
      .on(t.organizationId, t.awaitingReplySince)
      .where(sql`awaiting_reply_since is not null`),

    /** The composite tenant key the two child tables point at. */
    unique("uniq_relationship_states_org_id").on(t.organizationId, t.relationshipStateId),
  ],
);

/**
 * Who is on this relationship, and in what role.
 *
 * A link table rather than an array on the state, because a participant is a
 * lifecycle entity — it is counted, compared against last week's set, and
 * resolved to a party — and ticket 03's whole subject is one of these rows
 * falling quiet while another starts. An array could express none of that.
 */
export const relationshipParticipants = pgTable(
  "relationship_participants",
  {
    relationshipParticipantId: text("relationship_participant_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    relationshipStateId: text("relationship_state_id").notNull(),

    /**
     * One person, however the activity row happened to name them:
     * `party:<id>` · `user:<id>` · `address:<normalised>`.
     *
     * Normalised on the way in for the same reason `party_identifiers` is —
     * `Priya@Example.com` and `priya@example.com` are one participant, and
     * counting them as two would make "the champion stopped replying" fire the
     * first time somebody's mail client changed its capitalisation.
     */
    identity: text("identity").notNull(),
    partyId: text("party_id"),
    /** No FK to `users` — see `activities.actor_user_id` and migration 0223. */
    userId: text("user_id"),
    address: text("address"),

    /** Every role this person was seen in, sorted so two folds compare equal. */
    roles: text("roles").array().default([]).notNull(),

    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    messageCount: integer("message_count").default(0).notNull(),

    /**
     * How many times this person was the sender of something that came IN.
     *
     * The number ticket 03 reads. A champion who stops replying while a
     * procurement contact starts is a fall in one of these and a rise in
     * another, and nothing else in the model can say it.
     */
    repliedCount: integer("replied_count").default(0).notNull(),
    lastRepliedAt: timestamp("last_replied_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_relationship_participants_identity").on(
      t.organizationId,
      t.relationshipStateId,
      t.identity,
    ),
    index("idx_relationship_participants_state").on(t.organizationId, t.relationshipStateId),
    /** The reverse read: every relationship this party appears on. */
    index("idx_relationship_participants_party")
      .on(t.organizationId, t.partyId)
      .where(sql`party_id is not null`),
  ],
);

/**
 * The conversations this relationship has had.
 *
 * Its lineage column is adjacency and is named for that. Nothing below the
 * ingress seam carries a provider-stated parent — `InboundCommunicationEvent`
 * has no `In-Reply-To` field and no adapter reads one — so `parent_thread_id`
 * would be a claim the data cannot support. Which conversation was live when
 * this one began is genuinely observable, and it is the whole of what a fork
 * judgement needs.
 */
export const relationshipThreads = pgTable(
  "relationship_threads",
  {
    relationshipThreadId: text("relationship_thread_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    relationshipStateId: text("relationship_state_id").notNull(),

    /** Opaque, exactly as `activities.thread_id` is. */
    threadId: text("thread_id").notNull(),
    /** The first subject the thread was seen under. */
    subject: text("subject"),

    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    messageCount: integer("message_count").default(0).notNull(),
    lastDirection: text("last_direction").$type<ContactDirection>(),

    precededByThreadId: text("preceded_by_thread_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_relationship_threads_thread").on(
      t.organizationId,
      t.relationshipStateId,
      t.threadId,
    ),
    index("idx_relationship_threads_state").on(t.organizationId, t.relationshipStateId),
    /** Which relationship a thread belongs to, read from the thread's own id. */
    index("idx_relationship_threads_lookup").on(t.organizationId, t.threadId),
  ],
);
