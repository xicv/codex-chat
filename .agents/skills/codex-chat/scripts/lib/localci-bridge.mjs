import { createHash } from "node:crypto";
import path from "node:path";
import { readTrustedFileSnapshot } from "./trusted-file-snapshot.mjs";
import { fail } from "./errors.mjs";

const JOB_MAX_BYTES = 128 * 1024;
const RESULT_MAX_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{7,79}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[A-Za-z0-9._/-]+$/u;
const PATH_PATTERN = /^[A-Za-z0-9._/*-]+$/u;
const URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/u;
const FORBIDDEN_PATHS = [
  ".github/workflows/",
  "aws/",
  "deployment/",
  "src/.env",
  "data/",
  "storage/",
];
const SENSITIVE_TEXT = [
  /\bpassword\b\s*[:=]/iu,
  /\b(api[_ -]?key|access[_ -]?token|secret[_ -]?key)\b\s*[:=]/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bmessage[_ -]?id\b\s*[:=]/iu,
  /\bthread[_ -]?id\b\s*[:=]/iu,
];

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("LOCALCI_BRIDGE_OBJECT_INVALID", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "LOCALCI_BRIDGE_KEYS_INVALID",
      `${label} has missing or unexpected fields.`,
      { actual, expected },
    );
  }
  return value;
}

function stringField(value, label, { min = 1, max = 1000, pattern = null } = {}) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    (pattern !== null && !pattern.test(value))
  ) {
    fail("LOCALCI_BRIDGE_STRING_INVALID", `${label} is invalid.`);
  }
  return value;
}

function enumField(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(
      "LOCALCI_BRIDGE_ENUM_INVALID",
      `${label} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function integerField(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      "LOCALCI_BRIDGE_INTEGER_INVALID",
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

function utcTimestamp(value, label) {
  stringField(value, label, { max: 64 });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(
      "LOCALCI_BRIDGE_DATE_INVALID",
      `${label} must be a canonical UTC ISO timestamp.`,
    );
  }
  return value;
}

function rejectSensitiveText(value, label) {
  if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
    fail(
      "LOCALCI_BRIDGE_SENSITIVE_TEXT",
      `${label} appears to contain a secret or raw mailbox identifier.`,
    );
  }
}

function normalizeCanonical(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "LOCALCI_BRIDGE_JSON_NUMBER_INVALID",
        "JSON numbers must be finite.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeCanonical(value[key])]),
    );
  }
  fail(
    "LOCALCI_BRIDGE_JSON_VALUE_INVALID",
    "Value cannot be represented as canonical JSON.",
  );
}

export function canonicalBridgeJson(value) {
  return `${JSON.stringify(normalizeCanonical(value))}\n`;
}

export function bridgeDigest(value) {
  return createHash("sha256").update(canonicalBridgeJson(value)).digest("hex");
}

async function readBridgeJson(filePath, maxBytes, label) {
  const snapshot = await readTrustedFileSnapshot(filePath, {
    minBytes: 2,
    maxBytes,
  });
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch {
    fail(
      "LOCALCI_BRIDGE_UTF8_INVALID",
      `${label} must be valid UTF-8.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      "LOCALCI_BRIDGE_JSON_INVALID",
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function validateAllowedPatj˜[YJHÂˆÝš[™ÑšY[
˜[YKš›Ø‹˜[ÝÙYÜ]È][H‹ÂˆX^ˆˆ]\›ŽˆUÔUT“‹ˆJNÂˆYˆ
ˆ˜[YKœÝ\ÕÚ]
‹ÈŠHˆ˜[YKœÝ\ÕÚ]
ŸˆŠHˆ˜[YKš[˜ÛY\Ê—ŠHˆ]œÜÚ^››Ü›X[^™J˜[YJHOOH˜[YHˆ˜[YHOOH‹ˆˆˆ˜[YKœÝ\ÕÚ]
‹‹‹ÈŠHˆ˜[YKš[˜ÛY\ÊŠŠ‹ÊŠˆŠHˆ“Ô’QS—ÔUËœÛÛYJ
™Yš^
HO‚ˆ˜[YHOOH™Yš^œ™\XÙJ×ÉÝKˆŠH˜[YKœÝ\ÕÚ]
™Yš^
Kˆ
Bˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔUÒS•SQ‹ˆ›Øˆ]\È[œØY™HÜˆ›ÝXÝYˆ	Ý˜[Y_Xˆ
NÂˆBŸB‚™^Ü[˜Ý[Ûˆ˜[Y]PœšYÙR›ØŠ˜[YK^XÝ][ÛœÊHÂˆ^XÝØš™XÝ
ˆ^XÝ][ÛœËˆÈœ™\ÜÚ]ÜžH‹˜˜\ÙTÚH‹™Y˜][œ˜[˜Ú—Kˆš›Øˆ^XÝ][ÛœÈ‹ˆ
NÂˆÝš[™ÑšY[
^XÝ][ÛœËœ™\ÜÚ]ÜžK™^XÝY™\ÜÚ]ÜžH‹ÂˆX^ˆŒˆ]\›Žˆ‘TÔÒUÔ–KˆJNÂˆÝš[™ÑšY[
^XÝ][ÛœË˜˜\ÙTÚK™^XÝY˜\ÙHÒH‹ÂˆZ[ŽˆˆX^ˆˆ]\›ŽˆÓÓSRUÔÒKˆJNÂˆÝš[™ÑšY[
^XÝ][ÛœË™Y˜][œ˜[˜Ú™^XÝYY˜][œ˜[˜Ú‹ÂˆX^ˆLˆ]\›Žˆ”SÒˆJNÂ‚ˆ^XÝØš™XÝ
˜[YKÂˆœØÚ[XH‹šY‹˜Ü™X]YØ]‹œÛÝ\˜ÙH‹\™Ù]‹\Ú×Ý\H‹›[ÙH‹ˆœš[Üš]H‹š[œÝXÝ[ÛœÈ‹˜XØÙ\[˜ÙWØÜš]\šXH‹˜[ÝÙYÜ]È‹ˆ™\šYšXØ][Û—Ü›Ùš[H‹[Y[Ý]ÛZ[]\È‹œX›\Ú‹ˆK˜œšYÙH›ØˆŠNÂˆYˆ
˜[YKœØÚ[XHOOH›ØØ[ÚKXœšYÙKÚ›Ø‹ÝŒHŠHÂˆ˜Z[
“ÐÐSÒWÐ”’QÑWÔÐÒSPWÒS•SQ‹•[œÝ\ÜYœšYÙH›ØˆØÚ[XKˆŠNÂˆBˆÝš[™ÑšY[
˜[YKšYš›Ø‹šY‹ÈZ[ŽˆX^ˆ]\›Žˆ“Ð—ÒQJNÂˆ]Õ[Y\Ý[\
˜[YK˜Ü™X]YØ]š›Ø‹˜Ü™X]YØ]ŠNÂ‚ˆ^XÝØš™XÝ
ˆ˜[YKœÛÝ\˜ÙKˆÈšÚ[™‹™š[™Ù\œš[‹œÝXš™XÝ‹œÙ[™\ˆ‹œ™XÙZ]™YØ]‹œÝ[[X\žH—Kˆš›Ø‹œÛÝ\˜ÙH‹ˆ
NÂˆ[[QšY[
˜[YKœÛÝ\˜ÙKšÚ[™È™ÛXZ[‹™Ú]Xˆ‹›X[X[—KœÛÝ\˜ÙKšÚ[™ŠNÂˆÝš[™ÑšY[
˜[YKœÛÝ\˜ÙK™š[™Ù\œš[œÛÝ\˜ÙK™š[™Ù\œš[‹ÂˆZ[ŽˆˆX^ˆˆ]\›ŽˆÒLM‹ˆJNÂˆÝš[™ÑšY[
˜[YKœÛÝ\˜ÙKœÝXš™XÝœÛÝ\˜ÙKœÝXš™XÝ‹ÈX^ˆŒJNÂˆÝš[™ÑšY[
˜[YKœÛÝ\˜ÙKœÙ[™\‹œÛÝ\˜ÙKœÙ[™\ˆ‹ÈX^ˆMŒJNÂˆ]Õ[Y\Ý[\
˜[YKœÛÝ\˜ÙKœ™XÙZ]™YØ]œÛÝ\˜ÙKœ™XÙZ]™YØ]ŠNÂˆÝš[™ÑšY[
˜[YKœÛÝ\˜ÙKœÝ[[X\žKœÛÝ\˜ÙKœÝ[[X\žH‹ÈX^ˆÌJNÂˆ›Üˆ
ÛÛœÝÛX™[^HÙˆÂˆÈœÛÝ\˜ÙKœÝXš™XÝ‹˜[YKœÛÝ\˜ÙKœÝXš™XÝKˆÈœÛÝ\˜ÙKœÙ[™\ˆ‹˜[YKœÛÝ\˜ÙKœÙ[™\—KˆÈœÛÝ\˜ÙKœÝ[[X\žH‹˜[YKœÛÝ\˜ÙKœÝ[[X\žWKˆJH™Z™XÝÙ[œÚ]]™U^
^X™[
NÂ‚ˆ^XÝØš™XÝ
ˆ˜[YK\™Ù]ˆÈœ™\ÜÚ]ÜžH‹˜˜\ÙWÜÚH‹™Y˜][Øœ˜[˜Ú—Kˆš›Ø‹\™Ù]‹ˆ
NÂˆYˆ
ˆ˜[YK\™Ù]œ™\ÜÚ]ÜžHOOH^XÝ][ÛœËœ™\ÜÚ]ÜžHˆ˜[YK\™Ù]˜˜\ÙWÜÚHOOH^XÝ][ÛœË˜˜\ÙTÚHˆ˜[YK\™Ù]™Y˜][Øœ˜[˜ÚOOH^XÝ][ÛœË™Y˜][œ˜[˜Úˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÕT‘ÑUÓRTÓPUÒ‹ˆ’›Øˆ\™Ù]Ù\È›ÝX]Ú[™\[™[HÝ\YY^XÝ][ÛœËˆ‹ˆ
NÂˆB‚ˆ[[QšY[
˜[YK\Ú×Ý\KÈšXYÙK\™\Ü‹™˜Y\ˆ—Kš›Ø‹\Ú×Ý\HŠNÂˆ[[QšY[
˜[YK›[ÙKÈœ™XY[Û›H‹ÛÜšÜÜXÙK]Üš]H—Kš›Ø‹›[ÙHŠNÂˆYˆ
ˆ
˜[YK\Ú×Ý\HOOHšXYÙK\™\Üˆ	‰ˆ˜[YK›[ÙHOOHœ™XY[Û›HŠHˆ
˜[YK\Ú×Ý\HOOH™˜Y\ˆˆ	‰ˆ˜[YK›[ÙHOOHÛÜšÜÜXÙK]Üš]HŠBˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÓSÑWÒS•SQ‹ˆ’›Øˆ\H[™^XÝ][Ûˆ[ÙH\™H[˜ÛÛœÚ\Ý[ˆ‹ˆ
NÂˆBˆ[[QšY[
ˆ˜[YKœš[Üš]KˆÈœ™YÜ™\ÜÚ[Ûˆ‹œÙXÝ\š]H‹˜YÈ‹™™X]\™H‹™ØÝ[Y[][Ûˆ—Kˆš›Ø‹œš[Üš]H‹ˆ
NÂˆÝš[™ÑšY[
˜[YKš[œÝXÝ[ÛœËš›Ø‹š[œÝXÝ[ÛœÈ‹ÈX^ˆLŒJNÂˆ™Z™XÝÙ[œÚ]]™U^
˜[YKš[œÝXÝ[ÛœËš›Ø‹š[œÝXÝ[ÛœÈŠNÂ‚ˆYˆ
ˆP\œ˜^Kš\Ð\œ˜^J˜[YK˜XØÙ\[˜ÙWØÜš]\šXJHˆ˜[YK˜XØÙ\[˜ÙWØÜš]\šXK›[™ÝHˆ˜[YK˜XØÙ\[˜ÙWØÜš]\šXK›[™ÝˆÌˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÐPÐÑTSÑWÒS•SQ‹ˆ’›ØˆXØÙ\[˜ÙHÜš]\šXH\™H[˜[Yˆ‹ˆ
NÂˆBˆ›Üˆ
ÛÛœÝÜš]\š[ÛˆÙˆ˜[YK˜XØÙ\[˜ÙWØÜš]\šXJHÂˆÝš[™ÑšY[
Üš]\š[Û‹š›ØˆXØÙ\[˜ÙHÜš]\š[Ûˆ‹ÈX^ˆLJNÂˆ™Z™XÝÙ[œÚ]]™U^
Üš]\š[Û‹š›ØˆXØÙ\[˜ÙHÜš]\š[ÛˆŠNÂˆB‚ˆYˆ
ˆP\œ˜^Kš\Ð\œ˜^J˜[YK˜[ÝÙYÜ]ÊHˆ˜[YK˜[ÝÙYÜ]Ë›[™Ýˆˆ™]ÈÙ]
˜[YK˜[ÝÙYÜ]ÊKœÚ^™HOOH˜[YK˜[ÝÙYÜ]Ë›[™Ýˆ
HÂˆ˜Z[
“ÐÐSÒWÐ”’QÑWÔU×ÒS•SQ‹’›Øˆ[ÝÙY]È\™H[˜[YˆŠNÂˆBˆ›Üˆ
ÛÛœÝ[ÝÙY]Ùˆ˜[YK˜[ÝÙYÜ]ÊH˜[Y]P[ÝÙY]
[ÝÙY]
NÂˆYˆ
ˆ
˜[YK\Ú×Ý\HOOHšXYÙK\™\Üˆ	‰ˆ˜[YK˜[ÝÙYÜ]Ë›[™ÝOOH
Hˆ
˜[YK\Ú×Ý\HOOH™˜Y\ˆˆ	‰ˆ˜[YK˜[ÝÙYÜ]Ë›[™ÝOOH
Bˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔU×ÒS•SQ‹ˆ’›Øˆ\H[™[ÝÙY]È\™H[˜ÛÛœÚ\Ý[ˆ‹ˆ
NÂˆB‚ˆYˆ
ˆ^XÝ][ÛœËœ™\ÜÚ]ÜžHOOHžXÝ‹Ô[ÜT[›™\ˆˆ	‰‚ˆ˜[YK™\šYšXØ][Û—Ü›Ùš[HOOHœ[Ü\[›™\‹\]X[]H‚ˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ“Ñ’SWÒS•SQ‹ˆ”[ÜT[›™\ˆ›ØœÈ]\Ý\ÙH[Ü\[›™\‹\]X[]Kˆ‹ˆ
NÂˆBˆÝš[™ÑšY[
˜[YK™\šYšXØ][Û—Ü›Ùš[Kš›Ø‹™\šYšXØ][Û—Ü›Ùš[H‹ÂˆX^ˆˆ]\›Žˆ×–ØK^—VØK^ŒNKW^Ì‹ŒßIÝKˆJNÂˆ[YÙ\‘šY[
˜[YK[Y[Ý]ÛZ[]\Ëš›Ø‹[Y[Ý]ÛZ[]\È‹KLŒ
NÂ‚ˆ^XÝØš™XÝ
ˆ˜[YKœX›\ÚˆÈ™˜YÜˆ‹›Y\™ÙH‹™\ÞH‹œ™[X\ÙH—Kˆš›Ø‹œX›\Ú‹ˆ
NÂˆYˆ
ˆ˜[YKœX›\Ú™˜YÜˆOOHYHˆ˜[YKœX›\Ú›Y\™ÙHOOH˜[ÙHˆ˜[YKœX›\Ú™\ÞHOOH˜[ÙHˆ˜[YKœX›\Úœ™[X\ÙHOOH˜[ÙBˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔP“PÐUSÓ—ÒS•SQ‹ˆœšYÙH›ØœÈ]\Ý™H˜Y[Û›H[™Ø[››ÝY\™ÙK\ÞKÜˆ™[X\ÙKˆ‹ˆ
NÂˆB‚ˆ™]\›ˆØš™XÝ™œ™Y^™JÂˆØÚ[XNˆ˜ÛÙ^XÚ]ÛØØ[ÚKXœšYÙKZ›Ø‹]˜[Y][Û‹ÝŒH‹ˆ˜[YˆYKˆ›Ø’Yˆ˜[YKšYˆYÙ\ÝˆœšYÙQYÙ\Ý
˜[YJKˆ™\ÜÚ]ÜžNˆ˜[YK\™Ù]œ™\ÜÚ]ÜžKˆ˜\ÙTÚNˆ˜[YK\™Ù]˜˜\ÙWÜÚKˆ\ÚÕ\Nˆ˜[YK\Ú×Ý\Kˆ[ÙNˆ˜[YK›[ÙKˆJNÂŸB‚™^Ü\Þ[˜È[˜Ý[Ûˆ˜[Y]PœšYÙR›Ø‘š[Jš[T]^XÝ][ÛœÊHÂˆ™]\›ˆ˜[Y]PœšYÙR›ØŠˆ]ØZ]™XYœšYÙRœÛÛŠš[T]“Ð—ÓPVÐ–UTË˜œšYÙH›ØˆŠKˆ^XÝ][ÛœËˆ
NÂŸB‚™^Ü[˜Ý[Ûˆ˜[Y]PœšYÙT™\Ý[
˜[YK›Ø‹^XÝ][ÛœÊHÂˆ^XÝØš™XÝ
ˆ^XÝ][ÛœËˆÈšXYÚH‹œ[™\]Y\Ý[X™\ˆ—Kˆœ™\Ý[^XÝ][ÛœÈ‹ˆ
NÂˆYˆ
^XÝ][ÛœËšXYÚHOOH[
HÂˆÝš[™ÑšY[
^XÝ][ÛœËšXYÚK™^XÝYXYÒH‹ÂˆZ[ŽˆˆX^ˆˆ]\›ŽˆÓÓSRUÔÒKˆJNÂˆBˆYˆ
^XÝ][ÛœËœ[™\]Y\Ý[X™\ˆOOH[
HÂˆ[YÙ\‘šY[
ˆ^XÝ][ÛœËœ[™\]Y\Ý[X™\‹ˆ™^XÝY[™\]Y\Ý[X™\ˆ‹ˆKˆ[X™\‹“PVÔÐQ‘WÒS•QÑT‹ˆ
NÂˆB‚ˆ^XÝØš™XÝ
˜[YKÂˆœØÚ[XH‹š›Ø—ÚY‹š›Ø—Ùš[™Ù\œš[‹˜ÛÛ\]YØ]‹œÝ]\È‹ˆ\™Ù]‹œ[Ü™\]Y\Ý‹™\šYšXØ][Ûˆ‹œ™[X\ÙWÜ™XÛÛ[Y[™][Ûˆ‹ˆœØY™]H‹ˆK˜œšYÙH™\Ý[ŠNÂˆYˆ
˜[YKœØÚ[XHOOH›ØØ[ÚKXœšYÙKÜ™\Ý[ÝŒHŠHÂˆ˜Z[
“ÐÐSÒWÐ”’QÑWÔÐÒSPWÒS•SQ‹•[œÝ\ÜYœšYÙH™\Ý[ØÚ[XKˆŠNÂˆBˆYˆ
˜[YKš›Ø—ÚYOOH›Ø‹š›Ø’Y˜[YKš›Ø—Ùš[™Ù\œš[OOH›Ø‹™YÙ\Ý
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÒ“Ð—ÓRTÓPUÒ‹ˆ”™\Ý[Ù\È›Ýš[™H˜[Y]YœšYÙH›Ø‹ˆ‹ˆ
NÂˆBˆ]Õ[Y\Ý[\
˜[YK˜ÛÛ\]YØ]œ™\Ý[˜ÛÛ\]YØ]ŠNÂˆ[[QšY[
ˆ˜[YKœÝ]\ËˆÈ››ËXXÝ[Ûˆ‹˜›ØÚÙY‹™˜Y\‹[Ü[ˆ‹™˜Z[Y—Kˆœ™\Ý[œÝ]\È‹ˆ
NÂ‚ˆ^XÝØš™XÝ
ˆ˜[YK\™Ù]ˆÈœ™\ÜÚ]ÜžH‹˜˜\ÙWÜÚH‹šXYÜÚH—Kˆœ™\Ý[\™Ù]‹ˆ
NÂˆYˆ
ˆ˜[YK\™Ù]œ™\ÜÚ]ÜžHOOH›Ø‹œ™\ÜÚ]ÜžHˆ˜[YK\™Ù]˜˜\ÙWÜÚHOOH›Ø‹˜˜\ÙTÚBˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÕT‘ÑUÓRTÓPUÒ‹ˆ”™\Ý[\™Ù]Ù\È›Ýš[™H˜[Y]YœšYÙH›Ø‹ˆ‹ˆ
NÂˆBˆYˆ
˜[YK\™Ù]šXYÜÚHOOH[
HÂˆÝš[™ÑšY[
˜[YK\™Ù]šXYÜÚKœ™\Ý[\™Ù]šXYÜÚH‹ÂˆZ[ŽˆˆX^ˆˆ]\›ŽˆÓÓSRUÔÒKˆJNÂˆBˆYˆ
ˆ^XÝ][ÛœËšXYÚHOOH[	‰‚ˆ˜[YK\™Ù]šXYÜÚHOOH^XÝ][ÛœËšXYÚBˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÒPQÓRTÓPUÒ‹ˆ”™\Ý[XYÒHY™™\œÈœ›ÛHH[™\[™[HÝ\YYˆXYˆ‹ˆ
NÂˆB‚ˆYˆ
˜[YKœ[Ü™\]Y\ÝOOH[
HÂˆ^XÝØš™XÝ
ˆ˜[YKœ[Ü™\]Y\ÝˆÈ›[X™\ˆ‹\›‹™˜Y‹›Y\™ÙXXš[]H‹˜ÚWÜÝ]H—Kˆœ™\Ý[œ[Ü™\]Y\Ý‹ˆ
NÂˆ[YÙ\‘šY[
ˆ˜[YKœ[Ü™\]Y\Ý›[X™\‹ˆœ™\Ý[œ[Ü™\]Y\Ý›[X™\ˆ‹ˆKˆ[X™\‹“PVÔÐQ‘WÒS•QÑT‹ˆ
NÂˆÛÛœÝX]ÚHÝš[™ÑšY[
˜[YKœ[Ü™\]Y\Ý\›œ™\Ý[œ[Ü™\]Y\Ý\›‹ÂˆX^ˆLˆ]\›ŽˆT“ˆJK›X]Ú
T“
NÂˆYˆ
ˆ˜[YKœ[Ü™\]Y\Ý™˜YOOHYHˆ	ÛX]ÚÌW_KÉÛX]ÚÌ—_XOOH›Ø‹œ™\ÜÚ]ÜžHˆ[X™\ŠX]ÚÌ×JHOOH˜[YKœ[Ü™\]Y\Ý›[X™\‚ˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔ—ÒS•SQ‹ˆ”™\Ý[[™\]Y\ÝY[]H\È[˜[YÜˆ\È›ÝH˜Yˆ‹ˆ
NÂˆBˆ[[QšY[
ˆ˜[YKœ[Ü™\]Y\Ý›Y\™ÙXXš[]KˆÈ›Y\™ÙXX›H‹˜ÛÛ™›XÝ[™È‹[šÛ›ÝÛˆ—Kˆœ™\Ý[œ[Ü™\]Y\Ý›Y\™ÙXXš[]H‹ˆ
NÂˆ[[QšY[
ˆ˜[YKœ[Ü™\]Y\Ý˜ÚWÜÝ]KˆÈœ[™[™È‹œÝXØÙ\ÜÈ‹™˜Z[\™H‹[šÛ›ÝÛˆ—Kˆœ™\Ý[œ[Ü™\]Y\Ý˜ÚWÜÝ]H‹ˆ
NÂˆBˆYˆ
ˆ˜[YKœÝ]\ÈOOH™˜Y\‹[Ü[ˆˆ	‰‚ˆ
˜[YKœ[Ü™\]Y\ÝOOH[˜[YK\™Ù]šXYÜÚHOOH[
Bˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔ—ÓRTÔÒS‘È‹ˆ‘˜YTˆ™\Ý[È™\]Z\™Hˆ[™XYTÒH]šY[˜ÙKˆ‹ˆ
NÂˆBˆYˆ
˜[YKœÝ]\ÈOOH™˜Y\‹[Ü[ˆˆ	‰ˆ˜[YKœ[Ü™\]Y\ÝOOH[
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔ—ÕS‘VPÕQ‹ˆ“Û›H˜Y\‹[Ü[ˆ™\Ý[ÈX^HÛÛZ[ˆH[™\]Y\Ýˆ‹ˆ
NÂˆBˆYˆ
ˆ^XÝ][ÛœËœ[™\]Y\Ý[X™\ˆOOH[	‰‚ˆ˜[YKœ[Ü™\]Y\ÝË›[X™\ˆOOH^XÝ][ÛœËœ[™\]Y\Ý[X™\‚ˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔ—ÓRTÓPUÒ‹ˆ”™\Ý[[™\]Y\Ý[X™\ˆY™™\œÈœ›ÛHH[™\[™[^XÝ][Û‹ˆ‹ˆ
NÂˆB‚ˆYˆ
P\œ˜^Kš\Ð\œ˜^J˜[YK™\šYšXØ][ÛŠH˜[YK™\šYšXØ][Û‹›[™ÝˆÌ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÕ‘T’Q’PÐUSÓ—ÒS•SQ‹ˆ”™\Ý[™\šYšXØ][Ûˆ]šY[˜ÙH\È[˜[Yˆ‹ˆ
NÂˆBˆ›Üˆ
ÛÛœÝÚXÚÈÙˆ˜[YK™\šYšXØ][ÛŠHÂˆ^XÝØš™XÝ
ÚXÚËÈ›˜[YH‹œÝ]\È‹™]šY[˜ÙH—K™\šYšXØ][ÛˆÚXÚÈŠNÂˆÝš[™ÑšY[
ÚXÚË›˜[YK™\šYšXØ][Û‹›˜[YH‹ÈX^ˆLŒJNÂˆ[[QšY[
ˆÚXÚËœÝ]\ËˆÈœÝXØÙ\ÜÈ‹™˜Z[\™H‹œÚÚ\Y‹œ[™[™È—Kˆ™\šYšXØ][Û‹œÝ]\È‹ˆ
NÂˆÝš[™ÑšY[
ÚXÚË™]šY[˜ÙK™\šYšXØ][Û‹™]šY[˜ÙH‹ÂˆZ[ŽˆˆX^ˆLˆJNÂˆBˆ[[QšY[
ˆ˜[YKœ™[X\ÙWÜ™XÛÛ[Y[™][Û‹ˆÈ™Ë[›Ý\™[X\ÙH‹›™YYË[™]Ë[XXË\™]šY]È‹˜›ØÚÙY—Kˆœ™\Ý[œ™[X\ÙWÜ™XÛÛ[Y[™][Ûˆ‹ˆ
NÂˆYˆ
ˆ˜[YKœ™[X\ÙWÜ™XÛÛ[Y[™][ÛˆOOH›™YYË[™]Ë[XXË\™]šY]Èˆ	‰‚ˆ˜[YKœÝ]\ÈOOH™˜Y\‹[Ü[ˆ‚ˆ
HÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔ‘PÓÓSQS‘USÓ—ÒS•SQ‹ˆ“Û›HH˜YˆØ[ˆ™\]Y\Ý™]ËSXXÈ™]šY]Ëˆ‹ˆ
NÂˆB‚ˆ^XÝØš™XÝ
ˆ˜[YKœØY™]KˆÈ™ÛXZ[Û]]]Y‹›Y\™ÙY‹™\ÞYY‹œ™[X\ÙY‹œ›ÙXÝ[Û—ØXØÙ\ÜÙY—Kˆœ™\Ý[œØY™]H‹ˆ
NÂˆYˆ
Øš™XÝ˜[Y\Ê˜[YKœØY™]JKœÛÛYJ
šY[
HOˆšY[OOH˜[ÙJJHÂˆ˜Z[
ˆ“ÐÐSÒWÐ”’QÑWÔ‘TÕSÔÐQ‘UWÒS•SQ‹ˆœšYÙH™\Ý[ÈØ[››ÝÛZ[H[ˆ[œØY™H]]][Û‹ˆ‹ˆ
NÂˆB‚ˆ™]\›ˆØš™XÝ™œ™Y^™JÂˆØÚ[XNˆ˜ÛÙ^XÚ]ÛØØ[ÚKXœšYÙK\™\Ý[]˜[Y][Û‹ÝŒH‹ˆ˜[YˆYKˆ›Ø’Yˆ›Ø‹š›Ø’Yˆ›Ø‘YÙ\Ýˆ›Ø‹™YÙ\Ýˆ™\Ý[YÙ\ÝˆœšYÙQYÙ\Ý
˜[YJKˆ™\ÜÚ]ÜžNˆ˜[YK\™Ù]œ™\ÜÚ]ÜžKˆ˜\ÙTÚNˆ˜[YK\™Ù]˜˜\ÙWÜÚKˆXYÚNˆ˜[YK\™Ù]šXYÜÚKˆ[™\]Y\Ý[X™\Žˆ˜[YKœ[Ü™\]Y\ÝË›[X™\ˆÏÈ[ˆÚTÝ]Nˆ˜[YKœ[Ü™\]Y\ÝË˜ÚWÜÝ]HÏÈ[ˆ™[X\ÙT™XÛÛ[Y[™][ÛŽˆ˜[YKœ™[X\ÙWÜ™XÛÛ[Y[™][Û‹ˆXÝ[Û]]Üš^™Yˆ˜[ÙKˆY\™ÙP]]Üš^™Yˆ˜[ÙKˆ\Þ[Y[]]Üš^™Yˆ˜[ÙKˆ™[X\ÙP]]Üš^™Yˆ˜[ÙKˆJNÂŸB‚™^Ü\Þ[˜È[˜Ý[Ûˆ˜[Y]PœšYÙT™\Ý[š[Jˆ™\Ý[]ˆ˜[Y]Y›Ø‹ˆ^XÝ][ÛœËŠHÂˆ™]\›ˆ˜[Y]PœšYÙT™\Ý[
ˆ]ØZ]™XYœšYÙRœÛÛŠ™\Ý[]‘TÕSÓPVÐ–UTË˜œšYÙH™\Ý[ŠKˆ˜[Y]Y›Ø‹ˆ^XÝ][ÛœËˆ
NÂŸB