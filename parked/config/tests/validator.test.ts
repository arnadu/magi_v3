import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateTeamConfig } from "../src/validator.js";
import { compileTeamConfig } from "../src/compiler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe("validateTeamConfig — valid config", () => {
  it("accepts a well-formed team config", () => {
    const result = validateTeamConfig(fixture("valid-team.yaml"));
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.config.mission.id).toBe("equity-research-001");
    expect(result.config.agents).toHaveLength(1);
    expect(result.config.agents[0].id).toBe("lead-analyst-001");
    expect(result.config.agents[0].environment).toBe("prod");
  });
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

describe("validateTeamConfig — missing required fields", () => {
  it("rejects config missing mission id", () => {
    const yaml = `
mission:
  name: Test Team
  mandate: Some mandate
agents:
  - id: agent-a
    role: lead_analyst
    displayName: Agent A
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const result = validateTeamConfig(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.path.includes("id"))).toBe(true);
  });

  it("rejects config with empty agents array", () => {
    const yaml = `
mission:
  id: test-001
  name: Test
  mandate: Test mandate
agents: []
`;
    const result = validateTeamConfig(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.errors.some((e) => e.message.includes("at least one agent"))
    ).toBe(true);
  });

  it("rejects agent missing role", () => {
    const yaml = `
mission:
  id: test-001
  name: Test
  mandate: Test mandate
agents:
  - id: agent-a
    displayName: Agent A
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const result = validateTeamConfig(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.path.includes("role"))).toBe(true);
  });

  it("rejects agent missing models", () => {
    const yaml = `
mission:
  id: test-001
  name: Test
  mandate: Test mandate
agents:
  - id: agent-a
    role: lead_analyst
    displayName: Agent A
    environment: dev
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const result = validateTeamConfig(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.path.includes("models"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid tool assignments
// ---------------------------------------------------------------------------

describe("validateTeamConfig — invalid tool assignments", () => {
  function agentWith(tools: { outerLoop: string[]; innerLoop: string[] }) {
    return `
mission:
  id: test-001
  name: Test
  mandate: Test mandate
agents:
  - id: agent-a
    role: lead_analyst
    displayName: Agent A
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [${tools.outerLoop.join(", ")}]
      innerLoop: [${tools.innerLoop.join(", ")}]
`;
  }

  it("rejects an execution tool in the outer loop", () => {
    const result = validateTeamConfig(
      agentWith({ outerLoop: ["ReadMailbox", "ExecProgram"], innerLoop: ["ReadFile"] })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.message.includes("outer-loop"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("ExecProgram"))).toBe(true);
  });

  it("rejects an outer-loop-only tool that does not exist at all", () => {
    const result = validateTeamConfig(
      agentWith({ outerLoop: ["ReadMailbox", "DoSomethingIllegal"], innerLoop: ["ReadFile"] })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.message.includes("DoSomethingIllegal"))).toBe(true);
  });

  it("rejects a completely unknown inner-loop tool", () => {
    const result = validateTeamConfig(
      agentWith({ outerLoop: ["ReadMailbox"], innerLoop: ["ReadFile", "HackThePlanet"] })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.message.includes("inner-loop"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("HackThePlanet"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid environment
// ---------------------------------------------------------------------------

describe("validateTeamConfig — invalid environment", () => {
  it("rejects unknown environment value", () => {
    const yaml = `
mission:
  id: test-001
  name: Test
  mandate: Test mandate
agents:
  - id: agent-a
    role: lead_analyst
    displayName: Agent A
    environment: staging
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const result = validateTeamConfig(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.path.includes("environment"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML
// ---------------------------------------------------------------------------

describe("validateTeamConfig — malformed YAML", () => {
  it("returns a structured parse error for invalid YAML syntax", () => {
    const result = validateTeamConfig("not: valid: yaml: [[[");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0].path).toBe("");
    expect(result.errors[0].message).toContain("YAML parse error");
  });
});

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

describe("compileTeamConfig", () => {
  it("compiles a valid config into AgentIdentity objects", () => {
    const validated = validateTeamConfig(fixture("valid-team.yaml"));
    expect(validated.success).toBe(true);
    if (!validated.success) return;

    const { identities } = compileTeamConfig(validated.config);
    expect(identities).toHaveLength(1);

    const identity = identities[0];
    expect(identity.agentId).toBe("lead-analyst-001");
    expect(identity.missionId).toBe("equity-research-001");
    expect(identity.role).toBe("lead_analyst");
    expect(identity.environment).toBe("prod");
    expect(identity.models.outerLoop).toBe("claude-haiku-4-5-20251001");
    expect(identity.models.innerLoop).toBe("claude-sonnet-4-6");
    expect(identity.workspacePolicy.homePath).toBe(
      "/home/agents/lead-analyst-001"
    );
    expect(identity.workspacePolicy.sharedPaths).toHaveLength(2);
    expect(identity.workspacePolicy.sharedPaths[0].path).toBe(
      "/missions/equity-research-001/shared/junior_analyst"
    );
    expect(identity.workspacePolicy.sharedPaths[0].access).toBe("read");
    expect(identity.toolPolicy.outerLoopTools).toContain("ReadMailbox");
    expect(identity.toolPolicy.outerLoopTools).toContain("UpdateMentalMap");
    expect(identity.toolPolicy.innerLoopTools).toContain("ReadFile");
    expect(identity.toolPolicy.innerLoopTools).toContain("BrowseWeb");
    // gid mirrors uid
    expect(identity.gid).toBe(identity.uid);
  });

  it("assigns a unique UID to each agent", () => {
    const yaml = `
mission:
  id: test-mission
  name: Test
  mandate: Test mandate
agents:
  - id: agent-a
    role: lead_analyst
    displayName: Agent A
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
  - id: agent-b
    role: junior_analyst
    displayName: Agent B
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const validated = validateTeamConfig(yaml);
    expect(validated.success).toBe(true);
    if (!validated.success) return;

    const { identities } = compileTeamConfig(validated.config);
    expect(identities).toHaveLength(2);
    expect(identities[0].uid).not.toBe(identities[1].uid);
  });

  it("produces correct workspace paths for agents with no shared paths", () => {
    const yaml = `
mission:
  id: test-mission
  name: Test
  mandate: Test mandate
agents:
  - id: watcher-001
    role: watcher
    displayName: Watcher
    environment: dev
    models:
      outerLoop: model-fast
      innerLoop: model-capable
    tools:
      outerLoop: [ReadMailbox]
      innerLoop: [ReadFile]
`;
    const validated = validateTeamConfig(yaml);
    expect(validated.success).toBe(true);
    if (!validated.success) return;

    const { identities } = compileTeamConfig(validated.config);
    expect(identities[0].workspacePolicy.sharedPaths).toHaveLength(0);
    expect(identities[0].workspacePolicy.homePath).toBe(
      "/home/agents/watcher-001"
    );
  });
});
