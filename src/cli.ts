import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import YAML from 'yaml';

import type { AppConfig } from './types.js';
import { resolveConfigDir, loadConfig, loadPreset, listPresets } from './config.js';
import { createAgentRegistry } from './agents.js';
import type { AgentRegistry } from './agents.js';
import { getProvider, listProviders } from './providers/registry.js';
import type { Provider, PresetConfig, LoginMethod, ModelInfo } from './providers/types.js';
import { presetToPresetConfig } from './providers/types.js';
import { atomicWriteFile } from './providers/_shared/fs.js';

// ── CLI dispatch ──────────────────────────────────────────────────────

export async function runCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp();
    return;
  }

  const subcommand = args[0];
  const subargs = args.slice(1);

  try {
    switch (subcommand) {
      case 'provider':
        await handleProvider(subargs);
        break;
      case 'agent':
        await handleAgent(subargs);
        break;
      case 'config':
        await handleConfig(subargs);
        break;
      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message ?? String(err)}`);
    process.exit(1);
  }
}

// ── Help ───────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(`copilot-agent — personal AI assistant CLI

Usage:
  copilot-agent                    start the bot
  copilot-agent <subcommand>       run a CLI operation

Subcommands:
  provider list                    list configured presets
  provider add <provider-id> [name]  add a new preset (interactive onboarding)
  provider remove <name>           delete a preset
  provider show <name>             print preset details (secrets redacted)
  provider login <name>            authenticate a preset
  provider logout <name>           deauthenticate a preset (deletes token)
  provider refresh <name>          discover models for a preset

  agent list                       list all agents
  agent show <name>                print agent source file
  agent create <name>              scaffold a new agent and open \$EDITOR
  agent edit <name>                open agent file in \$EDITOR
  agent delete <name>              delete an agent file

  config get [key]                 print config (secrets redacted)
  config set <key> <value>         update a config entry

  help                             print this help
`);
}

// ── Table formatting ───────────────────────────────────────────────────

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;

  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    colWidths.push(Math.max(...rows.map((r) => (r[c] ?? '').length)));
  }

  for (const row of rows) {
    const line = row.map((cell, i) => (cell ?? '').padEnd(colWidths[i] ?? 0)).join('  ');
    process.stdout.write(line + '\n');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Provider subcommands
// ═══════════════════════════════════════════════════════════════════════

async function handleProvider(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: copilot-agent provider <list|add|remove|show|login|logout|refresh>');
    process.exit(1);
  }

  const op = args[0];
  const rest = args.slice(1);

  switch (op) {
    case 'list':
      await handleProviderList();
      break;
    case 'add':
      await handleProviderAdd(rest);
      break;
    case 'remove':
      await handleProviderRemove(rest);
      break;
    case 'show':
      await handleProviderShow(rest);
      break;
    case 'login':
      await handleProviderLogin(rest);
      break;
    case 'logout':
      await handleProviderLogout(rest);
      break;
    case 'refresh':
      await handleProviderRefresh(rest);
      break;
    default:
      console.error(`Unknown provider operation: ${op}`);
      process.exit(1);
  }
}

// ── provider list ──────────────────────────────────────────────────────

async function handleProviderList(): Promise<void> {
  const configDir = resolveConfigDir();
  const presetIds = await listPresets(configDir);

  if (presetIds.length === 0) {
    process.stdout.write('No presets configured. Use "copilot-agent provider add <provider-id>" to create one.\n');
    return;
  }

  const rows: string[][] = [['NAME', 'PROVIDER', 'AUTH', 'MODELS', 'DEFAULT MODEL']];

  for (const presetId of presetIds) {
    const preset = await loadPreset(configDir, presetId);
    const providerId = (preset.provider as string) ?? presetId;
    const provider = getProvider(providerId);
    const models = (preset.models as ModelInfo[] | undefined) ?? [];
    const presetConfig = presetToPresetConfig(preset, providerId, models);
    const authMethod = presetConfig.auth.kind;

    rows.push([
      presetId,
      provider?.displayName ?? providerId,
      authMethod,
      String(presetConfig.models.length),
      presetConfig.defaultModel ?? '-',
    ]);
  }

  printTable(rows);
}

// ── provider add ───────────────────────────────────────────────────────

async function handleProviderAdd(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider add <provider-id> [preset-name]');
    console.error('\nAvailable providers:');
    for (const p of listProviders()) {
      console.error(`  ${p.id} — ${p.displayName}`);
    }
    process.exit(1);
  }

  const providerId = args[0];
  const presetName = args[1] ?? providerId;

  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`Unknown provider: ${providerId}`);
    console.error('Available providers:');
    for (const p of listProviders()) {
      console.error(`  ${p.id} — ${p.displayName}`);
    }
    process.exit(1);
  }

  const configDir = resolveConfigDir();
  const presetsDir = path.join(configDir, 'presets');
  await fs.mkdir(presetsDir, { recursive: true, mode: 0o700 });
  const presetPath = path.join(presetsDir, `${presetName}.yaml`);

  // Refuse to overwrite an existing preset.
  try {
    await fs.access(presetPath);
    console.error(`Preset "${presetName}" already exists. Remove it first or choose a different name.`);
    process.exit(1);
  } catch {
    // expected — file does not exist
  }

  const method = await chooseLoginMethod(provider);

  process.stdout.write(`Onboarding provider "${provider.displayName}" as preset "${presetName}"…\n`);

  let presetConfig: PresetConfig;
  try {
    presetConfig = await provider.onboard(presetName, method);
  } catch (err) {
    console.error(`Onboarding failed: ${(err as Error).message ?? String(err)}`);
    // Clean up any partial token file that may have been created.
    try {
      await fs.unlink(presetPath);
    } catch {
      // ignore
    }
    process.exit(1);
  }

  // Write the preset file atomically with 0600.
  const yamlContent = YAML.stringify(presetConfigToYaml(presetConfig));
  await atomicWriteFile(presetPath, yamlContent, { mode: 0o600 });

  process.stdout.write(`\nPreset "${presetName}" created successfully.\n`);
  process.stdout.write(`  Path:      ${presetPath}\n`);
  process.stdout.write(`  Provider:  ${provider.displayName}\n`);
  process.stdout.write(`  Auth:      ${method}\n`);
  process.stdout.write(`  Models:    ${presetConfig.models.map((m) => m.id).join(', ')}\n`);
  process.stdout.write(`  Default:   ${presetConfig.defaultModel ?? 'none'}\n`);
}

// ── Interactive login-method selection ─────────────────────────────────

async function chooseLoginMethod(provider: Provider): Promise<LoginMethod> {
  const methods: LoginMethod[] = [];
  if (provider.capabilities.apiKey) methods.push('api_key');
  if (provider.capabilities.deviceFlow) methods.push('device_flow');
  if (provider.capabilities.oauthFlow) methods.push('oauth');

  if (methods.length === 0) {
    console.error(`Provider "${provider.id}" supports no login methods.`);
    process.exit(1);
  }

  if (methods.length === 1) {
    process.stdout.write(`Auth method: ${methods[0]}\n`);
    return methods[0];
  }

  process.stdout.write('Choose an auth method:\n');
  for (let i = 0; i < methods.length; i++) {
    process.stdout.write(`  ${i + 1}. ${methods[i]}\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<LoginMethod>((resolve) => {
    rl.question('Enter number: ', (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      const method = methods[idx];
      if (method) {
        resolve(method);
      } else {
        console.error('Invalid selection.');
        process.exit(1);
      }
    });
  });
}

