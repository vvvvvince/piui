// Migrations are data, not code: tsc does not copy them.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "db", "migrations"), { recursive: true });
cpSync(join(root, "src", "db", "migrations"), join(root, "dist", "db", "migrations"), {
	recursive: true,
});
