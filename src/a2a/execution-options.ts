import { z } from "zod";

import { ERROR_CODES, fail } from "../core/errors.js";
import type { Visibility } from "../core/model.js";

/**
 * A2A defines no universal internal-model selector, so model and visibility
 * travel in a deliberately tiny extension (spec §19).
 *
 * What must NEVER appear here: pane ids, split directions, retry counts, CLI
 * paths. Those are runtime details the caller has no business expressing
 * (spec §4, §19).
 */
export const EXECUTION_OPTIONS_URI = "urn:herdr:execution-options:v1";

const schema = z
  .object({
    model: z.string().min(1).optional(),
    visibility: z.enum(["visible", "headless"]).optional(),
  })
  .strict();

export interface ExecutionOptions {
  model?: string;
  visibility?: Visibility;
}

/**
 * Reads the extension out of message metadata. Accepts the options either
 * nested under the extension URI or, for convenience, as flat sibling keys —
 * clients in the wild do both, and rejecting one of them buys nothing.
 */
export function parseExecutionOptions(metadata: Record<string, unknown> | undefined): ExecutionOptions {
  if (!metadata) return {};

  const nested = metadata[EXECUTION_OPTIONS_URI];
  const raw = nested !== undefined ? nested : pickFlat(metadata);
  if (raw === undefined) return {};

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw fail(
      ERROR_CODES.INVALID_EXECUTION_OPTION,
      `invalid ${EXECUTION_OPTIONS_URI} payload`,
      { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    );
  }
  return parsed.data;
}

function pickFlat(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const flat: Record<string, unknown> = {};
  if ("model" in metadata) flat["model"] = metadata["model"];
  if ("visibility" in metadata) flat["visibility"] = metadata["visibility"];
  return Object.keys(flat).length > 0 ? flat : undefined;
}
