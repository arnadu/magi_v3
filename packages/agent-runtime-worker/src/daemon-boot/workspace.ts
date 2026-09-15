import { join } from "node:path";
import { WorkspaceManager } from "../workspace-manager.js";
import type { BootContext } from "./context.js";

export function constructWorkspaceManager(
	ctx: Pick<BootContext, "workdir" | "teamDir" | "repoRoot">,
): Pick<BootContext, "workspaceManager"> {
	const teamSkillsPath =
		process.env.TEAM_SKILLS_PATH ?? join(ctx.teamDir, "skills");
	return {
		workspaceManager: new WorkspaceManager({
			layout: {
				homeBase: join(ctx.workdir, "home"),
				missionsBase: join(ctx.workdir, "missions"),
			},
			platformSkillsPath: join(ctx.repoRoot, "packages", "skills"),
			teamSkillsPath,
		}),
	};
}
