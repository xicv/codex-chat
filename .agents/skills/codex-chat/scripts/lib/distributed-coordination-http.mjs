import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { CodexChatError, fail } from "./errors.mjs";
import { LIMITS_DISTRIBUTED_V1 } from "./limits.mjs";

const {
  minTokenBytes: MIN_TOKEN_BYTES,
  maxTokenBytes: MAX_TOKEN_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  headersTimeoutMs: HEADERS_TIMEOUT_MS,
} = LIMITS_DISTRIBUTED_V1.control;

const sha256 = (value) => createHash("sha256").update(value).digest();
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

function validateToken(token) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token) < MIN_TOKEN_BYTES ||
    Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
    !BEARER_TOKEN.test(token)
  ) {
    fail(
      "CONTROL_TOKEN_INVALID",
      `Control-plane token must be ${MIN_TOKEN_BYTES}-${MAX_TOKEN_BYTES} bytes of bearer-safe ASCII.`,
    );
  }
  return token;
}

function isLoopbackHost(host) {
  return [
    "127.0.0.1",
    "::1",
    "[::1]",
  ].includes(host.toLowerCase());
}

function tokenMatches(header, expectedDigest) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  if (
    supplied.length === 0 ||
    Buffer.byteLength(supplied) > MAX_TOKEN_BYTES ||
    !BEARER_TOKEN.test(supplied)
  ) {
    return false;
  }
  return timingSafeEqual(sha256(supplied), expectedDigest);
}

function statusForError(error) {
  if (error.code === "CONTROL_AUTH_FAILED") return 401;
  if (error.code === "CONTROL_RATE_LIMITED") return 429;
  if (error.code === "CONTROL_REQUEST_TOO_LARGE") return 413;
  if (
    error.code === "MAILBOX_BACKPRESSURE" ||
    error.code === "MAILBOX_IN_FLIGHT_LIMIT" ||
    error.code === "MAILBOX_RETENTION_REQUIRED"
  ) {
    return 429;
  }
  if (
    error.code === "COORDINATION_IDEMPOTENCY_CAPACITY" ||
    error.code === "COORDINATION_JOURNAL_CAPACITY" ||
    error.code === "COORDINATION_STATE_CAPACITY" ||
    error.code === "MAILBOX_TOMBSTONE_CAPACITY"
  ) {
    return 507;
  }
  if (
    error.code === "STALE_FENCE" ||
    error.code?.endsWith("_CONFLICT") ||
    error.code === "COORDINATOR_LEASE_HELD"
  ) {
    return 409;
  }
  return 400;
}

