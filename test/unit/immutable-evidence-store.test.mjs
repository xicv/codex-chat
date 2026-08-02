import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  openImmutableEvidenceStore,
  publishImmutableEvidence,
  readImmutableEvidence,
} from "../../.agents/skills/codex-chat/scripts/lib/immutable-evidence-store.mjs";
import { tempDir } from "../helpers.mjs";

const CODES = Object.freeze({
  directoryInvalid: "TEST_EVIDENCE_DIRECTORY_INVALID",
  parentChanged: "TEST_EVIDENCE_PARENT_CHANGED",
  slotBusy: "TEST_EVIDENCE_SLOT_BUSY",
  slotConflict: "TEST_EVIDENCE_SLOT_CONFLICT",
});

async function fixture() {
  const parent = await tempDir("codex-chat-evidence-store-");
  const root = path.join(parent, "evidence");
  const store = await openImmutableEvidenceStore({
    root,
    directories: ["objects", "receipts", "slots", ".locks"],
    codes: CODES,
  });
  const receiptBytes = Buffer.from('{"receipt":"a"}\n');
  const objectBytes = Buffer.from("immutable object\n");
  const slotBytes = Buffer.from('{"slot":"a"}\n');
  const publication = {
    store,
    slotId: "slot-a",
    slot: {
      relativePath: "slots/slot-a.json",
      bytes: slotBytes,
      maxBytes: 1024,
    },
    artifacts: [
      {
        relativePath: "objects/object-a.txt",
        bytes: objectBytes,
        maxBytes: 1024,
        conflictCode: "TEST_EVIDENCE_OBJECT_CONFLICT",
      },
      {
        relativePath: "receipts/receipt-a.json",
        bytes: receiptBytes,
        maxBytes: 1024,
        conflictCode: "TEST_EVIDENCE_RECEIPT_CONFLICT",
      },
    ],
  };
  return { parent, root, store, publication, objectBytes };
}

test("32 identical immutable-evidence writers publish one authoritative slot", async () => {
  const { publication } = await fixture();
  const results = await Promise.all(
    Array.from({ length: 32 }, () => publishImmutableEvidence(publication)),
  );

  assert.equal(results.filter(({ idempotent }) => !idempotent).length, 1);
  assert.equal(results.filter(({ idempotent }) => idempotent).length, 31);
  assert.equal(new Set(results.map(({ slotPath }) => slotPath)).size, 1);
});

test("an immutable slot rejects divergent evidence", async () => {
  const { publication } = await fixture();
  await publishImmutableEvidence(publication);

  await assert.rejects(publishImmutableEvidence({
    ...publication,
    slot: {
      ...publication.slot,
      bytes: Buffer.from('{"slot":"different"}\n'),
    },
  }), { code: CODES.slotConflict });
});

test("independent slots can concurrently share the same content-addressed objects", async () => {
  const { publication } = await fixture();
  const second = {
    ...publication,
    slotId: "slot-b",
    slot: {
      ...publication.slot,
      relativePath: "slots/slot-b.json",
      bytes: Buffer.from('{"slot":"b"}\n'),
    },
  };

  const results = await Promise.all([
    publishImmutableEvidence(publication),
    publishImmutableEvidence(second),
  ]);
  assert.deepEqual(results.map(({ idempotent }) => idempotent), [false, false]);
});

test("partial object publication is completed by the same exact replay", async () => {
  const { publication, store, objectBytes } = await fixture();
  await writeFile(
    path.join(store.root, "objects", "object-a.txt"),
    objectBytes,
    { mode: 0o600, flag: "wx" },
  );

  const result = await publishImmutableEvidence(publication);
  assert.equal(result.idempotent, false);
});

test("a stale authority guard publishes no evidence", async () => {
  const { publication } = await fixture();
  let current = false;
  const guarded = {
    ...publication,
    authority: {
      assertCurrent() {
        if (!current) {
          const error = new Error("stale authority");
          error.code = "TEST_EVIDENCE_AUTHORITY_STALE";
          throw error;
        }
      },
    },
  };

  await assert.rejects(
    publishImmutableEvidence(guarded),
    { code: "TEST_EVIDENCE_AUTHORITY_STALE" },
  );
  current = true;
  assert.equal((await publishImmutableEvidence(guarded)).idempotent, false);
});

test("authoritative replay detects artifact tampering", async () => {
  const { publication, store } = await fixture();
  await publishImmutableEvidence(publication);
  await writeFile(
    path.join(store.root, "objects", "object-a.txt"),
    "tampered\n",
  );

  await assert.rejects(
    publishImmutableEvidence(publication),
    { code: "TEST_EVIDENCE_OBJECT_CONFLICT" },
  );
});

test("immutable evidence rejects shared directories and artifacts", async () => {
  const parent = await tempDir("codex-chat-evidence-shared-");
  const root = path.join(parent, "evidence");
  await mkdir(root, { mode: 0o755 });
  await assert.rejects(openImmutableEvidenceStore({
    root,
    directories: [".locks"],
    codes: CODES,
  }), { code: CODES.directoryInvalid });

  await chmod(root, 0o700);
  const store = await openImmutableEvidenceStore({
    root,
    directories: ["objects", "receipts", "slots", ".locks"],
    codes: CODES,
  });
  const publication = (await fixture()).publication;
  const rebound = {
    ...publication,
    store,
  };
  await publishImmutableEvidence(rebound);
  await chmod(path.join(root, "objects", "object-a.txt"), 0o644);
  await assert.rejects(
    publishImmutableEvidence(rebound),
    { code: "TEST_EVIDENCE_OBJECT_CONFLICT" },
  );
});

test("a replaced evidence root fails before publishing through a symlink", async () => {
  const { parent, root, publication } = await fixture();
  const moved = path.join(parent, "moved-evidence");
  const outside = path.join(parent, "outside");
  await rename(root, moved);
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, root);

  await assert.rejects(
    publishImmutableEvidence(publication),
    { code: CODES.parentChanged },
  );
});

test("immutable evidence reads require an explicit positive byte limit", async () => {
  const { publication, store } = await fixture();
  await publishImmutableEvidence(publication);

  await assert.rejects(
    readImmutableEvidence({
      store,
      relativePath: "objects/object-a.txt",
      maxBytes: 0,
      conflictCode: "TEST_EVIDENCE_OBJECT_CONFLICT",
    }),
    { code: "IMMUTABLE_EVIDENCE_INPUT_INVALID" },
  );
  await assert.rejects(
    readImmutableEvidence({
      store,
      relativePath: "objects/object-a.txt",
      maxBytes: Number.MAX_SAFE_INTEGER,
      conflictCode: "TEST_EVIDENCE_OBJECT_CONFLICT",
    }),
    { code: "IMMUTABLE_EVIDENCE_INPUT_INVALID" },
  );
});
