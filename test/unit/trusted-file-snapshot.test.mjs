import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  readTrustedFileSnapshot,
} from "../../.agents/skills/codex-chat/scripts/lib/trusted-file-snapshot.mjs";
import { tempDir } from "../helpers.mjs";

test("readTrustedFileSnapshot returns bytes bound to one regular-file identity", async () => {
  const root = await tempDir("codex-chat-trusted-file-");
  const filePath = path.join(root, "artifact.txt");
  await writeFile(filePath, "trusted bytes\n", { mode: 0o600 });

  const snapshot = await readTrustedFileSnapshot(filePath, {
    minBytes: 1,
    maxBytes: 1024,
    requirePrivate: true,
  });

  assert.equal(snapshot.path, filePath);
  assert.equal(snapshot.bytes.toString("utf8"), "trusted bytes\n");
  assert.equal(snapshot.size, snapshot.bytes.byteLength);
  assert.equal(Number.isSafeInteger(snapshot.identity.dev), true);
  assert.equal(Number.isSafeInteger(snapshot.identity.ino), true);
});

test("trusted snapshots distinguish optional and required missing files", async () => {
  const root = await tempDir("codex-chat-trusted-missing-");
  const filePath = path.join(root, "missing.txt");

  assert.equal(await readTrustedFileSnapshot(filePath, {
    maxBytes: 1024,
    optional: true,
  }), null);
  await assert.rejects(
    readTrustedFileSnapshot(filePath, { maxBytes: 1024 }),
    { code: "TRUSTED_FILE_MISSING" },
  );
});

test("trusted snapshots reject a symbolic-link final component", async () => {
  const root = await tempDir("codex-chat-trusted-symlink-");
  const target = path.join(root, "target.txt");
  const linked = path.join(root, "linked.txt");
  await writeFile(target, "outside\n", { mode: 0o600 });
  await symlink(target, linked);

  await assert.rejects(
    readTrustedFileSnapshot(linked, { maxBytes: 1024 }),
    { code: "TRUSTED_FILE_PATH_INVALID" },
  );
});

test("trusted snapshots enforce both sides of their byte interval", async () => {
  const root = await tempDir("codex-chat-trusted-bounds-");
  const empty = path.join(root, "empty.txt");
  const large = path.join(root, "large.txt");
  await writeFile(empty, "", { mode: 0o600 });
  await writeFile(large, "12345", { mode: 0o600 });

  await assert.rejects(
    readTrustedFileSnapshot(empty, { minBytes: 1, maxBytes: 1024 }),
    { code: "TRUSTED_FILE_TOO_SMALL" },
  );
  await assert.rejects(
    readTrustedFileSnapshot(large, { maxBytes: 4 }),
    { code: "TRUSTED_FILE_TOO_LARGE" },
  );
});

test("trusted snapshots reject shared files when private mode is required", async () => {
  const root = await tempDir("codex-chat-trusted-private-");
  const filePath = path.join(root, "shared.txt");
  await writeFile(filePath, "shared\n", { mode: 0o600 });
  await chmod(filePath, 0o644);

  await assert.rejects(
    readTrustedFileSnapshot(filePath, {
      maxBytes: 1024,
      requirePrivate: true,
    }),
    { code: "TRUSTED_FILE_PERMISSIONS_INVALID" },
  );
});

test("trusted snapshots reject missing, inherited, and unknown policy fields", async () => {
  const root = await tempDir("codex-chat-trusted-policy-");
  const filePath = path.join(root, "artifact.txt");
  await writeFile(filePath, "artifact\n", { mode: 0o600 });

  for (const policy of [
    {},
    Object.create({ maxBytes: 1024 }),
    { maxBytes: 1024, unexpected: true },
  ]) {
    await assert.rejects(
      readTrustedFileSnapshot(filePath, policy),
      { code: "TRUSTED_FILE_INPUT_INVALID" },
    );
  }
});
