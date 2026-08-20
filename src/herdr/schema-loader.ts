import { ERROR_CODES, fail } from "../core/errors.js";
import { runHerdrCommand, type CommandRunner } from "../catalog/herdr-discovery.js";

export interface SchemaInfo {
  protocol: number;
  schemaVersion: number;
  methods: string[];
  has(method: string): boolean;
  assertMethods(required: string[]): void;
}

export interface LoadSchemaOptions {
  binPath: string;
  /** Test seam; production uses execFile through runHerdrCommand. */
  runCommand?: CommandRunner;
}

const cache = new Map<string, Promise<SchemaInfo>>();

export function loadSchema(opts: LoadSchemaOptions): Promise<SchemaInfo> {
  const existing = cache.get(opts.binPath);
  if (existing) return existing;
  const created = load(opts);
  cache.set(opts.binPath, created);
  void created.catch(() => {
    if (cache.get(opts.binPath) === created) cache.delete(opts.binPath);
  });
  return created;
}

async function load(opts: LoadSchemaOptions): Promise<SchemaInfo> {
  const runner = opts.runCommand ?? runHerdrCommand;
  const result = await runner([opts.binPath, "api", "schema", "--json"]);
  if (result.code !== 0) {
    throw fail(ERROR_CODES.HERDR_API_ERROR, "Herdr schema command failed", { code: result.code, stdout: result.stdout, stderr: result.stderr });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw fail(ERROR_CODES.HERDR_API_ERROR, "Herdr schema command returned invalid JSON", { stdout: result.stdout, stderr: result.stderr });
  }
  if (!isRecord(parsed) || typeof parsed.protocol !== "number" || typeof parsed.schema_version !== "number") {
    throw fail(ERROR_CODES.HERDR_API_ERROR, "Herdr schema is missing protocol metadata");
  }
  const methods = [...walkMethods(parsed)].sort();
  return {
    protocol: parsed.protocol,
    schemaVersion: parsed.schema_version,
    methods,
    has: (method) => methods.includes(method),
    assertMethods: (required) => {
      const missing = required.filter((method) => !methods.includes(method));
      if (missing.length > 0) {
        throw fail(ERROR_CODES.HERDR_PROTOCOL_UNSUPPORTED, `Herdr schema is missing required methods: ${missing.join(", ")}`, { missing });
      }
    },
  };
}

function* walkMethods(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkMethods(item);
    return;
  }
  if (!isRecord(value)) return;
  const properties = value.properties;
  if (isRecord(properties) && isRecord(properties.method) && typeof properties.method.const === "string") {
    yield properties.method.const;
  }
  for (const child of Object.values(value)) yield* walkMethods(child);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
