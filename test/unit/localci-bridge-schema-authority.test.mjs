import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const schemasDir = path.join(
  root,
  ".agents",
  "skills",
  "codex-chat",
  "references",
  "schemas",
);

// The authoritative LocalCI Bridge contract lives in the private
// xicv/localci-bridge repository. This repository vendors schema copies for
// reference; the manifest beside them pins the authoritative commit and the
// SHA-256 digest of each vendored file. Any local edit, or an upstream schema
// change copied without updating the manifest, fails here.
test("vendored bridge schemas match the pinned authority manifest", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(schemasDir, "localci-bridge-authority.json"), "utf8"),
  );
  assert.equal(manifest.schema, "codex-chat/localci-bridge-authority/v1");
  assert.equal(manifest.authoritative_repository, "xicv/localci-bridge");
  assert.match(manifest.authoritative_commit_sha, /^[0-9a-f]{40}$/u);
  for (const [file, expectedDigest] of Object.entries(manifest.schemas)) {
    const bytes = await readFile(path.join(schemasDir, file));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      digest,
      expectedDigest,
      `${file} diverges from the authoritative schema pinned at ${manifest.authoritative_commit_sha}; re-vendor from xicv/localci-bridge and update the manifest`,
    );
  }
});

test("the authority manifest pins exactly the vendored bridge schema files", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(schemasDir, "localci-bridge-authority.json"), "utf8"),
  );
  const { readdir } = await import("node:fs/promises");
  const present = new Set(
    (await readdir(schemasDir)).filter((name) => name.startsWith("localci-bridge-") && name.endsWith(".schema.json")),
  );
  const pinned = new Set(Object.keys(manifest.schemas));
  assert.deepEqual([...present].sort(), [...pinned].sort());
});
