process.stdout.write(
  JSON.stringify(
    {
      status: "superseded",
      supersededBy: "migration 0342_role_assignment_collapse.sql",
      detail:
        "user_roles and membership_role_assignments were collapsed into role_assignments by migration 0342. This script is no longer needed.",
    },
    null,
    2,
  ) + "\n",
);
process.exit(0);
