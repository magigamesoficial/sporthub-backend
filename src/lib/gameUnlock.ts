/** 1 minuto após o horário marcado: libera placar, times e scouts (regra de produto). */
export const RESULT_AND_SCOUT_UNLOCK_MS = 60_000;

export function resultAndScoutUnlocked(startsAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= startsAt.getTime() + RESULT_AND_SCOUT_UNLOCK_MS;
}

export function resultAndScoutUnlockIso(startsAt: Date): string {
  return new Date(startsAt.getTime() + RESULT_AND_SCOUT_UNLOCK_MS).toISOString();
}
