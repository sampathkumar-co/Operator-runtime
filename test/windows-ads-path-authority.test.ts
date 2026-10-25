import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemProvider } from "../src/capabilities/filesystem.ts";
import { hasWindowsAlternateDataStreamSyntax } from "../src/core/scoped-path-syntax.ts";

test("Windows ADS detector distinguishes drive roots from alternate streams", () => {
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("C:\\authorized\\file.txt"),
    false,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("C:\\authorized\\file.txt:private"),
    true,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("C:\\authorized\\file.txt::$DATA"),
    true,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("\\\\server\\share\\file.txt:private"),
    true,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("relative\\file.txt:private"),
    true,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax("\\\\?\\C:\\authorized\\file.txt"),
    false,
  );
  assert.equal(
    hasWindowsAlternateDataStreamSyntax(
      "\\\\?\\C:\\authorized\\file.txt:private",
    ),
    true,
  );
});

test("Windows filesystem authority rejects ADS reads before opening stream bytes", async (t) => {
  if (process.platform !== "win32")
    return t.skip("NTFS ADS authority boundary is Windows-only.");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "mecord-ads-authority-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "public.txt");
  await fs.writeFile(target, "public");
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: crypto.randomUUID(),
    capability: "file.read",
    risk: "read",
    input: { path: `${target}:private` },
    provenance: { kind: "runtime" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "WINDOWS_ALTERNATE_DATA_STREAM_DENIED");
  assert.equal(result.output, undefined);
  assert.equal(await fs.readFile(target, "utf8"), "public");
});
