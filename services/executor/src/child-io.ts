import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function attachChildIo(
  child: ChildProcessWithoutNullStreams,
  opts: { maxOut: number; onOverflow: () => void },
): { out(): string; err(): string } {
  let out = "";
  let err = "";
  let overflowed = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    if (!overflowed && out.length > opts.maxOut) {
      overflowed = true;
      opts.onOverflow();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  // A child that exits before reading stdin can emit EPIPE; close reports failure.
  child.stdin.on("error", () => {});

  return { out: () => out, err: () => err };
}
