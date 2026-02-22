import { z } from "zod";
import { OUTER_LOOP_TOOL_SET, INNER_LOOP_TOOL_SET } from "@magi/types";

const ModelConfigSchema = z.object({
  outerLoop: z.string().min(1, "outerLoop model must be non-empty"),
  innerLoop: z.string().min(1, "innerLoop model must be non-empty"),
});

const SharedPathSchema = z.object({
  role: z.string().min(1, "shared path role must be non-empty"),
  access: z.enum(["read", "write", "read-write"]),
});

const ToolsSchema = z.object({
  outerLoop: z.array(z.string()).refine(
    (tools) => tools.every((t) => OUTER_LOOP_TOOL_SET.has(t)),
    (tools) => ({
      message: `Invalid outer-loop tools: [${tools
        .filter((t) => !OUTER_LOOP_TOOL_SET.has(t))
        .join(", ")}]. Permitted outer-loop tools: [${[...OUTER_LOOP_TOOL_SET].join(", ")}]`,
    })
  ),
  innerLoop: z.array(z.string()).refine(
    (tools) => tools.every((t) => INNER_LOOP_TOOL_SET.has(t)),
    (tools) => ({
      message: `Invalid inner-loop tools: [${tools
        .filter((t) => !INNER_LOOP_TOOL_SET.has(t))
        .join(", ")}]. Permitted inner-loop tools: [${[...INNER_LOOP_TOOL_SET].join(", ")}]`,
    })
  ),
});

const AgentConfigSchema = z.object({
  id: z.string().min(1, "agent id is required"),
  role: z.string().min(1, "agent role is required"),
  displayName: z.string().min(1, "displayName is required"),
  environment: z.enum(["dev", "prod"]),
  models: ModelConfigSchema,
  tools: ToolsSchema,
  workspace: z
    .object({
      sharedPaths: z.array(SharedPathSchema).default([]),
    })
    .optional(),
});

export const TeamConfigSchema = z.object({
  mission: z.object({
    id: z.string().min(1, "mission id is required"),
    name: z.string().min(1, "mission name is required"),
    mandate: z.string().min(1, "mission mandate is required"),
  }),
  agents: z
    .array(AgentConfigSchema)
    .min(1, "at least one agent is required"),
});

export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
