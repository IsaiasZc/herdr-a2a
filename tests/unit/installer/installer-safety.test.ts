import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const unixInstaller = readFileSync(path.join(repo, "scripts", "install.mjs"), "utf8");
const windowsInstaller = readFileSync(path.join(repo, "scripts", "install.ps1"), "utf8");

describe("installer safety invariants", () => {
  it("never silently replaces foreign agent-skill links", () => {
    expect(unixInstaller).toContain("symlink owned by something else — left untouched");
    expect(windowsInstaller).toContain("link owned by something else — left untouched");
    expect(unixInstaller).not.toContain("A symlink pointing somewhere else is ours to replace");
  });

  it("identifies plugin ownership by plugin_root before unlinking", () => {
    expect(unixInstaller).toContain("plugin_root");
    expect(unixInstaller).toContain("pluginIsOurs");
    expect(windowsInstaller).toContain("plugin_root");
    expect(windowsInstaller).toContain("Test-SamePath");
  });

  it("uses npm ci so a source install follows the committed lockfile", () => {
    expect(unixInstaller).toContain('["ci", "--silent"]');
    expect(windowsInstaller).toContain('$Npm "ci" "--silent"');
  });
});
