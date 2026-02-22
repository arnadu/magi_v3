export type MailboxMessageIntent =
  | "task_request"
  | "data_request"
  | "result_submit"
  | "risk_alert"
  | "critical_alert";

export interface MailboxMessage {
  id: string;
  missionId: string;
  senderAgentId: string;
  /** Target a specific agent by ID, or broadcast to a role. */
  recipientAgentId?: string;
  recipientRole?: string;
  intent: MailboxMessageIntent;
  subject: string;
  body: string;
  /** Artifact IDs that accompany this message. */
  artifactRefs: string[];
  /** 0–100; higher is more urgent. */
  priority: number;
  /** ISO 8601. */
  deadline?: string;
  /** Links a result_submit back to its originating task_request. */
  correlationId?: string;
  /** ISO 8601. */
  createdAt: string;
}
