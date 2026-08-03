// Operator CLI — the only way to administer users. Run it inside the container
// (Railway → Console, or `railway ssh`):
//
//   node dist/scripts/admin.js create --name Bruno [--limit 5]
//   node dist/scripts/admin.js list
//   node dist/scripts/admin.js activate --id 3
//   node dist/scripts/admin.js deactivate --id 3
//   node dist/scripts/admin.js set-limit --id 3 --limit 10
//
// There is deliberately no HTTP equivalent: shell access to the box is already
// strictly more powerful than an admin endpoint, so a second remotely-reachable
// key-minting credential would be pure downside (see CLAUDE.md "Auth model").
//
// This is a thin shell over services/users.ts — all real validation (name length,
// limit bounds, unknown id) lives there and reaches us as a thrown ApiError, whose
// `.message` we print and whose `.status` we ignore.

import { parseArgs } from "node:util";
import { createUser, listUsers, setUserActive, setUserLimit } from "../services/users.js";

const USAGE = `Usage: node dist/scripts/admin.js <command> [options]

Commands:
  create --name <name> [--limit <usd>]   Issue a license key
  list                                   List users with month-to-date spend
  activate --id <id>                     Re-enable a license key
  deactivate --id <id>                   Revoke a license key (next request 403s)
  set-limit --id <id> --limit <usd>      Move a user's monthly USD cap`;

/** CLI-level parsing only — range/shape checks belong to the service. */
function num(raw: string | undefined, flag: string): number {
  if (raw === undefined) fail(`Missing required option --${flag}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${flag} must be a number, got "${raw}"`);
  return n;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    id: { type: "string" },
    limit: { type: "string" },
  },
});

const command = positionals[0];

try {
  switch (command) {
    case "create": {
      if (values.name === undefined) fail("Missing required option --name");
      // undefined limit → the service applies DEFAULT_MONTHLY_LIMIT_USD.
      const limit = values.limit === undefined ? undefined : num(values.limit, "limit");
      const user = createUser(values.name, limit);
      console.log(`Created user ${user.id} (${user.name}), limit $${user.monthlyLimitUsd}/month`);
      console.log(`\nLicense key (shown once — only its hash is stored):\n\n  ${user.key}\n`);
      break;
    }

    case "list": {
      const users = listUsers();
      if (users.length === 0) {
        console.log("No users.");
        break;
      }
      console.table(
        users.map((u) => ({
          id: u.id,
          name: u.name,
          active: Boolean(u.active),
          limitUsd: u.monthlyLimitUsd,
          spentUsd: Number(u.spentUsd.toFixed(4)),
          createdAt: u.createdAt,
        })),
      );
      break;
    }

    // Two commands rather than one --active <bool>, so there's no flag to fat-finger.
    case "activate":
    case "deactivate": {
      const id = num(values.id, "id");
      const active = command === "activate";
      setUserActive(id, active);
      console.log(`User ${id} ${active ? "activated" : "deactivated"}`);
      break;
    }

    case "set-limit": {
      const id = num(values.id, "id");
      const applied = setUserLimit(id, num(values.limit, "limit"));
      console.log(`User ${id} monthly limit set to $${applied}`);
      break;
    }

    default:
      console.error(command ? `Unknown command: ${command}\n` : "No command given.\n");
      console.error(USAGE);
      process.exit(2);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
