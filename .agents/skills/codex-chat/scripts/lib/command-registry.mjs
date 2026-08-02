import { fail } from "./errors.mjs";
import { parseArgs } from "./args.mjs";

const NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const KEYS = ["name", "required", "optional", "repeatable", "execute"];

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function validOptionList(value) {
  return Array.isArray(value) &&
    value.every((option) => NAME.test(option));
}

function canonicalContract(value) {
  if (
    !exactKeys(value, KEYS) ||
    !NAME.test(value.name ?? "") ||
    !validOptionList(value.required) ||
    !validOptionList(value.optional) ||
    !validOptionList(value.repeatable) ||
    typeof value.execute !== "function"
  ) {
    fail("COMMAND_REGISTRY_INVALID", "CLI command contract is malformed.");
  }
  const required = [...new Set(value.required)];
  const optional = [...new Set(value.optional)];
  const allowed = new Set([...required, ...optional]);
  if (
    required.length !== value.required.length ||
    optional.length !== value.optional.length ||
    required.some((option) => optional.includes(option)) ||
    new Set(value.repeatable).size !== value.repeatable.length ||
    value.repeatable.some((option) => !allowed.has(option))
  ) {
    fail(
      "COMMAND_REGISTRY_INVALID",
      "CLI command option contract is inconsistent.",
    );
  }
  return Object.freeze({
    name: value.name,
    required: Object.freeze(required),
    optional: Object.freeze(optional),
    repeatable: Object.freeze([...value.repeatable]),
    execute: value.execute,
  });
}

export function createCommandRegistry(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    fail("COMMAND_REGISTRY_INVALID", "CLI command registry must not be empty.");
  }
  const canonical = Object.freeze(contracts.map(canonicalContract));
  const byName = new Map(canonical.map((contract) => [contract.name, contract]));
  if (byName.size !== canonical.length) {
    fail("COMMAND_REGISTRY_INVALID", "CLI command names must be unique.");
  }
  const fallbackRepeatable = new Set(canonical.flatMap(
    (contract) => contract.repeatable,
  ));
  const parsedInvocations = new WeakSet();

  return Object.freeze({
    describe() {
      return {
        commands: canonical.map(({ name }) => name),
        commandContracts: canonical.map((contract) => ({
          name: contract.name,
          required: [...contract.required],
          optional: [...contract.optional],
          repeatable: [...contract.repeatable],
        })),
      };
    },
    parse(argv) {
      const selected = byName.get(argv[0]);
      const parsed = parseArgs(argv, {
        repeatable: new Set(selected?.repeatable ?? fallbackRepeatable),
      });
      const contract = byName.get(parsed.command);
      if (!contract) {
        fail("UNKNOWN_COMMAND", `Unknown command: ${parsed.command}`);
      }
      const allowed = new Set([...contract.required, ...contract.optional]);
      const unknown = Object.keys(parsed.options).find(
        (option) => !allowed.has(option),
      );
      if (unknown) {
        fail(
          "USAGE",
          `Unknown option --${unknown} for command ${contract.name}.`,
        );
      }
      const missing = contract.required.find(
        (option) => !Object.hasOwn(parsed.options, option),
      );
      if (missing) {
        fail("USAGE", `Missing required option --${missing}.`);
      }
      const options = Object.freeze(Object.fromEntries(
        Object.entries(parsed.options).map(([option, value]) => [
          option,
          Array.isArray(value) ? Object.freeze([...value]) : value,
        ]),
      ));
      const invocation = Object.freeze({
        command: parsed.command,
        options,
      });
      parsedInvocations.add(invocation);
      return invocation;
    },
    async execute(invocation, context = {}) {
      const contract = byName.get(invocation?.command);
      if (
        !parsedInvocations.has(invocation) ||
        !contract ||
        invocation === null ||
        typeof invocation !== "object" ||
        Array.isArray(invocation) ||
        invocation.options === null ||
        typeof invocation.options !== "object" ||
        Array.isArray(invocation.options)
      ) {
        fail("COMMAND_INVOCATION_INVALID", "CLI command invocation is invalid.");
      }
      return contract.execute({
        command: contract.name,
        options: invocation.options,
        context,
      });
    },
  });
}
