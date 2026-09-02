import type { ImportEntity } from "../import-entities";
import { ACTIVITY_WRITER } from "./activity.writer";
import { PARTY_WRITER } from "./party.writer";
import { PIPELINE_WRITER } from "./pipeline.writer";
import { SUBJECT_WRITER } from "./subject.writer";
import type { EntityWriter } from "./entity-writer";

export type { EntityWriter, WriteContext } from "./entity-writer";

/**
 * Every writer, as one exhaustive record.
 *
 * A `Record<ImportEntity, …>` rather than a lookup that can miss, for the same
 * reason `CONNECTORS` is one: adding an entity to the union is then a compile
 * error here until somebody writes its writer, instead of a runtime `undefined`
 * that reads as "that import wrote nothing".
 */
const WRITERS: Readonly<Record<ImportEntity, EntityWriter>> = {
  party: PARTY_WRITER,
  subject: SUBJECT_WRITER,
  pipeline: PIPELINE_WRITER,
  activity: ACTIVITY_WRITER,
};

export function writerFor(entity: ImportEntity): EntityWriter {
  return WRITERS[entity];
}

/** Whether an entity can match a record that already exists and fill its gaps. */
export function canUpdate(entity: ImportEntity): boolean {
  return WRITERS[entity].updates !== undefined;
}
