/**
 * Count comparison for bars (V3 CH-10). Pure. Widths are true proportions of
 * the larger value, so neither bar is clipped and an overage is visible.
 */
export type CountComparison = {
  billed: { value: number; widthPct: number };
  documented: { value: number; widthPct: number };
  relation: "EQUAL" | "FEWER_DOCUMENTED" | "MORE_DOCUMENTED";
  difference: number;
};

export function compareCounts(billedLines: number, documentedVisits: number | null): CountComparison | null {
  if (documentedVisits === null || !Number.isInteger(documentedVisits) || !Number.isInteger(billedLines) || documentedVisits < 0 || billedLines < 0) return null;
  const max = Math.max(billedLines, documentedVisits);
  const pct = (v: number) => (max === 0 ? 0 : Math.round((v / max) * 1000) / 10);
  return {
    billed: { value: billedLines, widthPct: pct(billedLines) },
    documented: { value: documentedVisits, widthPct: pct(documentedVisits) },
    relation: documentedVisits === billedLines ? "EQUAL" : documentedVisits < billedLines ? "FEWER_DOCUMENTED" : "MORE_DOCUMENTED",
    difference: Math.abs(billedLines - documentedVisits),
  };
}

export function comparisonSentence(c: CountComparison): string {
  if (c.relation === "EQUAL") return "The counts match. They measure different things, so this does not prove the therapy was completed.";
  const word = c.difference === 1 ? "visit" : "visits";
  return c.relation === "FEWER_DOCUMENTED"
    ? `The summary documents ${c.difference} fewer ${word} than the claims bill. A person should check why.`
    : `The summary documents ${c.difference} more ${word} than the claims bill. A person should check why.`;
}
