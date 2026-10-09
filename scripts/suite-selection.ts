/**
 * Case selection for the industrial suite (scripts/industrial-suite.ts), kept free of side effects so it is tested
 * without starting any tool. Runs before any case does.
 *
 * PAI_SUITE_ONLY=X1,P1 runs only the named cases; PAI_SUITE_SKIP=D2 runs every other case (CI runs the long CAM case
 * in a parallel job). A named case that is not available here (e.g. D2 without the CAM toolchain) is an error, and so
 * is a selection that leaves nothing to run (ONLY=D2 with SKIP=D2, or every case skipped): zero cases is never a pass.
 */
export interface Selection { only: string[] | null; skip: string[] | null; available: number }

const ids = (value: string | undefined) => {
  const list = value?.split(",").map(x => x.trim()).filter(Boolean);
  return list?.length ? list : null;
};

export function selectCases<T extends { id: string }>(cases: readonly T[], env: Record<string, string | undefined>): { selected: T[]; selection: Selection } {
  const only = ids(env.PAI_SUITE_ONLY), skip = ids(env.PAI_SUITE_SKIP);
  const unknown = [...(only ?? []), ...(skip ?? [])].filter(id => !cases.some(c => c.id === id));
  if (unknown.length) throw new Error(`Suite cases not available in this environment: ${unknown.join(", ")}`);
  const selected = cases.filter(c => (!only || only.includes(c.id)) && !skip?.includes(c.id));
  if (!selected.length) {
    throw new Error(`Suite selection is empty (only: ${only?.join(",") ?? "all"}; skip: ${skip?.join(",") ?? "none"}; ${cases.length} available); refusing to report a pass with no cases`);
  }
  return { selected, selection: { only, skip, available: cases.length } };
}

/** "passed" needs at least one case and every case passing. */
export const suiteResult = (results: readonly { passed: boolean }[]) => results.length > 0 && results.every(r => r.passed) ? "passed" : "failed";
