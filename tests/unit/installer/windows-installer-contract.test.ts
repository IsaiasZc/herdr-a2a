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
    expect(source).toContain("if ($LASTEXITCODE -ne 0)");
    expect(source).toContain("exit 0");
  });

  it("preserves resources that belong to another checkout or installation", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain("owned by something else — left untouched");
    expect(source).toContain("plugin_root");
    expect(source).toContain("Test-SamePath");
    expect(source).toContain("unlink it explicitly if you want to replace it");
    expect(source).toContain("plugin with this ID belongs to another checkout — left untouched");
  });

  it("uses reproducible dependency installation", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain('$Npm "ci" "--silent"');
    expect(source).not.toContain('$Npm "install" "--silent"');
  });

  it("exercises the installer and all static checks on a Windows PR runner", () => {
    const workflow = readFileSync(releaseWorkflow, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("HERDR_BIN_PATH");
    expect(workflow).toContain("Verify foreign skill links are preserved");
    expect(workflow).toContain("scripts/install.ps1 uninstall");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("github.event_name == 'push'");
  });

  it("declares the supported Herdr floor and Windows named-pipe transport", () => {
    expect(readFileSync(pluginManifest, "utf8")).toContain('min_herdr_version = "0.8.2"');
    expect(readFileSync(pluginManifest, "utf8")).toContain('platforms = ["linux", "macos", "windows"]');
    expect(readFileSync(readme, "utf8")).toMatch(/Herdr 0\.8\.2 or later/);
    expect(readFileSync(readme, "utf8")).toMatch(/named pipe/i);
  });
});
