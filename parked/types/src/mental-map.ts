export type TaskStatus = "pending" | "in-progress" | "done" | "blocked";

export type TaskSource = "message" | "schedule" | "self";

export interface PrioritizedTask {
  id: string;
  status: TaskStatus;
  /** 0–100; higher is more urgent. */
  priority: number;
  /** ISO 8601. */
  deadline?: string;
  source: TaskSource;
  /** Mailbox message ID or Temporal schedule ID that created this task. */
  sourceRef?: string;
  /** Free-form prose description shown to the agent. */
  description: string;
}

export interface MentalMapDocument {
  agentId: string;
  missionId: string;
  /**
   * Full HTML with stable section IDs:
   *   #mission-context, #tasks, #working-notes, #waiting-for
   *
   * Task list items carry data-* attributes:
   *   data-priority="{0-100}"
   *   data-deadline="{ISO 8601}"
   *   data-source="{message|schedule|self}"
   */
  html: string;
  version: number;
  /** ISO 8601. */
  updatedAt: string;
}

export type MentalMapPatchOperation = "replace" | "append" | "remove";

export interface MentalMapPatch {
  operation: MentalMapPatchOperation;
  /** Stable HTML element ID to target (e.g. "task-abc123", "working-notes"). */
  elementId: string;
  /** Required for replace and append; omit for remove. */
  content?: string;
}

/**
 * Canonical Mental Map HTML skeleton.
 * Agents start with this structure; sections are populated by UpdateMentalMap.
 */
export const MENTAL_MAP_TEMPLATE = `<section id="mission-context">
  <p>No mission context set.</p>
</section>
<section id="tasks">
  <ol></ol>
</section>
<section id="working-notes">
  <p></p>
</section>
<section id="waiting-for">
  <ul></ul>
</section>`;
