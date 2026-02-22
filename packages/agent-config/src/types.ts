export interface AgentConfig {
	/** Stable identifier used in mailbox routing, mental map keys, etc. */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Role label shown to teammates. */
	role: string;
	/** Mission statement injected into the agent's system prompt. */
	mission: string;
	/** Agent id to escalate to, or "user" for the operator. */
	supervisor: string;
}

export interface MissionConfig {
	id: string;
	name: string;
}

export interface TeamConfig {
	mission: MissionConfig;
	agents: AgentConfig[];
}