// ── provider remove ────────────────────────────────────────────────────

async function handleProviderRemove(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider remove <name>');
    process.exit(1);
  }

  const presetName = args[0];
  const configDir = resolveConfigDir();

  // Refuse to remove the active preset.
  let config: AppConfig;
  try {
    config = await loadConfig(configDir);
  } catch {
    // Config may not exist; treat as non-active.
    config = undefined as unknown as AppConfig;
  }
  if (config && config.active.preset === presetName) {
    console.error(
      `Preset "${presetName}" is the active preset. Switch first with /provider or edit config.yaml.`,
    );
    process.exit(1);
  }

  const presetPath = path.join(configDir, 'presets', `${presetName}.yaml`);
  try {
    await fs.unlink(presetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`Preset "${presetName}" not found.`);
      process.exit(1);
    }
    throw err;
  }

  process.stdout.write(`Preset "${presetName}" removed.\n`);
}

// ── provider show ──────────────────────────────────────────────────────

async function handleProviderShow(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider show <name>');
    process.exit(1);
  }

  const presetName = args[0];
  const configDir = resolveConfigDir();
  const preset = await loadPreset(configDir, presetName);

  // Print the preset with secrets redacted — the preset itself stores
  // paths and env-var names, never raw values, so it's mostly safe.
  // We still mask any field whose key suggests a secret.
  const redacted = redactPresetForDisplay(preset);
  process.stdout.write(YAML.stringify(redacted));
}

