// Tests for the harness itself — the seams every later milestone leans on.
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock, SeqIdGen } from "../../src/util/clock.js";
import { mintPrincipal } from "../support/principal.js";
import { collectSse, parseSseChunk } from "../support/sse.js";
import { createTempHome, withTempHome } from "../support/temp-home.js";
import { assertInTempRoot, isInTempRoot, TempRootViolation } from "../support/temp-root-guard.js";
import { createWorkspace } from "../support/workspace.js";

describe("withTempHome", () => {
	it("[20-development-method#9.3] puts PIUI_HOME inside os.tmpdir() and cleans it up", async () => {
		let captured = "";
		await withTempHome(({ ctx, home }) => {
			captured = home;
			expect(isInTempRoot(ctx.config.home)).toBe(true);
			expect(existsSync(ctx.config.dbPath)).toBe(true);
			// A real file, not :memory: — migrations and WAL behave as in production.
			expect(ctx.config.dbPath.endsWith("piui.db")).toBe(true);
		});
		expect(existsSync(captured)).toBe(false);
	});

	it("[20-development-method#9.3] never points pi's auth path or sessions at the real home", async () => {
		await withTempHome(({ ctx }) => {
			expect(ctx.config.piAuthPath.startsWith(homedir())).toBe(false);
			expect(isInTempRoot(ctx.config.sessionsDir)).toBe(true);
		});
	});

	it("[20-development-method#9.3] fails loudly when production code is handed a path outside the sandbox", () => {
		const realHome = process.env.PIUI_TEST_REAL_HOME!;
		expect(() => assertInTempRoot(join(realHome, ".pi", "agent", "auth.json"))).toThrow(
			TempRootViolation,
		);
		expect(() => assertInTempRoot("/etc/piui.db")).toThrow(TempRootViolation);
		expect(() => assertInTempRoot(mkdtempSync(join(tmpdir(), "piui-ok-")))).not.toThrow();
	});

	it("[20-development-method#9.3] redirects HOME to a sandbox for the whole run", () => {
		expect(process.env.HOME).toBe(process.env.PIUI_TEST_SANDBOX_HOME);
		expect(homedir()).toBe(process.env.PIUI_TEST_SANDBOX_HOME);
	});

	it("gives every temp home its own database", async () => {
		const a = createTempHome();
		const b = createTempHome();
		try {
			expect(a.ctx.config.dbPath).not.toBe(b.ctx.config.dbPath);
		} finally {
			a.cleanup();
			b.cleanup();
		}
	});
});

describe("withWorkspace", () => {
	it("seeds a small file tree in a temp dir", () => {
		const ws = createWorkspace();
		try {
			expect(existsSync(ws.file("src/index.ts"))).toBe(true);
			expect(isInTempRoot(ws.path)).toBe(true);
		} finally {
			ws.cleanup();
		}
	});
});

describe("clock and ids", () => {
	it("advances only when told to", () => {
		const clock = new FakeClock("2026-02-20T10:00:00.000Z");
		expect(clock.nowIso()).toBe("2026-02-20T10:00:00.000Z");
		clock.advance(90_000);
		expect(clock.nowIso()).toBe("2026-02-20T10:01:30.000Z");
	});

	it("produces deterministic ids", () => {
		const ids = new SeqIdGen("conv");
		expect([ids.newId(), ids.newId()]).toEqual(["conv-1", "conv-2"]);
	});
});

describe("principal minting", () => {
	it("[20-development-method#9.3] mints a usable session cookie without a login round trip", async () => {
		await withTempHome(({ ctx }) => {
			const admin = mintPrincipal(ctx);
			expect(admin.principal).toMatchObject({ id: "local", roles: ["admin"] });
			expect(admin.cookie).toMatch(/^piui_sid=[0-9a-f]{64}\.[0-9a-f]{64}$/);
			expect(ctx.repos.authSessions.getLive(admin.sessionId)?.user_id).toBe("local");

			const user = mintPrincipal(ctx, { id: "bob", role: "user" });
			expect(user.principal.roles).toEqual(["user"]);

			const inactive = mintPrincipal(ctx, { id: "zoe", role: "user", active: false });
			expect(ctx.repos.users.get(inactive.principal.id)?.active).toBe(0);
		});
	});

	it("expires sessions against the fake clock", async () => {
		await withTempHome(({ ctx, clock }) => {
			const admin = mintPrincipal(ctx, { ttlMs: 60_000 });
			expect(ctx.repos.authSessions.getLive(admin.sessionId)).toBeDefined();
			clock.advance(60_001);
			expect(ctx.repos.authSessions.getLive(admin.sessionId)).toBeUndefined();
		});
	});
});

describe("SSE harness", () => {
	it("parses frames with their id and buffers partial chunks", () => {
		const first = parseSseChunk('id: 1\ndata: {"type":"ping","seq":1}\n\nid: 2\ndata: {"type":"pi');
		expect(first.frames).toHaveLength(1);
		expect(first.frames[0]!.id).toBe("1");
		expect(first.frames[0]!.json()).toEqual({ type: "ping", seq: 1 });
		const second = parseSseChunk(`${first.rest}ng","seq":2}\n\n`);
		expect(second.frames[0]!.json()).toEqual({ type: "ping", seq: 2 });
	});

	it("collects from a stream and waits for a predicate", async () => {
		async function* source(): AsyncGenerator<string> {
			yield 'id: 1\ndata: {"type":"snapshot","seq":1}\n\n';
			yield 'id: 2\ndata: {"type":"done","seq":2}\n\n';
		}
		const collector = collectSse(source());
		await collector.waitFor((frames) => frames.some((f) => f.data.includes("done")));
		expect(collector.frames.map((f) => f.id)).toEqual(["1", "2"]);
	});
});
