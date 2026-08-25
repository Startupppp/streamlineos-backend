/**
 * The two run names, in a file that imports nothing.
 *
 * The workflow depends on the service to do the work and the service depends on
 * the names to start a run, which is a cycle if the names live with the handler.
 * Separated rather than duplicated: a name that disagreed with the one
 * registered would start a run the registry does not know, and the runtime
 * dead-letters that immediately with no clue as to why.
 */

export const COMMIT_WORKFLOW = "crm.import-commit";
export const REVERT_WORKFLOW = "crm.import-revert";

/**
 * Reading a connected CRM forward.
 *
 * A third name rather than a parameter on the commit, because it is a different
 * shape of run: the commit walks fixed row windows of a file that already
 * exists, and this walks pages of a collection whose size nobody knows until it
 * ends.
 */
export const CONNECTOR_SYNC_WORKFLOW = "crm.connector-sync";
