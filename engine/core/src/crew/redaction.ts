/**
 * Secret and machine-path detection shared by the experience ledger (nothing
 * secret-shaped may become a durable lesson) and the crew-pack exporter
 * (nothing secret-shaped may leave the machine — fail closed, list findings).
 *
 * Deliberately pattern-based and conservative: a false positive costs the user
 * one masked string or one export retry; a false negative ships a credential.
 */

export interface RedactionFinding {
  /** Which logical surface the match was found in (e.g. "rolePrompt", "docs/ARCH.md"). */
  where: string;
  /** The matched text, pre-masked for safe display (first 4 chars + …). */
  sample: string;
  kind: "secret" | "absolute-path";
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/DeepInfra/Anthropic-style keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}/gi, // key = value
];

const ABSOLUTE_PATH_PATTERNS: RegExp[] = [
  /\b[A-Za-z]:\\[^\s"'<>|*?]{2,}/g, // Windows drive paths
  /(?:^|[\s"'`(])(\/(?:home|Users)\/[^\s"'<>|*?]{2,})/g, // POSIX home paths
];

function mask(match: string): string {
  return match.length <= 8 ? `${match.slice(0, 2)}…` : `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`;
}

/** Scans one text surface; `where` labels findings for the user. */
export function scanForSecrets(where: string, text: string): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      findings.push({ where, sample: mask(m[0]), kind: "secret" });
    }
  }
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      findings.push({ where, sample: mask(m[1] ?? m[0]), kind: "absolute-path" });
    }
  }
  return findings;
}

/** True when the text contains anything secret-shaped (cheap gate for lesson validation). */
export function looksSecret(text: string): boolean {
  return scanForSecrets("", text).some((f) => f.kind === "secret");
}

/** True when the text embeds a machine-absolute path (lessons must stay machine-neutral). */
export function hasAbsolutePath(text: string): boolean {
  return scanForSecrets("", text).some((f) => f.kind === "absolute-path");
}

/** Masks every secret-shaped match in place (the `redact` export escape hatch). */
export function redactText(text: string): string {
  let out = text;
  for (const re of [...SECRET_PATTERNS]) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}
