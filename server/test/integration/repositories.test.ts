// The scoping rule (spec/18-multi-user.md §4) is the thing that must never silently break.
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../src/db/repositories/base.js";
import { principalOf } from "../support/principal.js";
import { withTempHome } from "../support/temp-home.js";

const admin = principalOf("local", "admin");
const alice = principalOf("alice", "user");
const bob = principalOf("bob", "user");

function seedUsers(ctx: { db: any; clock: { nowIso(): string } }): void {
	for (const id of ["alice", "bob"]) {
		ctx.db
			.prepare(
				`INSERT INTO users (id, username, display_name, role, active, created_at, updated_at)
				 VALUES (?, ?, ?, 'user', 1, ?, ?)`,
			)
			.run(id, id, id, ctx.clock.nowIso(), ctx.clock.nowIso());
	}
}

describe("repository scoping", () => {
	it("[18-multi-user#9.2] stamps owner_id from the request principal", async () => {
		await withTempHome(({ ctx }) => {
			seedUsers(ctx);
			const profile = ctx.repos.profiles.create(alice, { name: "writer" });
			const workspace = ctx.repos.workspaces.create(alice, { name: "ws", path: "/tmp/ws-a" });
			const conversation = ctx.repos.conversations.create(alice, {
				mode: "chat",
				provider: "piui-fake",
				modelId: "fake-1",
			});
			expect(profile.owner_id).toBe("alice");
			expect(workspace.owner_id).toBe("alice");
			expect(conversation.owner_id).toBe("alice");
			expect(profile.visibility).toBe("private");
		});
	});

	it("[18-multi-user#9.4] hides another user's private rows behind 404, not 403", async () => {
		await withTempHome(({ ctx }) => {
			seedUsers(ctx);
			const profile = ctx.repos.profiles.create(alice, { name: "writer" });
			expect(ctx.repos.profiles.get(bob, profile.id)).toBeUndefined();
			expect(ctx.repos.profiles.list(bob)).toHaveLength(0);
			expect(() => ctx.repos.profiles.getForWrite(bob, profile.id)).toThrow(NotFoundError);
		});
	});

	it("[18-multi-user#9.5] lets another user read a shared profile but not write it; an admin may write it", async () => {
		await withTempHome(({ ctx }) => {
			seedUsers(ctx);
			const profile = ctx.repos.profiles.create(alice, {
				name: "shared-one",
				visibility: "shared",
			});
			expect(ctx.repos.profiles.get(bob, profile.id)?.id).toBe(profile.id);
			expect(() => ctx.repos.profiles.getForWrite(bob, profile.id)).toThrow(ForbiddenError);
			expect(
				ctx.repos.profiles.update(admin, profile.id, { description: "by admin" }).description,
			).toBe("by admin");
		});
	});

	it("[18-multi-user#9.6] never shows conversations across users, not even to an admin", async () => {
		await withTempHome(({ ctx }) => {
			seedUsers(ctx);
			const conversation = ctx.repos.conversations.create(alice, {
				mode: "chat",
				provider: "piui-fake",
				modelId: "fake-1",
			});
			expect(ctx.repos.conversations.list(bob)).toHaveLength(0);
			expect(ctx.repos.conversations.list(admin)).toHaveLength(0);
			expect(ctx.repos.conversations.get(admin, conversation.id)).toBeUndefined();
			expect(() => ctx.repos.conversations.getOrThrow(admin, conversation.id)).toThrow(
				NotFoundError,
			);
			expect(ctx.repos.conversations.list(alice)).toHaveLength(1);
		});
	});

	it("keeps workspaces scoped the same way", async () => {
		await withTempHome(({ ctx }) => {
			seedUsers(ctx);
			const own = ctx.repos.workspaces.create(alice, { name: "mine", path: "/tmp/mine" });
			ctx.repos.workspaces.create(bob, {
				name: "theirs",
				path: "/tmp/theirs",
				visibility: "shared",
			});
			expect(ctx.repos.workspaces.list(alice).map((w) => w.name)).toEqual(["mine", "theirs"]);
			expect(ctx.repos.workspaces.get(bob, own.id)).toBeUndefined();
		});
	});
});
