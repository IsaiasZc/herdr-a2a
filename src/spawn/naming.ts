/**
 * Herdr live-agent naming (spec §24). Names must be unique among live agents
 * and match Herdr's own constraint (docs/herdr-contract.md §7):
 *
 *     [a-z][a-z0-9_-]{0,31}
 *
 * i.e. lowercase, starts with a letter, at most 32 characters total.
 */

const MAX_LEN = 32;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const PREFIX = "a2a-";

function sanitizeSegment(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/**
 * Builds `a2a-<kind>-<shortid>`, truncating the *kind* (never the short id,
 * which is what actually disambiguates two live instances of the same kind)
 * so the whole name stays within Herdr's 32-character limit. The literal
 * `a2a-` prefix also guarantees the required `[a-z]` first character
 * regardless of what sanitizing `kind` produces.
 */
export function liveAgentName(kind: string, shortId: string): string {
  const shortClean = sanitizeSegment(shortId);
  // "a2a-" + kind + "-" + shortId
  const reservedLen = PREFIX.length + 1 + shortClean.length;
  const kindBudget = Math.max(1, MAX_LEN - reservedLen);
  const kindClean = sanitizeSegment(kind).slice(0, kindBudget);

  return `${PREFIX}${kindClean}-${shortClean}`.slice(0, MAX_LEN);
}

export function isValidHerdrAgentName(name: string): boolean {
  return NAME_PATTERN.test(name);
}
