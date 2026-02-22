export type AgentWorkflowSignal =
  | "inbound_message"
  | "schedule_fire"
  | "critical_alert"
  | "abort";

/** Values the inner loop can return via the nextAction structured output. */
export type InnerLoopNextAction =
  | "publish_and_stop"
  | "wait_for_input"
  | "escalate";

/** Values the outer loop can return via the nextAction structured output. */
export type OuterLoopNextAction = "triage_complete" | "waiting_for_teammate";

export type NextAction = InnerLoopNextAction | OuterLoopNextAction;

export const INNER_LOOP_NEXT_ACTIONS: InnerLoopNextAction[] = [
  "publish_and_stop",
  "wait_for_input",
  "escalate",
];

export const OUTER_LOOP_NEXT_ACTIONS: OuterLoopNextAction[] = [
  "triage_complete",
  "waiting_for_teammate",
];

/**
 * Minimal durable state kept in the Temporal workflow.
 * All rich state lives in the Mental Map (MongoDB document).
 */
export interface AgentWorkflowState {
  agentId: string;
  missionId: string;
  /** MongoDB document ID of this agent's Mental Map. */
  mentalMapDocumentId: string;
  innerLoopRunning: boolean;
  /** Mailbox message IDs received since the last outer loop run. */
  pendingMessageIds: string[];
}
