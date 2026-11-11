import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const restoreScript = join(process.cwd(), "scripts", "restore.sh");

async function setupBackup(config = "valid") {
  const root = await mkdtemp(join(tmpdir(), "restore-script-"));
  const repo = join(root, "repo");
  const scripts = join(repo, "scripts");
  const backup = join(root, "backup");
  const shim = join(root, "bin");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(backup, { recursive: true }),
    mkdir(shim, { recursive: true }),
  ]);
  await writeFile(join(scripts, "restore.sh"), await readFile(restoreScript));
  const keys = config === "valid" ? "a".repeat(64) : "short";
  await writeFile(join(backup, "helix-data.tgz"), "");
  await writeFile(join(backup, "foundry-data.tgz"), "");
  await writeFile(
    join(backup, "config.env"),
    `ENCRYPTION_KEY=${keys}\nINTERNAL_KEY=${keys}\n`,
  );
  const log = join(root, "docker.log");
  await writeFile(
    join(shim, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" tzf "*)
    if [ "\${FAKE_TAR_TEST_FAIL:-0}" = 1 ]; then exit 1; fi
    ;;
esac
exit 0
`,
  );
  await chmod(join(shim, "docker"), 0o755);
  return { root, repo, backup, shim, log };
}

function runRestore(
  fixture: Awaited<ReturnType<typeof setupBackup>>,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", [join(fixture.repo, "scripts", "restore.sh"), fixture.backup, "--replace"], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.shim}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: fixture.log,
      ...extraEnv,
    },
  });
}

async function logLines(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
}

it("rejects unreadable archives before stopping services or changing files", async () => {
  const fixture = await setupBackup();
  const result = runRestore(fixture, { FAKE_TAR_TEST_FAIL: "1" });
  const lines = await logLines(fixture.log);

  expect(result.status).not.toBe(0);
  expect(lines.some((line) => line.includes("compose stop"))).toBe(false);
  expect(lines.some((line) => line.includes("rm -rf"))).toBe(false);
  await expect(readFile(join(fixture.repo, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects config files with short encryption keys before stopping services", async () => {
  const fixture = await setupBackup("invalid");
  const result = runRestore(fixture);
  const lines = await logLines(fixture.log);

  expect(result.status).not.toBe(0);
  expect(lines.some((line) => line.includes("compose stop"))).toBe(false);
});

it("validates archives before stopping services and writes a private env file", async () => {
  const fixture = await setupBackup();
  const result = runRestore(fixture);
  const lines = await logLines(fixture.log);
  const stopIndex = lines.findIndex((line) => line.includes("compose stop"));
  const archiveIndexes = lines
    .map((line, index) => (line.includes(" tzf ") ? index : -1))
    .filter((index) => index >= 0);

  expect(result.status).toBe(0);
  expect(archiveIndexes).toHaveLength(2);
  expect(Math.max(...archiveIndexes)).toBeLessThan(stopIndex);
  const env = await readFile(join(fixture.repo, ".env"));
  expect(env.toString()).toContain("ENCRYPTION_KEY=");
  expect((await stat(join(fixture.repo, ".env"))).mode).toBe(0o100600);
});
