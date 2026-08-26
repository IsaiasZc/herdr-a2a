import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installer = path.join(repo, "scripts", "install.ps1");
const releaseWorkflow = path.join(repo, ".github", "workflows", "release.yml");
const pluginManifest = path.join(repo, "herdr-plugin.toml");
const readme = path.join(repo, "README.md");

describe("Windows installer", () => {
  it("provides install, status, and uninstall without requiring an elevated shell", () => {
    expect(existsSync(installer)).toBe(true);

    const source = readFileSync(installer, "utf8");
    expect(source).toContain('ValidateSet("install", "status", "uninstall")');
    expect(source).toContain('"npm.cmd"');
    expect(source).toContain('"herdr-a2a.cmd"');
    expect(source).toContain("New-Item -ItemType Junction");
    expect(source).toContain("[Environment]::SetEnvironmentVariable");
    expect(source).not.toContain("$Label:");
  });

  it("exercises the installer on a Windows release runner", () => {
    const workflow = readFileSync(releaseWorkflow, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("scripts/install.ps1");
    expect(workflow).toContain("scripts/install.ps1 uninstall");
    expect(workflow).toContain("github.event_name == 'push'");
  });

  it("declares Windows plugin support and documents the named-pipe transport", () => {
    expect(readFileSync(pluginManifest, "utf8")).toContain('platforms = ["linux", "macos", "windows"]');
    expect(readFileSync(readme, "utf8")).toMatch(/named pipe/i);
  });
});
