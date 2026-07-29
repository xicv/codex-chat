export class CodexChatError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CodexChatError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new CodexChatError(code, message, details);
}