function sendJson(response, status, value) {
  let bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    status = 500;
    bytes = Buffer.from(`${JSON.stringify({
      schema: "codex-chat/control/v1",
      ok: false,
      error: {
        code: "CONTROL_RESPONSE_TOO_LARGE",
        message: "Control-plane response exceeded its size limit.",
      },
    })}\n`);
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

async function readBoundedBody(request) {
  const declared = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declared) &&
    declared > MAX_REQUEST_BYTES
  ) {
    fail(
      "CONTROL_REQUEST_TOO_LARGE",
      `Control-plane request exceeds ${MAX_REQUEST_BYTES} bytes.`,
    );
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      fail(
        "CONTROL_REQUEST_TOO_LARGE",
        `Control-plane request exceeds ${MAX_REQUEST_BYTES} bytes.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseRequest(bytes) {
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("CONTROL_JSON_INVALID", "Control-plane request is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CONTROL_JSON_INVALID", "Control-plane request must be a JSON object.");
  }
  return value;
}

function createRateLimiter({
  maxRequests,
  windowMs,
  maxKeys = LIMITS_DISTRIBUTED_V1.control.maxRateLimitKeys,
  clock,
}) {
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(maxKeys) ||
    maxKeys < 1
  ) {
    fail("CONTROL_RATE_LIMIT_INVALID", "Control-plane rate limit is invalid.");
  }
  const windows = new Map();
  return (key) => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      fail("CONTROL_CLOCK_INVALID", "Control-plane rate-limit clock is invalid.");
    }
    const current = windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      if (!current && windows.size >= maxKeys) {
        for (const [observedKey, window] of windows) {
          if (now - window.startedAt >= windowMs) {
            windows.delete(observedKey);
          }
        }
        if (windows.size >= maxKeys) {
          fail(
            "CONTROL_RATE_LIMITED",
            "Control-plane rate-limit key capacity is exhausted.",
          );
        }
      }
      windows.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > maxRequests) {
      fail(
        "CONTROL_RATE_LIMITED",
        "Control-plane request rate exceeded.",
      );
    }
  };
}

export async function startCoordinationHttpServer({
  controlPlane,
  host = "127.0.0.1",
  port = 0,
  token,
  tls = null,
  rateLimit = {
    maxRequests: LIMITS_DISTRIBUTED_V1.control.maxRequestsPerWindow,
    windowMs: LIMITS_DISTRIBUTED_V1.control.rateWindowMs,
  },
  clock = () => Date.now(),
}) {
  if (
    !controlPlane ||
    typeof controlPlane.execute !== "function" ||
    typeof host !== "string" ||
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    fail(
      "CONTROL_SERVER_CONFIG_INVALID",
      "Control-plane server configuration is invalid.",
    );
  }
  validateToken(token);
  if (!isLoopbackHost(host) && tls === null) {
    fail(
      "CONTROL_TLS_REQUIRED",
      "Non-loopback control-plane listeners require TLS.",
    );
  }
  if (
    tls !== null &&
    (
      !tls ||
      typeof tls !== "object" ||
      !tls.key ||
      !tls.cert ||
      (tls.requestCert === true && !tls.ca)
    )
  ) {
    fail(
      "CONTROL_TLS_CONFIG_INVALID",
      "TLS listeners require certificate/private-key bytes, and mTLS requires a client CA.",
    );
  }
  const expectedTokenDigest = sha256(token);
  const limit = createRateLimiter({ ...rateLimit, clock });
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://control.invalid");
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/execute" ||
        url.search !== ""
      ) {
        fail("CONTROL_ROUTE_NOT_FOUND", "Control-plane route does not exist.");
      }
      if (
        !tokenMatches(request.headers.authorization, expectedTokenDigest)
      ) {
        request.resume();
        fail("CONTROL_AUTH_FAILED", "Control-plane authentication failed.");
      }
      limit(request.socket.remoteAddress ?? "unknown");
      const mediaType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        fail(
          "CONTROL_CONTENT_TYPE_INVALID",
          "Control-plane requests require application/json.",
        );
      }
      const data = await controlPlane.execute(
        parseRequest(await readBoundedBody(request)),
      );
      sendJson(response, 200, {
        schema: "codex-chat/control/v1",
        ok: true,
        data,
      });
    } catch (error) {
      const known = error instanceof CodexChatError;
      const visible = known
        ? error
        : new CodexChatError(
            "CONTROL_INTERNAL",
            "Control-plane request failed internally.",
          );
      if (!response.headersSent) {
        sendJson(response, known ? statusForError(error) : 500, {
          schema: "codex-chat/control/v1",
          ok: false,
          error: {
            code: visible.code,
            message: visible.message,
            ...(known && visible.details !== undefined
              ? { details: visible.details }
              : {}),
          },
        });
      } else {
        response.destroy();
      }
    }
  };
  const server = tls
    ? https.createServer(
        {
          key: tls.key,
          cert: tls.cert,
          ...(tls.ca ? { ca: tls.ca } : {}),
          requestCert: tls.requestCert === true,
          rejectUnauthorized: tls.requestCert === true,
          minVersion: "TLSv1.2",
          maxHeaderSize: 16 * 1024,
        },
        handler,
      )
    : http.createServer({ maxHeaderSize: 16 * 1024 }, handler);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    fail(
      "CONTROL_SERVER_CONFIG_INVALID",
      "Control-plane server did not bind a TCP address.",
    );
  }
  const endpointHost = address.family === "IPv6"
    ? `[${address.address}]`
    : address.address;
  let closePromise = null;
  return {
    endpoint: `${tls ? "https" : "http"}://${endpointHost}:${address.port}`,
    close() {
      if (closePromise) return closePromise;
      if (!server.listening) return Promise.resolve();
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}

function validatedEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("CONTROL_ENDPOINT_INVALID", "Control-plane endpoint is invalid.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  ) {
    fail("CONTROL_ENDPOINT_INVALID", "Control-plane endpoint is invalid.");
  }
  if (
    endpoint.protocol === "http:" &&
    !isLoopbackHost(endpoint.hostname)
  ) {
    fail(
      "CONTROL_TLS_REQUIRED",
      "Plaintext control-plane connections are restricted to loopback.",
    );
  }
  return endpoint;
}

export async function executeRemoteCoordination({
  endpoint: endpointValue,
  token,
  request: coordinationRequest,
  ca = undefined,
  cert = undefined,
  key = undefined,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const endpoint = validatedEndpoint(endpointValue);
  validateToken(token);
  if (
    (cert === undefined) !== (key === undefined) ||
    (
      endpoint.protocol !== "https:" &&
      (ca !== undefined || cert !== undefined)
    )
  ) {
    fail(
      "CONTROL_TLS_CONFIG_INVALID",
      "Client certificate and key must be paired and used only with HTTPS.",
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    fail("CONTROL_TIMEOUT_INVALID", "Control-plane timeout is invalid.");
  }
  let body;
  try {
    const serialized = JSON.stringify(coordinationRequest);
    if (serialized === undefined) throw new TypeError("not JSON");
    body = Buffer.from(serialized);
  } catch {
    fail(
      "CONTROL_REQUEST_INVALID",
      "Control-plane request must be serializable JSON.",
    );
  }
  if (body.byteLength > MAX_REQUEST_BYTES) {
    fail(
      "CONTROL_REQUEST_TOO_LARGE",
      `Control-plane request exceeds ${MAX_REQUEST_BYTES} bytes.`,
    );
  }
  const transport = endpoint.protocol === "https:" ? https : http;
  const requestHostname =
    endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
      ? endpoint.hostname.slice(1, -1)
      : endpoint.hostname;
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      operation(value);
    };
    const finishResolve = (value) => finish(resolve, value);
    const finishReject = (error) => finish(reject, error);
    const outbound = transport.request({
      protocol: endpoint.protocol,
      hostname: requestHostname,
      port: endpoint.port,
      path: "/v1/execute",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      ...(endpoint.protocol === "https:" && ca !== undefined ? { ca } : {}),
      ...(endpoint.protocol === "https:" && cert !== undefined
        ? { cert, key }
        : {}),
    }, (incoming) => {
      const chunks = [];
      let total = 0;
      incoming.on("data", (chunk) => {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          const error = new CodexChatError(
            "CONTROL_RESPONSE_TOO_LARGE",
            "Control-plane response exceeded its size limit.",
          );
          incoming.destroy(error);
          finishReject(error);
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        finishResolve({
          statusCode: incoming.statusCode ?? 0,
          bytes: Buffer.concat(chunks),
        });
      });
      incoming.on("error", finishReject);
    });
    timeout = setTimeout(() => {
      const error = new CodexChatError(
        "CONTROL_TIMEOUT",
        "Control-plane request timed out.",
      );
      outbound.destroy(error);
      finishReject(error);
    }, timeoutMs);
    outbound.on("error", finishReject);
    outbound.end(body);
  });
  let envelope;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      response.bytes,
    );
    envelope = JSON.parse(text);
  } catch {
    fail(
      "CONTROL_RESPONSE_INVALID",
      "Control-plane response is not valid JSON.",
    );
  }
  if (
    envelope?.schema !== "codex-chat/control/v1" ||
    typeof envelope.ok !== "boolean"
  ) {
    fail(
      "CONTROL_RESPONSE_INVALID",
      "Control-plane response envelope is invalid.",
    );
  }
  if (!envelope.ok) {
    throw new CodexChatError(
      envelope.error?.code ?? "CONTROL_REMOTE_ERROR",
      envelope.error?.message ?? "Control-plane request failed.",
      envelope.error?.details,
    );
  }
  if (response.statusCode !== 200 || !envelope.data) {
    fail(
      "CONTROL_RESPONSE_INVALID",
      "Successful control-plane response is malformed.",
    );
  }
  return envelope.data;
}
