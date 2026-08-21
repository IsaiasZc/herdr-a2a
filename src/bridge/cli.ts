#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import type { ExecutionOptions } from "../a2a/execution-options.js";
import {
  AgentUnreachableError,
  BridgeClient,
  GatewayHttpError,
  GatewayUnreachableError,
  TaskNotFoundError,
  defaultAgentClientFactory,
  type AgentClientFactory,
} from "./client.js";
import { DEFAULT_GATEWAY_URL, resolveGatewayUrl } from "../gateway-discovery.js";
import {
  exitCodeForTask,
  isDoctorOk,
  isTask,
  renderDiscoverText,
  renderDoctorText,
  renderJson,
  renderMessageText,
  renderTaskText,
} from "./format.js";

/**
 * Hand-rolled arg parsing (spec §8.1 forbids a new dependency here). The
 * entire surface is five delegation verbs plus the `doctor` diagnostic —
 * spec §56 forbids growing this into "a giant CLI agents must memorize".
 */

export const HELP_TEXT = `herdr-a2a — thin A2A client for delegating to agents running under Herdr

Usage:
  herdr-a2a discover [--json]
  herdr-a2a delegate <agent> <message> [--model M] [--headless] [--wait] [--json]
  herdr-a2a get <task-id> [--json]
  herdr-a2a continue <task-id> <message> [--wait] [--json]
  herdr-a2a cancel <task-id> [--json]
  herdr-a2a close <task-id> [--json]
  herdr-a2a doctor [--json]   (operator diagnostic — not part of the delegation surface)

Flags:
  --base-url <url>   gateway base URL (default: $HERDR_A2A_URL, then this session's discovery file, else http://127.0.0.1:4319)
  --model <name>     request a specific model for a new delegation
  --headless         run the delegated task without a visible terminal
  --wait             block until the task settles or needs input, streaming updates
  --json             print the raw structured result and nothing else

Use "--" to pass a message that starts with a dash:
  herdr-a2a delegate codex -- "-x is text, not a flag"

Exit codes: 0 success, 1 the task/operation reported a failure, 2 usage or connectivity error.`;

const VERBS = new Set(["discover", "delegate", "get", "continue", "cancel", "close", "doctor"]);
const BASE_URL_FLAG = new Set(["base-url"]);

interface CommandBase {
  json: boolean;
  baseUrl?: string;
}

export interface DiscoverCommand extends CommandBase {
  verb: "discover";
}
export interface DoctorCommand extends CommandBase {
  verb: "doctor";
}
export interface DelegateCommand extends CommandBase {
  verb: "delegate";
  agent: string;
  message: string;
  wait: boolean;
  model?: string;
  visibility?: "headless";
}
export interface GetCommand extends CommandBase {
  verb: "get";
  taskId: string;
}
export interface ContinueCommand extends CommandBase {
  verb: "continue";
  taskId: string;
  message: string;
  wait: boolean;
}
export interface CancelCommand extends CommandBase {
  verb: "cancel";
  taskId: string;
}
export interface CloseCommand extends CommandBase {
  verb: "close";
  taskId: string;
}

export type Command =
  | DiscoverCommand
  | DoctorCommand
  | DelegateCommand
  | GetCommand
  | ContinueCommand
  | CancelCommand
  | CloseCommand;

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

interface Tokens {
  flags: Record<string, string | boolean>;
  positionals: string[];
  error?: string;
}

/** A single linear scan: flags may appear in any order, anywhere; a bare
 * "--" ends flag parsing so a message that itself starts with a dash can be
 * passed through literally. */
function tokenize(args: string[], valuedFlags: ReadonlySet<string>, booleanFlags: ReadonlySet<string>): Tokens {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let literal = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;

    if (!literal && arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = true;
        continue;
      }
      if (valuedFlags.has(name)) {
        const value = args[i + 1];
        if (value === undefined) return { flags, positionals, error: `--${name} requires a value` };
        flags[name] = value;
        i++;
        continue;
      }
      return { flags, positionals, error: `unknown flag --${name}` };
    }
    positionals.push(arg);
  }

  return { flags, positionals };
}

