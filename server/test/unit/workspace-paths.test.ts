// spec/04-workspaces.md §2 — the path validation table, and §7.{1,2} in unit form.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type PathPolicy, validateWorkspacePath } from "../../src/workspaces/paths.js";
import { registerTempRoot } from "../support/temp-root-guard.js";

const sandbox = mkdtempSync(join(tmpdir(), "piui-paths-"));
registerTempRoot(sandbox);

const home = join(sandbox, "home");
const piuiHome = join(home, ".piui");
const roots = join(sandbox, "roots");
const project = join(roots, "demo");
const outside = join(sandbox, "elsewhere");

for (const dir of [home, piuiHome, roots, project, outside, join(home, ".ssh"), `${roots}-evil`]) {
	mkdirSync(dir, { recursive: true });
}
writeFileSync(join(project, "file.txt"), "hi\n");
// a symlink *inside* the roots pointing outside them: spec §7.2
symlinkSync(outside, join(roots, "escape"));

const policy: PathPolicy = {
	home,
	piuiHome,
	installDir: join(sandbox, "install"),
	roots: [roots],
};
const unrooted: PathPolicy = { ...policy, roots: [] };

afterAll(() => {
	/* the sandbox lives under tmpdir and is fingerprinted by global setup */
});

describe("validateWorkspacePath", () => {
	it("[04-workspaces#2] accepts an existing writable directory inside the roots", () => {
		expect(validateWorkspacePath(project, policy)).toEqual({ ok: true, path: project });
	});

	it("[04-workspaces#2] normalizes: trailing separators, `.`/`..` segments and `~`", () => {
		expect(validateWorkspacePath(`${project}/`, policy)).toEqual({ ok: true, path: project });
		expect(validateWorkspacePath(`${project}/./sub/..`, policy)).toEqual({
			ok: true,
			path: project,
		});
		expect(validateWorkspacePath("~/.piui", unrooted)).toMatchObject({ code: "path_denylisted" });
	});

	it("[04-workspaces#2] rejects a relative path, an empty path and a NUL byte", () => {
		for (const input of ["projects/demo", "", "./x", `${project}\0/etc`]) {
			expect(validateWorkspacePath(input, unrooted), input).toMatchObject({
				ok: false,
				code: "path_not_absolute",
			});
		}
	});

	it("[04-workspaces#2] rejects a missing path, a file, and a missing parent when creating", () => {
		expect(validateWorkspacePath(join(project, "nope"), policy)).toMatchObject({
			code: "path_not_found",
		});
		expect(validateWorkspacePath(join(project, "file.txt"), policy)).toMatchObject({
			code: "path_not_directory",
		});
		expect(validateWorkspacePath(join(project, "a", "b"), policy, { create: true })).toMatchObject({
			code: "path_not_found",
		});
	});

	it("[04-workspaces#2] accepts a not-yet-existing folder when creation was requested", () => {
		expect(validateWorkspacePath(join(project, "fresh"), policy, { create: true })).toEqual({
			ok: true,
			path: join(project, "fresh"),
		});
	});

	it("[04-workspaces#7.1] denylists the system directories, $HOME itself and the piui home", () => {
		const denied = [
			"/",
			"/etc",
			"/etc/ssl",
			"/usr",
			"/var/lib",
			"/proc",
			home,
			piuiHome,
			join(piuiHome, "scratch"),
			join(home, ".ssh"),
		];
		for (const path of denied) {
			expect(validateWorkspacePath(path, unrooted), path).toMatchObject({
				ok: false,
				code: "path_denylisted",
			});
		}
	});

	it("[04-workspaces#7.1] allows an ordinary subdirectory of $HOME", () => {
		const projects = join(home, "projects", "demo");
		mkdirSync(projects, { recursive: true });
		expect(validateWorkspacePath(projects, unrooted)).toEqual({ ok: true, path: projects });
	});

	it("[04-workspaces#7.2] refuses a path outside PIUI_WORKSPACE_ROOTS, and a symlink that escapes them", () => {
		expect(validateWorkspacePath(outside, policy)).toMatchObject({
			ok: false,
			code: "path_not_allowed",
		});
		// `<roots>/escape` is a prefix match on the *literal* path but resolves outside
		expect(validateWorkspacePath(join(roots, "escape"), policy)).toMatchObject({
			ok: false,
			code: "path_not_allowed",
		});
		// and a prefix that is not a path boundary is not "inside" either
		expect(validateWorkspacePath(`${roots}-evil`, policy)).toMatchObject({
			ok: false,
			code: "path_not_allowed",
		});
	});

	it("[04-workspaces#2] checks the denylist before the roots so /etc keeps its own code", () => {
		expect(validateWorkspacePath("/etc", policy)).toMatchObject({ code: "path_denylisted" });
	});
});
