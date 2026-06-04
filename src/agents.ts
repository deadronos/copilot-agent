import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import type { AppConfig, AgentDefinition } from "./types.js";
import { getChildLogger } from "./logger.js";

const log = getChildLogger("agents");

/**
 * Scan the agents directory and load all agent definitions.
 * Validates frontmatter and returns a map of name -> AgentDefinition.
 */
export function loadAgents(config: AppConfig, configDir: string): Map<string, AgentDefinition> {
  const agentsDir = resolve(configDir, config.agents.dir);
  const agents = new Map<string, AgentDefinition>();

  if (!existsSync(agentsDir)) {
    log.warn({ agentsDir }, "Agents directory does not exist");
    return agents;
  }

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(agentsDir, file);
    try {
      const agent = parseAgentFile(filePath);
      if (agent) {
        if (agents.has(agent.name)) {
          log.warn(
            { name: agent.name, file },
            "Duplicate agent name, later file wins"
          );
        }
        agents.set(agent.name, agent);
        log.info({ name: agent.name, file }, "Loaded agent");
      }
    } catch (err) {
      log.error({ file, err }, "Failed to load agent file");
      throw new Error(`Malformed agent file ${filePath}: ${(err as Error).message}`);
    }
  }

  // Validate that the default agent exists
  if (!agents.has(config.agents.default)) {
    log.warn(
      { default: config.agents.default, available: [...agents.keys()] },
      "Default agent not found"
    );
  }

  return agents;
}

/**
 * Parse a single agent markdown file with frontmatter.
 */
function parseAgentFile(filePath: string): AgentDefinition | null {
  const raw = readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  if (!data.name) {
    log.warn({ filePath }, "Agent file missing 'name' in frontmatter, skipping");
    return null;
  }

  return {
    name: data.name,
    description: data.description ?? "",
    model: data.model,
    tools: data.tools,
    prompt: content.trim(),
  };
}

/**
 * Get a system message config for the SDK from an agent definition.
 */
export function getAgentSystemMessage(
  agent: AgentDefinition
): { mode: "replace"; content: string } {
  return {
    mode: "replace",
    content: agent.prompt,
  };
}