// ── provider login ─────────────────────────────────────────────────────

async function handleProviderLogin(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider login <name>');
    process.exit(1);
  }

  const presetName = args[0];
  const presetConfig = await loadPresetConfig(presetName);
  const provider = requireProvider(presetConfig.provider);

  if (presetConfig.auth.kind === 'none') {
    console.error(`Preset "${presetName}" has no auth configured.`);
    process.exit(1);
  }

  try {
    await provider.login(presetConfig, presetConfig.auth.kind);
    process.stdout.write(`Login successful for preset "${presetName}".\n`);
  } catch (err) {
    console.error(`Login failed: ${(err as Error).message ?? String(err)}`);
    process.exit(1);
  }
}

// ── provider logout ────────────────────────────────────────────────────

async function handleProviderLogout(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider logout <name>');
    process.exit(1);
  }

  const presetName = args[0];
  const presetConfig = await loadPresetConfig(presetName);
  const provider = requireProvider(presetConfig.provider);

  await provider.logout(presetConfig);
  process.stdout.write(`Logout complete for preset "${presetName}". Token file removed if present.\n`);
}

// ── provider refresh ───────────────────────────────────────────────────

async function handleProviderRefresh(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent provider refresh <name>');
    process.exit(1);
  }

  const presetName = args[0];
  const presetConfig = await loadPresetConfig(presetName);
  const provider = requireProvider(presetConfig.provider);

  if (!provider.discoverModels) {
    console.error(`Provider "${presetConfig.provider}" does not support dynamic model discovery.`);
    process.exit(1);
  }

  try {
    const catalog = await provider.discoverModels(presetConfig);
    process.stdout.write(`Models for preset "${presetName}" (fetched at ${new Date(catalog.fetchedAt).toISOString()}):\n`);
    if (catalog.models.length === 0) {
      process.stdout.write('  (none)\n');
    } else {
      for (const m of catalog.models) {
        const flags: string[] = [];
        if (m.supportsTools) flags.push('tools');
        if (m.contextWindow) flags.push(`${(m.contextWindow / 1000).toFixed(0)}k ctx`);
        const suffix = flags.length > 0 ? `  (${flags.join(', ')})` : '';
        process.stdout.write(`  ${m.id}${m.displayName ? ` — ${m.displayName}` : ''}${suffix}\n`);
      }
    }
  } catch (err) {
    console.error(`Model discovery failed: ${(err as Error).message ?? String(err)}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Agent subcommands
// ═══════════════════════════════════════════════════════════════════════

async function handleAgent(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: copilot-agent agent <list|show|create|edit|delete>');
    process.exit(1);
  }

  const op = args[0];
  const rest = args.slice(1);

  switch (op) {
    case 'list':
      await handleAgentList();
      break;
    case 'show':
      await handleAgentShow(rest);
      break;
    case 'create':
      await handleAgentCreate(rest);
      break;
    case 'edit':
      await handleAgentEdit(rest);
      break;
    case 'delete':
      await handleAgentDelete(rest);
      break;
    default:
      console.error(`Unknown agent operation: ${op}`);
      process.exit(1);
  }
}

// ── agent list ─────────────────────────────────────────────────────────

async function handleAgentList(): Promise<void> {
  const registry = await initAgentRegistry();
  const config = await loadConfig(resolveConfigDir());
  const agents = registry.list();

  if (agents.length === 0) {
    process.stdout.write('No agents found.\n');
    return;
  }

  const rows: string[][] = [['NAME', 'DESCRIPTION', 'MODEL', 'TOOLS']];

  for (const a of agents) {
    const isDefault = a.name === config.agents.default ? ' (default)' : '';
    rows.push([
      a.name + isDefault,
      a.description ?? '-',
      a.model ?? '(default)',
      a.tools && a.tools.length > 0 ? a.tools.join(', ') : '(SDK default)',
    ]);
  }

  printTable(rows);
}

// ── agent show ─────────────────────────────────────────────────────────

async function handleAgentShow(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent agent show <name>');
    process.exit(1);
  }

  const registry = await initAgentRegistry();
  const agent = registry.get(args[0]);

  if (!agent) {
    console.error(`Agent "${args[0]}" not found.`);
    process.exit(1);
  }

  if (agent.sourcePath === 'builtin') {
    process.stdout.write(`# ${agent.name} (built-in)\n\n${agent.systemPrompt}\n`);
  } else {
    const content = await fs.readFile(agent.sourcePath, 'utf-8');
    process.stdout.write(content);
  }
}

