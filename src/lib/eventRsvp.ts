import type { Group } from "@prisma/client";

/** Vagas com confirmação automática «Sim» (ex.: 22 máx − 2 reservadas = 20). */
export function computeAutoGoingCap(
  maxParticipants: number | null | undefined,
  reservedSlots: number | null | undefined,
): number {
  if (maxParticipants == null) return Number.POSITIVE_INFINITY;
  const r = Math.max(0, reservedSlots ?? 0);
  return Math.max(0, maxParticipants - r);
}

export function isPastRsvpDeadline(
  now: Date,
  gameStartsAt: Date,
  deadlineHours: number | null | undefined,
): boolean {
  if (deadlineHours == null || deadlineHours <= 0) return false;
  const ms = deadlineHours * 3600 * 1000;
  return now.getTime() >= gameStartsAt.getTime() - ms;
}

export function eventSettingsDeadlineAt(
  gameStartsAt: Date,
  deadlineHours: number | null | undefined,
): string | null {
  if (deadlineHours == null || deadlineHours <= 0) return null;
  return new Date(gameStartsAt.getTime() - deadlineHours * 3600 * 1000).toISOString();
}

export type GroupEventRsvpFields = Pick<
  Group,
  | "rsvpAllowMaybe"
  | "rsvpDeadlineHoursBeforeStart"
  | "eventMaxParticipants"
  | "eventReservedSlots"
>;
