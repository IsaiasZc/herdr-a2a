import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { ERROR_CODES, fail } from "../core/errors.js";
import type { HerdrClient, HerdrDiscovery } from "../core/ports.js";
import type { AgentManifestStatus } from "../herdr/types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

const execFile = promisify(execFileCallback);

/** Executes argv directly. No shell is involved, so CLI text cannot alter command syntax. */
export async function runHerdrCommand(argv: readonly string[]): Promise<CommandResult> {
  const [file, ...args] = argv;
  if (!file) throw fail(ERROR_CODES.HERDR_API_ERROR, "missing Herdr binary path");
  try {
    const result = await execFile(file, args, { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, code: typeof err.code === "number" ? err.code : 1 };
  }
}

/** Parse only Herdr's explicit `kinds:` declaration; no fallback list is permitted. */
export function parseAgentUsage(raw: string): string[] {
  const line = raw.split(/\r?\n/).find((entry) => /^\s*kinds:\s*/.test(entry));
  if (!line) return [];
  return [...new Set(line.replace(/^\s*kinds:\s*/, "").split("|").map((kind) => kind.trim()).filter(Boolean))];
}

/** Integration availability is intentionally not interpreted as startability. */
export function parseIntegrationUsage(raw: string): string[] {
  return [...new Set([...raw.matchAll(/^\s*herdr integration install ([^\s]+)\s*$/gm)].map((match) => match[1]).filter((kind): kind is string => Boolean(kind)))];
}

export interface HerdrDiscoveryOptions {
  binPath: string;
  client: Pick<HerdrClient, "agentManifests">;
  runCommand?: CommandRunner;
}

export class HerdrDiscoveryImpl implements HerdrDiscovery {
  private readonly runCommand: CommandRunner;

  constructor(private readonly opts: HerdrDiscoveryOptions) {
    this.runCommand = opts.runCommand ?? runHerdrCommand;
  }

  async supportedKinds(): Promise<string[]> {
    const result = await this.runCommand([this.opts.binPath, "agent"]);
    // Herdr prints a command group's usage to STDERR and exits 2 (a CLI syntax
    // error, since the group was invoked with no subcommand). Verified against
    // the installed 0.8.0 binary — so the exit code carries no signal here and
    // both streams have to be searched.
    const kinds = parseAgentUsage(`${result.stdout}\n${result.stderr}`);
    if (kinds.length === 0) {
      throw fail(ERROR_CODES.HERDR_API_ERROR, "Herdr agent usage did not provide supported kinds", {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return kinds;
  }

  async manifests(): Promise<AgentManifestStatus> {
    return this.opts.client.agentManifests();
  }

  /**
   * Unlike `supportedKinds`, an empty result here is not an error. Integrations
   * only *enrich* a descriptor (the `hasIntegration` flag) and never gate
   * availability, so a machine with none installed degrades gracefully rather
   * than failing the whole catalog refresh.
   */
  async integrationKinds(): Promise<string[]> {
    const result = await this.runCommand([this.opts.binPath, "integration"]);
    // Same stderr/exit-2 behaviour as `herdr agent`.
    return parseIntegrationUsage(`${result.stdout}\n${result.stderr}`);
  }
}
