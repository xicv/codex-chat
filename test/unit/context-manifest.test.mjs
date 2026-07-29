import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createContextManifest,
} from "../../.agents/skills/codex-chat/scripts/lib/context-manifest.mjs";
import { tempDir, writeFixture } from "../helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function manifestPlan(representations) {
  return {
    kind: "CODEX_CHAT_MANIFEST_PLAN_V2",
    protocolVersion: 2,
    routing: {
      workspaceId: "workspace-1",
      coordinatorId: "coordinator-1",
      workUnitId: "work-unit-1",
      agentId: "agent-1",
    },
    checkpointNamespace: "workspace-1:work-unit-1",
    parent: {
      contextSha256: "a".repeat(64),
      turnId: "turn-0",
    },
    checkpoint: {
      goal: "Preserve exact and derived context separately.",
      invariants: ["Original bytes remain independently digest-bound."],
      decisions: ["Model visibility starts unknown."],
      unresolved: ["Transport attachment receipts are not yet available."],
      verificationStatus: "partial",
    },
    representations,
  };
}

test("createContextManifest binds typed exact and derived representations", async () => {
  const root = await tempDir();
  const outputRoot = await tempDir();
  const code = "export const answer = 42;\r\n";
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ocr = "answer 42\n";
  await writeFixture(root, "src/answer.mjs", code);
  await writeFixture(root, "assets/example.png", image);
  await writeFixture(root, "derived/example.ocr.txt", ocr);
  const plan = manifestPlan([
    {
      representationId: "code-source",
      path: "src/answer.mjs",
      modality: "code",
      mediaType: "text/javascript",
      role: "source",
      purpose: "Review exact code bytes.",
      fidelity: "exact",
      sourceRepresentationId: null,
      locator: { space: "line-range", value: "1-1" },
      transform: null,
      expectedSha256: sha256(code),
    },
    {
      representationId: "image-source",
      path: "assets/example.png",
      modality: "image",
      mediaType: "image/png",
      role: "source",
      purpose: "Preserve the original image bytes.",
      fidelity: "exact",
      sourceRepresentationId: null,
      locator: null,
      transform: null,
      expectedSha256: sha256(image),
    },
    {
      representationId: "image-ocr",
      path: "derived/example.ocr.txt",
      modality: "text",
      mediaType: "text/plain",
      role: "derived-evidence",
      purpose: "Expose searchable image text without replacing the image.",
      fidelity: "lossy",
      sourceRepresentationId: "image-source",
      locator: { space: "original-pixels", value: "0,0,100%,100%" },
      transform: {
        tool: "synthetic-ocr",
        version: "1.0",
        parameters: { language: "en" },
        coverage: "full-image",
        truncated: false,
      },
      expectedSha256: sha256(ocr),
    },
  ]);
  const planPath = await writeFixture(
    await tempDir(),
    "plan.json",
    `${JSON.stringify(plan)}\n`,
  );
  const first = await createContextManifest({
    root,
    planPath,
    output: path.join(outputRoot, "first.json"),
    scanner: "skip",
    testMode: true,
  });
  const second = await createContextManifest({
    root,
    planPath,
    output: path.join(outputRoot, "second.json"),
    scanner: "skip",
    testMode: true,
  });

  assert.equal(first.sha256, second.sha256);
  const artifact = JSON.parse(await readFile(first.artifactPath, "utf8"));
  const byId = new Map(artifact.representations.map((item) => [
    item.representationId,
    item,
  ]));
  assert.equal(byId.get("code-source").text.lineEndings, "crlf");
  assert.equal(byId.get("image-source").text, null);
  assert.equal(
    byId.get("image-ocr").sourceSha256,
    byId.get("image-source").sha256,
  );
  assert.equal(byId.get("image-ocr").transform.coverage, "full-image");
  assert.equal(byId.get("image-ocr").delivery.modelVisible, "unknown");
  assert.equal(byId.get("image-ocr").delivery.providerAttachmentId, null);
});

test("createContextManifest rejects stale digests and provenance cycles", async (t) => {
  const root = await tempDir();
  await writeFixture(root, "a.txt", "a\n");
  await writeFixture(root, "b.txt", "b\n");

  await t.test("stale expected digest", async () => {
    const plan = manifestPlan([{
      representationId: "source-a",
      path: "a.txt",
      modality: "text",
      mediaType: "text/plain",
      role: "source",
      purpose: "stale digest",
      fidelity: "exact",
      sourceRepresentationId: null,
      locator: null,
      transform: null,
      expectedSha256: "0".repeat(64),
    }]);
    const planPath = await writeFixture(
      await tempDir(),
      "stale.json",
      `${JSON.stringify(plan)}\n`,
    );
    await assert.rejects(
      createContextManifest({
        root,
        planPath,
        output: path.join(await tempDir(), "manifest.json"),
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "MANIFEST_EXPECTED_DIGEST_MISMATCH",
    );
  });

  await t.test("provenance cycle", async () => {
    const transform = {
      tool: "fixture",
      version: "1",
      parameters: {},
      coverage: "full",
      truncated: false,
    };
    const plan = manifestPlan([
      {
        representationId: "derived-a",
        path: "a.txt",
        modality: "text",
        mediaType: "text/plain",
        role: "derived",
        purpose: "cycle a",
        fidelity: "lossless",
        sourceRepresentationId: "derived-b",
        locator: null,
        transform,
      },
      {
        representationId: "derived-b",
        path: "b.txt",
        modality: "text",
        mediaType: "text/plain",
        role: "derived",
        purpose: "cycle b",
        fidelity: "lossless",
        sourceRepresentationId: "derived-a",
        locator: null,
        transform,
      },
    ]);
    const planPath = await writeFixture(
      await tempDir(),
      "cycle.json",
      `${JSON.stringify(plan)}\n`,
    );
    await assert.rejects(
      createContextManifest({
        root,
        planPath,
        output: path.join(await tempDir(), "manifest.json"),
        scanner: "skip",
        testMode: true,
      }),
      (error) => error.code === "MANIFEST_SOURCE_CYCLE",
    );
  });
});
