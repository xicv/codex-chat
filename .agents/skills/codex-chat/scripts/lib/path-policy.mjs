import path from "node:path";
import { fail } from "./errors.mjs";

export function isSensitivePath(relativePath) {
  const segments = relativePath.toLowerCase().split("/");
  return segments.some((segment) =>
    segment === ".env" ||
    segment.startsWith(".env.") ||
    [
      ".git", ".hg", ".svn", ".jj", ".codex", ".codex-chat",
      "node_modules", ".cache", "cache", "coverage", "dist", "build",
      "browser-profile", "browser_state", "browser-state",
    ].includes(segment) ||
    /^(id_rsa|id_ed25519|credentials|cookies?|tokens?|auth[-_.]?state)(\.|$)/u
      .test(segment) ||
    /\.(pem|key|p12|pfx|kdbx|sqlite|sqlite3|db|db3|mdb|accdb)$/u
      .test(segment)
  );
}

export function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("PATH_INVALID", "Path must be a non-empty string.");
  }
  if (value.includes("\\")) {
    fail("PATH_BACKSLASH", `Backslashes are not allowed in collaboration paths: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail("PATH_CONTROL", "Control characters are not allowed in collaboration paths.");
  }
  if (path.isAbsolute(value)) {
    fail("PATH_ABSOLUTE", `Path must be relative: ${value}`);
  }
  const unicodeNormalized = value.normalize("NFC");
  const segments = unicodeNormalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("PATH_TRAVERSAL", `Path is not canonical relative POSIX form: ${value}`);
  }
  const normalized = path.posix.normalize(unicodeNormalized);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail("PATH_TRAVERSAL", `Path escapes the selected root: ${value}`);
  }
  return normalized;
}