function usageError(message: string): ParseResult {
  return { ok: false, message: `${message}\n\n${HELP_TEXT}` };
}

function baseUrlOf(flags: Record<string, string | boolean>): { baseUrl?: string } {
  const value = flags["base-url"];
  return typeof value === "string" ? { baseUrl: value } : {};
}

export function parseArgs(argv: string[]): ParseResult {
  const verb = argv[0];
  if (verb === undefined || !VERBS.has(verb)) {
    return { ok: false, message: HELP_TEXT };
  }
  const rest = argv.slice(1);

  if (verb === "discover" || verb === "doctor") {
    const t = tokenize(rest, BASE_URL_FLAG, new Set(["json"]));
    if (t.error !== undefined) return usageError(t.error);
    if (t.positionals.length > 0) return usageError(`${verb} takes no positional arguments`);
    return { ok: true, command: { verb, json: t.flags["json"] === true, ...baseUrlOf(t.flags) } };
  }

  if (verb === "delegate") {
    const t = tokenize(rest, new Set(["base-url", "model"]), new Set(["json", "wait", "headless"]));
    if (t.error !== undefined) return usageError(t.error);
    const agent = t.positionals[0];
    const messageWords = t.positionals.slice(1);
    if (agent === undefined || messageWords.length === 0) {
      return usageError("usage: herdr-a2a delegate <agent> <message> [--model M] [--headless] [--wait] [--json]");
    }
    const model = t.flags["model"];
    return {
      ok: true,
      command: {
        verb: "delegate",
        agent,
        message: messageWords.join(" "),
        wait: t.flags["wait"] === true,
        json: t.flags["json"] === true,
        ...(typeof model === "string" ? { model } : {}),
        ...(t.flags["headless"] === true ? { visibility: "headless" as const } : {}),
        ...baseUrlOf(t.flags),
      },
    };
  }

  if (verb === "get" || verb === "cancel" || verb === "close") {
    const t = tokenize(rest, BASE_URL_FLAG, new Set(["json"]));
    if (t.error !== undefined) return usageError(t.error);
    const taskId = t.positionals[0];
    if (taskId === undefined || t.positionals.length > 1) {
      return usageError(`usage: herdr-a2a ${verb} <task-id> [--json]`);
    }
    return { ok: true, command: { verb, taskId, json: t.flags["json"] === true, ...baseUrlOf(t.flags) } };
  }

  // verb === "continue"
  const t = tokenize(rest, BASE_URL_FLAG, new Set(["json", "wait"]));
  if (t.error !== undefined) return usageError(t.error);
  const taskId = t.positionals[0];
  const messageWords = t.positionals.slice(1);
  if (taskId === undefined || messageWords.length === 0) {
    return usageError("usage: herdr-a2a continue <task-id> <message> [--wait] [--json]");
  }
  return {
    ok: true,
    command: {
      verb: "continue",
      taskId,
      message: messageWords.join(" "),
      wait: t.flags["wait"] === true,
      json: t.flags["json"] === true,
      ...baseUrlOf(t.flags),
    },
  };
}

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  agentClientFactory: AgentClientFactory;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function defaultDeps(): RunDeps {
  return {
    env: process.env,
    fetchImpl: fetch,
    agentClientFactory: defaultAgentClientFactory,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

function unreachableMessage(baseUrl: string): string {
  return (
    `Cannot reach the herdr-a2a gateway at ${baseUrl}. ` +
    "herdr-a2a is only a client — start the gateway with `node dist/main.js`, " +
    "or pass --base-url / set HERDR_A2A_URL if it's running elsewhere."
  );
}

function noGatewayForSessionMessage(): string {
  return "no gateway found for this Herdr session; check `herdr plugin list` and install it with `herdr plugin link <path-to-herdr-a2a>`";
}

function agentUnreachableMessage(err: AgentUnreachableError): string {
  return (
    `Cannot reach agent endpoint ${err.agentUrl}. ` +
    "Either the herdr-a2a gateway is not running (start it with `node dist/main.js`), " +
    "or that agent name does not exist — check `herdr-a2a discover`."
  );
}

function errorLine(err: unknown): string {
  if (err instanceof GatewayHttpError) {
    const body = err.body as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = body?.error?.code;
    const message = body?.error?.message;
    if (typeof code === "string" && typeof message === "string") return `${code}: ${message}`;
    return `gateway returned HTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function printResult(deps: RunDeps, json: boolean, result: Awaited<ReturnType<BridgeClient["delegate"]>>): number {
  if (json) {
    deps.stdout(renderJson(result));
    return isTask(result) ? exitCodeForTask(result) : 0;
  }
  if (isTask(result)) {
    deps.stdout(renderTaskText(result));
    return exitCodeForTask(result);
  }
  deps.stdout(renderMessageText(result));
  return 0;
}

export async function run(argv: string[], depsInput: Partial<RunDeps> = {}): Promise<number> {
  const deps: RunDeps = { ...defaultDeps(), ...depsInput };

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr(parsed.message);
    return 2;
  }
  const command = parsed.command;
  const baseUrl = await resolveGatewayUrl({ flag: command.baseUrl, env: deps.env, fetchImpl: deps.fetchImpl });
  const usedLegacyFallback =
    baseUrl === DEFAULT_GATEWAY_URL &&
    command.baseUrl === undefined &&
    !(deps.env["HERDR_A2A_URL"] && deps.env["HERDR_A2A_URL"].length > 0);
  const client = new BridgeClient({
    baseUrl,
    fetchImpl: deps.fetchImpl,
    agentClientFactory: deps.agentClientFactory,
    env: deps.env,
  });

  // No separate reachability preflight: `get` now needs only one network
  // call (`GET /tasks/:id`), and every call path below already turns a
  // failed fetch into `GatewayUnreachableError` / `AgentUnreachableError`
  // itself, so a second, dedicated /healthz round trip would just be extra
  // latency on the cheapest command for no better diagnosis.
  try {
    switch (command.verb) {
      case "discover": {
        const data = await client.discover();
        deps.stdout(command.json ? renderJson(data) : renderDiscoverText(data));
        return 0;
      }
      case "doctor": {
        const data = await client.doctor();
        deps.stdout(command.json ? renderJson(data) : renderDoctorText(data));
        return isDoctorOk(data) ? 0 : 1;
      }
      case "delegate": {
        const options: ExecutionOptions = {
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.visibility !== undefined ? { visibility: command.visibility } : {}),
        };
        const result = await client.delegate(command.agent, command.message, options, command.wait);
        return printResult(deps, command.json, result);
      }
      case "get": {
        const task = await client.getTask(command.taskId);
        return printResult(deps, command.json, task);
      }
      case "continue": {
        const result = await client.continueTask(command.taskId, command.message, {}, command.wait);
        return printResult(deps, command.json, result);
      }
      case "cancel": {
        const task = await client.cancelTask(command.taskId);
        return printResult(deps, command.json, task);
      }
      case "close": {
        const task = await client.closeTask(command.taskId);
        return printResult(deps, command.json, task);
      }
    }
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      deps.stderr(`unknown task ${err.taskId}`);
      return 2;
    }
    if (err instanceof GatewayUnreachableError) {
      deps.stderr(usedLegacyFallback ? noGatewayForSessionMessage() : unreachableMessage(baseUrl));
      return 2;
    }
    if (err instanceof AgentUnreachableError) {
      deps.stderr(agentUnreachableMessage(err));
      return 2;
    }
    deps.stderr(errorLine(err));
    return 2;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
