/** Utilitários para períodos YYYY-MM (mensalidades). */

export function yearMonthFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function currentYearMonthLocal(): string {
  return yearMonthFromDate(new Date());
}

export function minYearMonth(a: string, b: string): string {
  return a <= b ? a : b;
}

export function prevYearMonth(ym: string): string {
  const [y, mo] = ym.split("-").map(Number);
  if (!y || !mo) throw new Error(`Ano-mês inválido: ${ym}`);
  if (mo === 1) return `${y - 1}-12`;
  return `${y}-${String(mo - 1).padStart(2, "0")}`;
}

export function* iterateYearMonths(fromYm: string, toYmInclusive: string): Generator<string> {
  const [y0, m0] = fromYm.split("-").map(Number);
  const [y1, m1] = toYmInclusive.split("-").map(Number);
  if (!y0 || !m0 || !y1 || !m1) return;
  let cy = y0;
  let cm = m0;
  for (;;) {
    const cur = `${cy}-${String(cm).padStart(2, "0")}`;
    if (cur > toYmInclusive) break;
    yield cur;
    if (cy === y1 && cm === m1) break;
    cm += 1;
    if (cm > 12) {
      cm = 1;
      cy += 1;
    }
  }
}

/** Meses anteriores ao mês visualizado, até hoje, sem pagamento — para aviso de atraso. */
export function pastUnpaidStats(
  joinYm: string,
  viewedPeriodYm: string,
  todayYm: string,
  paidMonths: Set<string>,
): { count: number; oldest: string | null } {
  const pastEnd = minYearMonth(prevYearMonth(viewedPeriodYm), todayYm);
  if (pastEnd < joinYm) return { count: 0, oldest: null };
  let count = 0;
  let oldest: string | null = null;
  for (const ym of iterateYearMonths(joinYm, pastEnd)) {
    if (!paidMonths.has(ym)) {
      count += 1;
      oldest ??= ym;
    }
  }
  return { count, oldest };
}

/** Primeiro mês em aberto entre a entrada no grupo e o teto (mês visualizado ou mês atual). */
export function findOldestUnpaidPeriod(
  joinYm: string,
  obligationEndYm: string,
  paidMonths: Set<string>,
): string | null {
  if (obligationEndYm < joinYm) return null;
  for (const ym of iterateYearMonths(joinYm, obligationEndYm)) {
    if (!paidMonths.has(ym)) return ym;
  }
  return null;
}
