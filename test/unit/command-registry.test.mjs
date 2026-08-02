import assert from "node:assert/strict";
import test from "node:test";
import {
  createCommandRegistry,
} from "../../.agents/skills/codex-chat/scripts/lib/command-registry.mjs";

function contract(overrides = {}) {
  return {
    name: "inspect",
    required: ["root"],
    optional: ["include"],
    repeatable: ["include"],
    execute: async ({ command, options, context }) => ({
      command,
      options,
      context,
    }),
    ...overrides,
  };
}

test("the command registry parses, describes, and executes one declared contract", async () => {
  const registry = createCommandRegistry([contract()]);
  const invocation = registry.parse([
    "inspect",
    "--root",
    "/source",
    "--include",
    "src/a.mjs",
    "--include",
    "src/b.mjs",
  ]);

  assert.deepEqual(registry.describe(), {
    commands: ["inspect"],
    commandContracts: [{
      name: "inspect",
      required: ["root"],
      optional: ["include"],
      repeatable: ["include"],
    }],
  });
  assert.deepEqual(
    await registry.execute(invocation, { requestId: "request-1" }),
    {
      command: "inspect",
      options: {
        root: "/source",
        include: ["src/a.mjs", "src/b.mjs"],
      },
      context: { requestId: "request-1" },
    },
  );
});

test("the command registry rejects unknown and undeclared options", () => {
  const registry = createCommandRegistry([contract()]);

  assert.throws(
    () => registry.parse(["unknown"]),
    { code: "UNKNOWN_COMMAND" },
  );
  assert.throws(
    () => registry.parse(["inspect", "--root", "/source", "--typo", "x"]),
    { code: "USAGE" },
  );
  assert.throws(
    () => registry.parse([
      "inspect",
      "--root",
      "/source",
      "--__proto__",
      "x",
    ]),
    { code: "USAGE" },
  );
});

test("the command registry freezes repeatable option values before execution", () => {
  const registry = createCommandRegistry([contract()]);
  const invocation = registry.parse([
    "inspect",
    "--root",
    "/source",
    "--include",
    "src/a.mjs",
  ]);

  assert.throws(
    () => invocation.options.include.push("src/unvalidated.mjs"),
    TypeError,
  );
});

test("the command registry rejects inconsistent definitions at construction", () => {
  assert.throws(
    () => createCommandRegistry([contract(), contract()]),
    { code: "COMMAND_REGISTRY_INVALID" },
  );
  assert.throws(
    () => createCommandRegistry([contract({ optional: ["root"] })]),
    { code: "COMMAND_REGISTRY_INVALID" },
  );
  assert.throws(
    () => createCommandRegistry([contract({ repeatable: ["missing"] })]),
    { code: "COMMAND_REGISTRY_INVALID" },
  );
});

test("the command registry executes only invocations produced by itself", async () => {
  const registry = createCommandRegistry([contract()]);
  const otherRegistry = createCommandRegistry([contract()]);
  const otherInvocation = otherRegistry.parse([
    "inspect",
    "--root",
    "/source",
  ]);

  await assert.rejects(
    registry.execute({ command: "inspect", options: { root: "/source" } }),
    { code: "COMMAND_INVOCATION_INVALID" },
  );
  await assert.rejects(
    registry.execute(otherInvocation),
    { code: "COMMAND_INVOCATION_INVALID" },
  );
});
