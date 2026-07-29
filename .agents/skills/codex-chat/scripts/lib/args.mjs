import { fail } from "./errors.mjs";

const repeatable = new Set(["include"]);

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!command || command.startsWith("-")) {
    fail("USAGE", "A command is required.");
  }

  const options = {};
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
    index += 1;
    if (repeatable.has(key)) {
      options[key] ??= [];
      options[key].push(value);
    } else if (Object.hasOwn(options, key)) {
      fail("USAGE", `Option --${key} may only be specified once.`);
    } else {
      options[key] = value;
    }
  }
  return { command, options };
}

export function required(options, key) {
  const value = options[key];
  if (value === undefined) {
    fail("USAGE", `Missing required option --${key}.`);
  }
  return value;
}
