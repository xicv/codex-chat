import { fail } from "./errors.mjs";

export function parseArgs(argv, { repeatable = new Set(["include"]) } = {}) {
  const [command, ...tokens] = argv;
  if (!command || command.startsWith("-")) {
    fail("USAGE", "A command is required.");
  }

  const optionValues = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      fail("USAGE", `Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      fail("USAGE", `Option --${key} requires a value.`);
    }
    if (key === "scanner") {
      fail(
        "SCANNER_OVERRIDE_FORBIDDEN",
        "The installed CLI always uses an identity-verified gitleaks executable.",
      );
    }
    index += 1;
    if (repeatable.has(key)) {
      const values = optionValues.get(key) ?? [];
      values.push(value);
      optionValues.set(key, values);
    } else if (optionValues.has(key)) {
      fail("USAGE", `Option --${key} may only be specified once.`);
    } else {
      optionValues.set(key, value);
    }
  }
  return { command, options: Object.fromEntries(optionValues) };
}

export function required(options, key) {
  const value = options[key];
  if (value === undefined) {
    fail("USAGE", `Missing required option --${key}.`);
  }
  return value;
}
