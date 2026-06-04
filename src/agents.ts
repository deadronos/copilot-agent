import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

import type { AgentDefinition } from './types.js';
import { logger } from './logger.js';

// ── Frontmatter schema ──────────────────────────────────────────────

const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

// ── Public interface ────────────────────────────────────────────────

export interface AgentRegistry {
  load(): Promise<void>;
  list(): ReadonlyArray<AgentDefinition>;
  get(name: string): AgentDefinition | null;
  defaultAgent(): AgentDefinition;
}

// ── Default assistant agent ─────────────────────────────────────────

export function createDefaultAssistantAgent(): AgentDefinition {
  return {
    name: 'assistant',
    description: 'A general-purpose helpful assistant',
    systemPrompt:
      'You are a helpful, friendly assistant. Answer questions concisely and accurately. When you are unsure, say so rather than guessing.',
    sourcePath: 'builtin',
    loadedAt: Date.now(),
  };
}

// ── Factory ─────────────────────────────────────────────────────────

export function createAgentRegistry(
  configDir: string,
  agentsDir: string,
  defaultAgentName: string,
): AgentRegistry {
  let agents: ReadonlyArray<AgentDefinition> = [];

  async function load(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(agentsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(
          `Agents directory not found at ${agentsDir}; using default assistant agent only`,
        );
        const defaultAgent = createDefaultAssistantAgent();
        agents = Object.freeze([defaultAgent]) as unknown as ReadonlyArray<AgentDefinition>;
        return;
      }
      throw err;
    }

    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

    const seen = new Map<string, AgentDefinition>();

    for (const file of mdFiles) {
      const filePath = path.join(agentsDir, file);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        throw new Error(`Failed to read agent file ${filePath}: ${String(err)}`);
      }

      const parsed = matter(raw);

      // Check for missing name before validation to give a clearer error.
      if (!parsed.data.name || typeof parsed.data.name !== 'string' || parsed.data.name.trim() === '') {
        throw new Error(
          `Agent file ${filePath} is missing required frontmatter field "name"`,
        );
      }

      const result = AgentFrontmatterSchema.safeParse(parsed.data);
      if (!result.success) {
        throw new Error(
          `Invalid frontmatter in ${filePath}:\n${z.formatError(result.error)}`,
        );
      }

      const { name, description, model, tools } = result.data;

      const def: AgentDefinition = {
        name,
        description,
        model,
        tools: tools as ReadonlyArray<string> | undefined,
        systemPrompt: parsed.content.trim(),
        sourcePath: filePath,
        loadedAt: Date.now(),
      };

      if (seen.has(name)) {
        logger.warn(
          `Duplicate agent name "%s" in %s; overwriting previously loaded agent`,
          name,
          filePath,
        );
      }
      seen.set(name, def);
    }

    agents = Object.freeze(
      [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ) as unknown as ReadonlyArray<AgentDefinition>;

    logger.info(
      'Loaded %d agent(s): %s',
      agents.length,
      agents.map((a) => a.name).join(', ') || '(none)',
    );
  }

  function list(): ReadonlyArray<AgentDefinition> {
    return agents;
  }

  function get(name: string): AgentDefinition | null {
    return agents.find((a) => a.name === name) ?? null;
  }

  function defaultAgent(): AgentDefinition {
    const agent = agents.find((a) => a.name === defaultAgentName);
    if (!agent) {
      throw new Error(
        `Default agent '${defaultAgentName}' not found. Ensure an agent with this name exists in ${agentsDir} or update "agents.default" in config.yaml.`,
      );
    }
    return agent;
  }

  void configDir; // reserved for future use (e.g. resolving relative paths)

  return { load, list, get, defaultAgent };
}
