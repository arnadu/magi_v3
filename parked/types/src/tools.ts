/**
 * Tool permission schema.
 *
 * These lists define the complete permitted sets for each loop tier.
 * Team configs may assign subsets of these tools; they may not assign tools
 * outside these sets.
 *
 * Tools that appear in both lists (mailbox, ReadArtifact) are safe in either
 * context; their behaviour does not change between tiers.
 */

export const OUTER_LOOP_TOOLS = [
  "ReadMailbox",
  "AckMailboxMessage",
  "UpdateMentalMap",
  "SendMailboxMessage",
  "ReadArtifact",
] as const;

export const INNER_LOOP_TOOLS = [
  // File system
  "ReadFile",
  "EditFile",
  "WriteFile",
  "ListDir",
  "FindFiles",
  "GrepFiles",
  "Bash",
  // Execution (Sprint 5+)
  "ExecProgram",
  "ProgramStatus",
  "ReadLogs",
  "StopProgram",
  // Web (Sprint 5+)
  "BrowseWeb",
  "FetchData",
  // Data (Sprint 5+)
  "AnalyzeData",
  // Artifacts
  "PublishArtifact",
  "ReadArtifact",
  // Mailbox (inner loop may also send/receive)
  "SendMailboxMessage",
  "ReadMailbox",
  "AckMailboxMessage",
] as const;

export type OuterLoopTool = (typeof OUTER_LOOP_TOOLS)[number];
export type InnerLoopTool = (typeof INNER_LOOP_TOOLS)[number];

export const OUTER_LOOP_TOOL_SET = new Set<string>(OUTER_LOOP_TOOLS);
export const INNER_LOOP_TOOL_SET = new Set<string>(INNER_LOOP_TOOLS);
