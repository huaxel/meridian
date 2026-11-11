import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { attachChildIo } from "../services/executor/src/child-io.js";

it("preserves UTF-8 characters split across stdout chunks", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 20)',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const io = attachChildIo(child, { maxOut: 10_000, onOverflow: () => {} });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        expect(code).toBe(0);
        expect(io.out()).toBe("€");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

it("handles stdin when the child exits before reading it", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachChildIo(child, { maxOut: 10_000, onOverflow: () => {} });

  child.stdin.write("x".repeat(1_000_000));
  child.stdin.end();

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        expect(code).toBe(0);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

it("calls onOverflow exactly once when stdout exceeds the limit", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100))'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let overflowCount = 0;
  const io = attachChildIo(child, {
    maxOut: 10,
    onOverflow: () => {
      overflowCount += 1;
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        expect(code).toBe(0);
        expect(io.out()).toHaveLength(100);
        expect(overflowCount).toBe(1);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});
