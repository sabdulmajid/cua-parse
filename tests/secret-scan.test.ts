import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRepository, scanText } from "../scripts/secret-scan.js";

const temporary: string[] = [];
const token = () => ["sk", "proj", "Ab3".repeat(12)].join("-");
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "cua-secret-scan-test-"));
  temporary.push(dir);
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("secret detection and redacted diagnostics", () => {
  it("detects private key blocks and common token formats without returning matching values", () => {
    const examples = [
      ["private-key", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")],
      ["openai-or-anthropic-key", token()],
      ["github-token", "gh" + "p_" + "aB3".repeat(12)],
      ["gitlab-token", "gl" + "pat-" + "aB3".repeat(12)],
      ["slack-token", "xox" + "b-" + "123-abc-".repeat(8)],
      ["google-api-key", "AI" + "za" + "a".repeat(35)],
      ["aws-access-key", "AK" + "IA" + "A".repeat(16)],
      ["npm-token", "np" + "m_" + "a".repeat(36)],
    ];
    for (const [rule, value] of examples) {
      const result = scanText(`Header\n${value}\n`, "test.txt");
      expect(
        result.some((finding) => finding.rule === rule && finding.line === 2),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });
  it("checks encoded Elastic keys only in credential contexts", () => {
    const encoded = Buffer.from(
      `${"id".repeat(11)}:${"Key9".repeat(8)}`,
    ).toString("base64");
    expect(
      scanText(`ELASTIC_CLOUD_API_KEY=${encoded}`, "settings.conf").some(
        (finding) => finding.rule === "encoded-api-key",
      ),
    ).toBe(true);
    expect(
      scanText(`{ "apiKey": "${encoded}" }`, "config.json").some(
        (finding) => finding.rule === "encoded-api-key",
      ),
    ).toBe(true);
    expect(
      scanText(`Authorization: ApiKey ${encoded}`, "request.txt").some(
        (finding) => finding.rule === "authorization-token",
      ),
    ).toBe(true);
    expect(scanText(`integrity: "${encoded}"`, "package-lock.json")).toEqual(
      [],
    );
    expect(
      scanText(`ELASTIC_CLOUD_API_KEY=your-api-key`, ".env.example"),
    ).toEqual([]);
  });
  it("detects opaque assigned credentials and a browser-exposed setting", () => {
    const opaque = "a1B2c3D4".repeat(6);
    const result = scanText(
      `apiKey: "${opaque}"\nVITE_API_KEY="${opaque}"`,
      "config.ts",
    );
    expect(
      result.some((finding) => finding.rule === "credential-assignment"),
    ).toBe(true);
    expect(
      result.some((finding) => finding.rule === "public-client-secret-setting"),
    ).toBe(true);
    expect(
      scanText("apiKey: config.ELASTICSEARCH_API_KEY", "config.ts"),
    ).toEqual([]);
  });
  it("does not consume the next line after an empty dotenv assignment", () => {
    expect(
      scanText(
        "API_KEY=\nNEXT_SETTING=SomeNonSecretSetting123456789\n",
        ".env.example",
      ),
    ).toEqual([]);
  });
  it("redacts configured values and known token patterns even from diagnostic paths", () => {
    const value = "configured-private-value-123";
    const result = scanText(value, `src/${value}/${token()}.txt`, [value]);
    expect(result[0].location).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain(token());
  });
});

describe("Git candidates, index and reachable history", () => {
  it("checks untracked binary extensions and the index even after a working-file cleanup", () => {
    const cwd = repo();
    writeFileSync(path.join(cwd, "credential.dat"), `binary\0${token()}`);
    git(cwd, ["add", "credential.dat"]);
    writeFileSync(path.join(cwd, "credential.dat"), "Now clean.\n");
    const result = scanRepository({ cwd });
    expect(
      result.findings.some((finding) =>
        finding.location.includes("index:credential.dat"),
      ),
    ).toBe(true);
    expect(
      result.findings.some((finding) =>
        finding.location.includes("worktree:credential.dat"),
      ),
    ).toBe(false);
    writeFileSync(path.join(cwd, "untracked.anything"), token());
    expect(
      scanRepository({ cwd }).findings.some((finding) =>
        finding.location.includes("worktree:untracked.anything"),
      ),
    ).toBe(true);
    expect(
      scanRepository({ cwd, stagedOnly: true }).findings.some((finding) =>
        finding.location.includes("untracked.anything"),
      ),
    ).toBe(false);
  });
  it("honors ignored dependencies but still scans a force-staged runtime artifact", () => {
    const cwd = repo();
    writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n.local/\n");
    mkdirSync(path.join(cwd, "node_modules"));
    writeFileSync(path.join(cwd, "node_modules", "ignored.js"), token());
    mkdirSync(path.join(cwd, ".local"));
    writeFileSync(
      path.join(cwd, ".local", "session.db"),
      "private session data",
    );
    expect(scanRepository({ cwd }).findings).toEqual([]);
    git(cwd, ["add", "-f", ".local/session.db"]);
    expect(
      scanRepository({ cwd }).findings.some(
        (finding) => finding.rule === "local-runtime-artifact",
      ),
    ).toBe(true);
  });
  it("checks an old blob reachable only by a tag without creating a commit", () => {
    const cwd = repo();
    const oid = git(cwd, ["hash-object", "-w", "--stdin"], token()).trim();
    git(cwd, ["update-ref", "refs/tags/scanner-test-blob", oid]);
    expect(scanRepository({ cwd }).findings).toEqual([]);
    const result = scanRepository({ cwd, history: true });
    expect(result.historyBlobs).toBe(1);
    expect(
      result.findings.some((finding) =>
        finding.location.includes(`history:${oid.slice(0, 12)}`),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token());
  });
  it("privately compares configured values from an external dotenv file", () => {
    const cwd = repo();
    const privateDir = mkdtempSync(
      path.join(tmpdir(), "cua-private-scan-test-"),
    );
    temporary.push(privateDir);
    const secretsFile = path.join(privateDir, ".env");
    const value = "private-configured-value-9876";
    writeFileSync(
      secretsFile,
      `CUSTOM_SECRET=${value}\nPUBLIC_LABEL=visible\n`,
    );
    writeFileSync(path.join(cwd, "notes.txt"), `Accidentally copied: ${value}`);
    const result = scanRepository({ cwd, secretsFile });
    expect(
      result.findings.some(
        (finding) => finding.rule === "configured-secret-value",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(value);
  });
});
