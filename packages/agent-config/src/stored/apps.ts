/**
 * Interactive apps (ADR-0037): one document per declared app of a mission,
 * keyed `{missionId, name}`. Written only by the daemon's app supervisor
 * (`mm-apps`); the control plane reads it to open an app.
 */

/** What the platform knows how to run; it builds each command line itself. */
export type AppKind = "jupyter" | "gradio" | "site";

export type AppStatus = "starting" | "running" | "stopped" | "failed";

export interface MissionAppDoc {
	missionId: string;
	/** A slug, unique within the mission. */
	name: string;
	/** The agent that declared it; the app runs as this agent's OS user. */
	owner: string;
	kind: AppKind;
	/** The folder (jupyter, site) or the Python file (gradio), absolute and contained. */
	path: string;
	/** `site` only: an optional Python file of request handlers. */
	handlers?: string;
	description: string;
	/**
	 * The secret in the app's path on the apps host. Never shown to agents;
	 * read by the control plane to issue a ticket.
	 */
	capability: string;
	status: AppStatus;
	/** Loopback port while starting or running. */
	port?: number;
	/** When the platform restarted it after a crash, within the last hour. */
	restarts: Date[];
	lastError?: string;
	lastOpenedAt?: Date;
	rssMb?: number;
	declaredAt: Date;
	statusChangedAt: Date;
	updatedAt: Date;
}
