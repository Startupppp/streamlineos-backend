import { assertDbSpecEnvironmentApproved } from "./db-spec-guard";

// First setupFiles entry of jest-db.json, so no *.db.spec.ts opens a connection
// before the environment has been approved for destructive testing.
assertDbSpecEnvironmentApproved();
