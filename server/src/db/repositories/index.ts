import type { Clock, IdGen } from "../../util/clock.js";
import type { Db } from "../index.js";
import { AuthSessionRepository } from "./auth-sessions.js";
import { ConversationRepository } from "./conversations.js";
import { ExtensionRepository } from "./extensions.js";
import { HttpToolRepository } from "./http-tools.js";
import { ProfileRepository } from "./profiles.js";
import { SkillRepository } from "./skills.js";
import { ToolSettingsRepository } from "./tools.js";
import { UserRepository } from "./users.js";
import { WorkspaceRepository } from "./workspaces.js";

export type { AuthSessionRow } from "./auth-sessions.js";
export * from "./base.js";
export type { ConversationRow } from "./conversations.js";
export type { ExtensionRow } from "./extensions.js";
export type { HttpToolRow } from "./http-tools.js";
export type { ProfileRow } from "./profiles.js";
export type { SkillRow } from "./skills.js";
export type { UserRow } from "./users.js";
export type { WorkspaceRow } from "./workspaces.js";

export interface Repositories {
	users: UserRepository;
	authSessions: AuthSessionRepository;
	profiles: ProfileRepository;
	skills: SkillRepository;
	workspaces: WorkspaceRepository;
	conversations: ConversationRepository;
	tools: ToolSettingsRepository;
	httpTools: HttpToolRepository;
	extensions: ExtensionRepository;
}

export function createRepositories(db: Db, clock: Clock, ids: IdGen): Repositories {
	return {
		users: new UserRepository(db, clock, ids),
		authSessions: new AuthSessionRepository(db, clock, ids),
		profiles: new ProfileRepository(db, clock, ids),
		skills: new SkillRepository(db, clock, ids),
		workspaces: new WorkspaceRepository(db, clock, ids),
		conversations: new ConversationRepository(db, clock, ids),
		tools: new ToolSettingsRepository(db, clock, ids),
		httpTools: new HttpToolRepository(db, clock, ids),
		extensions: new ExtensionRepository(db, clock, ids),
	};
}