// ── agent create ───────────────────────────────────────────────────────

const AGENT_TEMPLATE = `---
name: {name}
description: A helpful assistant
model:
tools: []
---

You are a helpful assistant. Answer questions concisely and accurately.
`;

async function handleAgentCreate(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent agent create <name>');
    process.exit(1);
  }

  const agentName = args[0];
  const configDir = resolveConfigDir();
  const config = await loadConfig(configDir);
  const agentsDir = path.resolve(configDir, config.agents.dir);
  await fs.mkdir(agentsDir, { recursive: true });

  const filePath = path.join(agentsDir, `${agentName}.md`);

  try {
    await fs.access(filePath);
    console.error(`Agent "${agentName}" already exists at ${filePath}`);
    process.exit(1);
  } catch {
    // expected
  }

  const content = AGENT_TEMPLATE.replace(/\{name\}/g, agentName);
  await fs.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o644 });

  process.stdout.write(`Agent scaffolded at ${filePath}\n`);
  openEditor(filePath);
}

// ── agent edit ─────────────────────────────────────────────────────────

async function handleAgentEdit(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent agent edit <name>');
    process.exit(1);
  }

  const registry = await initAgentRegistry();
  const agent = registry.get(args[0]);

  if (!agent) {
    console.error(`Agent "${args[0]}" not found.`);
    process.exit(1);
  }

  if (agent.sourcePath === 'builtin') {
    console.error('Cannot edit the built-in assistant agent.');
    process.exit(1);
  }

  openEditor(agent.sourcePath);
}

// ── agent delete ───────────────────────────────────────────────────────

