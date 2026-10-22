/**
 * `scheduled_messages`: timed wakeups the control plane's scheduler fires.
 *
 * Writers: the control-plane copilot (`create_schedule`), the mission copilot
 * (`CreateScheduledMessage`), the machine-upgrade reminder, and the daemon's
 * import of `shared/schedules/*.json` (ADR-0033 §3, `origin` set). The
 * scheduler claims due documents, delivers mail or stamps `pendingFire`, and
 * re-arms cron entries.
 */

export const SCHEDULE_ORIGIN = "shared-schedules" as const;

export type ScheduledMessageStatus =
	| "pending"
	| "delivering"
	| "delivered"
	| "cancelled"
	| "failed";

export interface ScheduledJobSpec {
	agentId: string;
	scriptPath: string;
	args: string[];
	notifyAgentId?: string;
	notifySubject?: string;
}

interface ScheduledDocBase {
	missionId: string;
	/** Job documents carry mail-shaped fields too, so generic listings can show them. */
	to: string[];
	subject: string;
	body: string;
	/** Next fire time; the scheduler writes the next occurrence back here for cron entries. */
	deliverAt: Date;
	cron?: string;
	label?: string;
	status: ScheduledMessageStatus;
	/** Set when a tick claims the entry; a stale claim is re-opened after the delivery lease. */
	claimedAt?: Date;
	deliveredAt?: Date;
	deliveryAttempts?: number;
	/** Firebase uid (copilot-created) or agent id (imported file's owner). */
	createdBy?: string;
	createdAt?: Date;
	updatedAt?: Date;
	cancelledAt?: Date;
	/**
	 * An operator cancel (cockpit or control-plane copilot). Ingest never
	 * re-arms a file-backed schedule carrying it while its file remains;
	 * removing the file clears it, so a file added later is a new schedule.
	 */
	cancelledBy?: "operator";
	/** Present only on documents imported from `shared/schedules/`. */
	origin?: typeof SCHEDULE_ORIGIN;
	specHash?: string;
}

/** Absent `kind` or "message": delivered to the mailbox. */
export interface ScheduledMailDoc extends ScheduledDocBase {
	kind?: "message";
}

/**
 * "job": no mail. The scheduler stamps `pendingFire` (overwriting coalesces
 * missed occurrences) and wakes the machine; the daemon turns the stamp into a
 * background job and clears it.
 */
export interface ScheduledJobDoc extends ScheduledDocBase {
	kind: "job";
	jobSpec: ScheduledJobSpec;
	pendingFire?: { dueAt: Date; requestedAt: Date };
	lastFiredAt?: Date;
}

export type ScheduledMessageDoc = ScheduledMailDoc | ScheduledJobDoc;
