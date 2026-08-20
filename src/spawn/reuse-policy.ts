/**
 * Default reuse policy (spec §25): reuse only when every dimension that
 * matters lines up, and only when the live agent is currently deliverable.
 * Returning `undefined` forces `SpawnManager` to spawn a fresh instance.
 */

import type { HerdrClient, Logger, ReusePolicy } from "../core/ports.js";
import type { LiveAgent, SpawnRequest } from "../core/model.js";

export interface ReusePolicyDeps {
  herdr: HerdrClient;
  /** Kept separate from `TaskStore` so this policy stays unit-testable. */
  hasActiveTask: (instanceId: string) => Promise<boolean>;
  logger: Logger;
}

export class DefaultReusePolicy implements ReusePolicy {
  constructor(private readonly deps: ReusePolicyDeps) {}

  async pick(req: SpawnRequest, candidates: LiveAgent[]): Promise<LiveAgent | undefined> {
    const eligible: LiveAgent[] = [];
    for (const candidate of candidates) {
      if (await this.isEligible(req, candidate)) eligible.push(candidate);
    }
    if (eligible.length === 0) return undefined;

    // Prefer the most recently created eligible candidate.
    eligible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return eligible[0];
  }

  private async isEligible(req: SpawnRequest, candidate: LiveAgent): Promise<boolean> {
    if (candidate.logicalTarget !== req.descriptor.name) return false;
    if (candidate.cwd !== req.cwd) return false;
    if (candidate.model !== req.model) return false;
    if (candidate.visibility !== req.visibility) return false;

    const agent = await this.deps.herdr.agentGet(candidate.paneId).catch(() => undefined);
    if (!agent) return false; // no longer live in Herdr at all

    // Identity discipline (spec §40): a pane can be recycled to a different
    // occupant. Prefer the durable session ref; fall back to terminal id.
    // Never reuse on a mismatch — that would hand a fresh task to a
    // stranger's terminal.
    if (candidate.sessionRef !== undefined && agent.agent_session?.value !== undefined) {
      if (agent.agent_session.value !== candidate.sessionRef) return false;
    } else if (candidate.terminalId !== undefined) {
      if (agent.terminal_id !== candidate.terminalId) return false;
    }

    if (!agent.interactive_ready) return false;
    if (agent.launch_pending) return false;
    if (agent.agent_status === "working" || agent.agent_status === "blocked") return false;

    if (await this.deps.hasActiveTask(candidate.instanceId)) return false;

    return true;
  }
}