async function handleAgentDelete(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: copilot-agent agent delete <name>');
    process.exit(1);
  }

  const agentName = args[0];
  const config = await loadConfig(resolveConfigDir());

  if (agentName === config.agents.default) {
    console.error(
      `Agent "${agentName}" is the default agent. Change "agents.default" in config.yaml first.`,
    );
    process.exit(1);
  }

  const registry = await initAgentRegistry();
  const agent = registry.get(agentName);

  if (!agent) {
    console.error(`Agent "${agentName}" not found.`);
    process.exit(1);
  }

  if (agent.sourcePath === 'builtin') {
    console.error('Cannot delete the built-in assistant agent.');
    process.exit(1);
  }

  await fs.unlink(agent.sourcePath);
  process.stdout.write(`Agent "${agentName}" deleted (${agent.sourcePath}).\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// Config subcommands
// ═══════════════════════════════════════════════════════════════════════

async function handleConfig(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: copilot-agent config <get|set>');
    process.exit(1);
  }

  const op = args[0];
  const rest = args.slice(1);

  switch (op) {
    case 'get':
      await handleConfigGet(rest);
      break;
    case 'set':
      await handleConfigSet(rest);
      break;
    default:
      console.error(`Unknown config operation: ${op}`);
      process.exit(1);
  }
}

// ── config get ─────────────────────────────────────────────────────────

async function handleConfigGet(args: string[]): Promise<void> {
  const configDir = resolveConfigDir();
  const config = await loadConfig(configDir);

  if (args.length > 0) {
    const key = args[0];
    const value = getNestedValue(config, key);
    if (value === undefined) {
      console.error(`Unknown config key: ${key}`);
      process.exit(1);
    }
    process.stdout.write(`${formatConfigValue(key, value)}\n`);
  } else {
    process.stdout.write(YAML.stringify(config));
  }
}

// ── config set ─────────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = new Set([
  'active.preset',
  'active.model',
  'agents.dir',
  'agents.default',
  'session.max_messages',
  'session.max_idle_seconds',
  'permissions.mode',
  'permissions.timeout_seconds',
]);

async function handleConfigSet(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: copilot-agent config set <key> <value>');
    console.error('\nAllowed keys:');
    for (const k of ALLOWED_CONFIG_KEYS) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  const key = args[0];
  const rawValue = args[1];

  if (!ALLOWED_CONFIG_KEYS.has(key)) {
    console.error(`Cannot set "${key}". Allowed keys:`);
    for (const k of ALLOWED_CONFIG_KEYS) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  const configDir = resolveConfigDir();
  const configPath = path.join(configDir, 'config.yaml');
  const config = await loadConfig(configDir);

  const value = coerceConfigValue(key, rawValue);

  // Validate specific keys.
  if (key === 'active.preset') {
    const presetIds = await listPresets(configDir);
    if (!presetIds.includes(value as string)) {
      console.error(`Preset "${value}" not found. Available: ${presetIds.join(', ') || '(none)'}`);
      process.exit(1);
    }
  }

  if (key === 'permissions.mode') {
    const validModes = ['approve-all', 'readonly-default', 'deny-all'];
    if (!validModes.includes(value as string)) {
      console.error(`Invalid permission mode. Must be one of: ${validModes.join(', ')}`);
      process.exit(1);
    }
  }

  setNestedValue(config as unknown as Record<string, unknown>, key, value);

  // Read the original YAML to preserve structure and comments as much as possible.
  // For v1 simplicity we write the validated config back; this is lossy for comments.
  const yamlContent = YAML.stringify(config);
  await fs.writeFile(configPath, yamlContent, { mode: 0o600, encoding: 'utf-8' });

  process.stdout.write(`Config updated: ${key} = ${rawValue}\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

// ── Agent registry initialisation ──────────────────────────────────────

async function initAgentRegistry(): Promise<AgentRegistry> {
  const configDir = resolveConfigDir();
  const config = await loadConfig(configDir);
  const agentsDir = path.resolve(configDir, config.agents.dir);
  const registry = createAgentRegistry(configDir, agentsDir, config.agents.default);
  await registry.load();
  return registry;
}

// ── Preset loading helpers ─────────────────────────────────────────────

async function loadPresetConfig(presetName: string): Promise<PresetConfig> {
  const configDir = resolveConfigDir();
  const preset = await loadPreset(configDir, presetName);
  const providerId = (preset.provider as string) ?? presetName;
  const models = (preset.models as ModelInfo[] | undefined) ?? [];
  return presetToPresetConfig(preset, providerId, models);
}

function requireProvider(providerId: string): Provider {
  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`Unknown provider: ${providerId}`);
    process.exit(1);
  }
  return provider;
}

// ── PresetConfig → YAML-friendly object ────────────────────────────────

function presetConfigToYaml(config: PresetConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    provider: config.provider,
  };

  if (config.displayName) result.displayName = config.displayName;
  if (config.defaultModel) result.model = config.defaultModel;
  result.auth = config.auth;
  if (config.baseUrl) result.baseUrl = config.baseUrl;
  if (config.apiType) result.apiType = config.apiType;
  if (config.models.length > 0) {
    result.models = config.models.map((m) => ({
      id: m.id,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
    }));
  }

  return result;
}

// ── Secret redaction for display ───────────────────────────────────────

const SECRET_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /^token$/i,
  /^secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^bot[_-]?token$/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key)) || key.includes('Token') || key.includes('Secret');
}

function redactPresetForDisplay(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactPresetForDisplay);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        result[key] = '***REDACTED***';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = redactPresetForDisplay(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return obj;
}

// ── Config value helpers ───────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    current[last] = value;
  }
}

function coerceConfigValue(key: string, raw: string): unknown {
  switch (key) {
    case 'session.max_messages':
    case 'session.max_idle_seconds':
    case 'permissions.timeout_seconds': {
      const n = parseInt(raw, 10);
      if (isNaN(n)) {
        console.error(`"${key}" requires a numeric value.`);
        process.exit(1);
      }
      return n;
    }
    default:
      return raw;
  }
}

function formatConfigValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return YAML.stringify(value);
  return String(value);
}

// ── Editor helper ──────────────────────────────────────────────────────

function openEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  process.stdout.write(`Opening ${editor} ${filePath}…\n`);
  const result = spawnSync(editor, [filePath], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to open editor: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Editor exited with code ${result.status}`);
    process.exit(1);
  }
}
