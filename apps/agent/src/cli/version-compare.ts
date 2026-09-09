/**
 * Lightweight version compare for coding-CLI update prompts.
 * Mirrors cc-switch semantics: only treat "latest strictly newer than local" as updateable.
 * Supports classic semver and Cursor-style calendar builds (YYYY.MM.DD[-hash]).
 */

type ParsedVersion = {
  kind: "semver" | "calendar";
  core: [number, number, number];
  pre: string[];
};

function parseVersion(raw: string): ParsedVersion | null {
  const v = raw.trim().replace(/^v/i, "").split(/\s+/)[0] ?? "";
  if (!v) return null;

  const calendar = v.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+]([0-9A-Za-z.-]+))?$/);
  if (calendar && Number(calendar[1]) >= 2000) {
    return {
      kind: "calendar",
      core: [Number(calendar[1]), Number(calendar[2]), Number(calendar[3])],
      pre: calendar[4] ? calendar[4].split(".") : []
    };
  }

  const coreAndPre = v.split("+")[0] ?? "";
  const dash = coreAndPre.indexOf("-");
  const core = dash >= 0 ? coreAndPre.slice(0, dash) : coreAndPre;
  const preRaw = dash >= 0 ? coreAndPre.slice(dash + 1) : "";
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
  if (parts.length > 3) return null;
  return {
    kind: "semver",
    core: [major, minor, patch],
    pre: preRaw ? preRaw.split(".") : []
  };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i] ?? "";
    const bi = b[i] ?? "";
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** >0 if a newer than b; <0 if older; 0 if equal or incomparable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb || pa.kind !== pb.kind) return 0;
  for (let i = 0; i < 3; i += 1) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** True only when latest is strictly newer than current. */
export function isUpdateAvailable(
  current: string | null | undefined,
  latest: string | null | undefined
): boolean {
  if (!current || !latest) return false;
  return compareVersions(latest, current) > 0;
}

/** Strip branding noise so compareVersions can parse CLI --version output. */
export function normalizeVersionLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const calendar = text.match(/(\d{4}\.\d{1,2}\.\d{1,2}(?:[-+][0-9A-Za-z.-]+)?)/);
  if (calendar?.[1] && Number(calendar[1].slice(0, 4)) >= 2000) return calendar[1];
  const semver = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return semver?.[1] ?? text.split(/\s+/)[0];
}
