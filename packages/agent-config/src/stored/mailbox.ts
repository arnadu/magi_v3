/**
 * `mailbox`: inter-agent and operator messages. Written through the worker's
 * MailboxRepository.post() and the control plane's postMailbox() (tripwire
 * T12 keeps raw inserts out); read by agents' prompts, the cockpit, both
 * copilots and the wake-up Change Streams.
 */

export interface MailboxMessage {
	id: string;
	missionId: string;
	/** Agent id, "user", or a system sender. */
	from: string;
	/** Agent ids and/or "user". */
	to: string[];
	subject: string;
	body: string;
	timestamp: Date;
	/** Readers that have marked it read (agent ids, "user"). */
	readBy: string[];
}
