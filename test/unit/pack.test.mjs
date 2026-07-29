import assert from "node:assert/strict";
import { chmod, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { packContext } from "../../.agents/skills/codex-chat/scripts/lib/pack.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

test("packContext creates deterministic, sorted, content-addressed context", async () => {
  const root = await tempDir();
  const outputRoot = await tempDir();
  await writeFixture(root, "src/z.js", "export const z = 2;\n");
  await writeFixture(root, "src/a.js", "export const a = 1;\n");

  const first = await packContext({
    root,
    includes: ["src/z.js", "src/a.js"],
    output: path.join(outputRoot, "first.json"),
    scanner: "skip",
    testMode: true,
  });
  const second = await packContext({
    root,
    includes: ["src/a.js", "src/z.js"],
    output: path.join(outputRoot, "second.json"),
    scanner: "skip",
    testMode: true,
  });

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.size, second.size);
  assert.deepEqual(first.files.map(({ path: filePath }) => filePath), [
    "src/a.js",
    "src/z.js",
  ]);
  assert.equal(
    await readFile(first.artifactPath, "utf8"),
    await readFile(second.artifactPath, "utf8"),
  );
});

test("packContext scans the exact staged artifact and rejects scanner findings", async () => {
  const root = await tempDir();
  const outputRoot = await tempDir();
  await writeFixture(root, "safe.txt", "synthetic scanner fixture\n");
  const scanner = await writeFixture(
    await tempDir(),
    "fake-gitleaks",
    "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then echo 'fake 1.0'; exit 0; fi\nexit 11\n",
  );
  await chmod(scanner, 0o700);

  await assert.rejects(
    packContext({
      root,
      includes: ["safe.txt"],
      output: path.join(outputRoot, "context.json"),
      scanner,
      testMode: true,
    }),
    (error) => error.code === "SECRET_DETECTED",
  );
});

test("packContext rejects a parent-directory replacement between selection and read", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  const outputRoot = await tempDir();
  await writeFixture(root, "src/selected.txt", "approved source\n");
  await writeFixture(outside, "selected.txt", "private external data\n");

  await assert.rejects(
    packContext({
      root,
      includes: ["src/selected.txt"],
      output: path.join(outputRoot, "context.json"),
      scanner: "skip",
      testMode: true,
      testHooks: {
        afterSelection: async () => {
          await rename(path.join(root, "src"), path.join(root, "original-src"));
          await symlink(outside, path.join(root, "src"), "dir");
        },
      },
    }),
    (error) => error.code === "SOURCE_PATH_CHANGED",
  );
});

test("packContext refuses destructive or source-nested output paths", async (t) => {
  const root = await tempDir();
  const outside = await tempDir();
  await writeFixture(root, "src/app.mjs", "export const app = true;\n");

  await t.test("selected source file", async () => {
    await assert.rejects(
      packContext({
        root,
        includes: ["src/app.mjs"],
        output: path.join(root, "src/app.mjs"),
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "OUTPUT_CONFINEMENT_INVALID",
    );
  });

  await t.test("elsewhere inside source root", async () => {
    await assert.rejects(
      packContext({
        root,
        includes: ["src/app.mjs"],
        output: path.join(root, "context.json"),
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "OUTPUT_CONFINEMENT_INVALID",
    );
  });

  await t.test("unrelated existing file", async () => {
    const output = path.join(outside, "context.json");
    await writeFile(output, "do not replace\n", { mode: 0o600 });
    await assert.rejects(
      packContext({
        root,
        includes: ["src/app.mjs"],
        output,
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "OUTPUT_EXISTS",
    );
    assert.equal(await readFile(output, "utf8"), "do not replace\n");
  });

  await t.test("symlinked output parent", async () => {
    const realParent = await tempDir();
    const linkedParent = path.join(outside, "linked-parent");
    await symlink(realParent, linkedParent);
    await assert.rejects(
      packContext({
        root,
        includes: ["src/app.mjs"],
        output: path.join(linkedParent, "context.json"),
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "OUTPUT_PARENT_INVALID",
    );
  });
});

test("packContext fails closed for sensitive names, traversal, limits, and symlinks", async (t) => {
  const root = await tempDir();
  const outputRoot = await tempDir();
  await writeFixture(root, "safe.txt", "safe\n");
  await writeFixture(root, ".env", "SECRET=value\n");
  await writeFixture(root, "large.txt", "x".repeat(16));
  await writeFixture(root, "crlf.txt", "one\r\ntwo\r\n");
  await writeFixture(root, "Case.txt", "upper\n");
  await writeFixture(root, "case.txt", "lower\n");
  await writeFixture(root, "real/nested.txt", "nested\n");
  await symlink(path.join(root, "safe.txt"), path.join(root, "linked.txt"));
  await symlink(path.join(root, "real"), path.join(root, "linked-dir"));

  const cases = [
    ["sensitive name", [".env"], {}, "SENSITIVE_PATH"],
    ["traversal", ["../safe.txt"], {}, "PATH_TRAVERSAL"],
    ["per-file size", ["large.txt"], { maxFileBytes: 8 }, "FILE_TOO_LARGE"],
    ["artifact size", ["safe.txt"], { maxArtifactBytes: 32 }, "ARTIFACT_TOO_LARGE"],
    ["symlink", ["linked.txt"], {}, "SYMLINK_REJECTED"],
    ["symlink parent", ["linked-dir/nested.txt"], {}, "SYMLINK_REJECTED"],
    ["backslash", ["src\\file.txt"], {}, "PATH_BACKSLASH"],
    ["control", ["bad\u0001.txt"], {}, "PATH_CONTROL"],
    ["CRLF", ["crlf.txt"], {}, "TEXT_FORMAT_REJECTED"],
    ["case collision", ["Case.txt", "case.txt"], {}, "PATH_COLLISION"],
    ["VCS internals", [".git/config"], {}, "SENSITIVE_PATH"],
    ["database", ["data.sqlite"], {}, "SENSITIVE_PATH"],
  ];
  await writeFixture(root, ".git/config", "[core]\n");
  await writeFixture(root, "data.sqlite", "not really a database\n");
  for (const [name, includes, extra, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        packContext({
          root,
          includes,
          output: path.join(outputRoot, `${name}.json`),
          scanner: "skip",
          testMode: true,
          ...extra,
        }),
        (error) => error.code === code,
      );
    });
  }
});
