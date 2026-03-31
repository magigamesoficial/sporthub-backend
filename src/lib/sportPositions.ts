import { Sport } from "@prisma/client";

export type SportPositionOption = { value: string; label: string };

/** Posições exibidas conforme o esporte do grupo (valor gravado em `GroupMember.positionKey`). */
export const SPORT_POSITIONS: Record<Sport, SportPositionOption[]> = {
  FOOTBALL: [
    { value: "GOALKEEPER", label: "Goleiro" },
    { value: "DEFENDER", label: "Zagueiro" },
    { value: "FULLBACK", label: "Lateral" },
    { value: "DEFENSIVE_MID", label: "Volante" },
    { value: "MIDFIELDER", label: "Meia" },
    { value: "FORWARD", label: "Atacante" },
    { value: "FLEX", label: "Versátil / várias posições" },
  ],
  VOLLEYBALL: [
    { value: "SETTER", label: "Levantador" },
    { value: "OPPOSITE", label: "Oposto" },
    { value: "MIDDLE", label: "Central" },
    { value: "OUTSIDE", label: "Ponteiro" },
    { value: "LIBERO", label: "Líbero" },
    { value: "FLEX", label: "Versátil" },
  ],
  BEACH_TENNIS: [
    { value: "LEFT", label: "Lado esquerdo" },
    { value: "RIGHT", label: "Lado direito" },
    { value: "FLEX", label: "Indiferente / rotação" },
  ],
  PADEL: [
    { value: "DRIVE", label: "Drive (direita)" },
    { value: "BACKHAND", label: "Revés" },
    { value: "FLEX", label: "Ambos / indiferente" },
  ],
  FUTVOLEI: [
    { value: "SETTER", label: "Levantador" },
    { value: "FIXO", label: "Fixo" },
    { value: "OUTSIDE", label: "Ponteiro" },
    { value: "FLEX", label: "Versátil" },
  ],
  BASKETBALL: [
    { value: "POINT_GUARD", label: "Armador" },
    { value: "SHOOTING_GUARD", label: "Ala-armador" },
    { value: "SMALL_FORWARD", label: "Ala" },
    { value: "POWER_FORWARD", label: "Ala-pivô" },
    { value: "CENTER", label: "Pivô" },
    { value: "FLEX", label: "Versátil" },
  ],
};

export function positionsForSport(sport: Sport): SportPositionOption[] {
  return SPORT_POSITIONS[sport];
}

export function isValidPositionKey(
  sport: Sport,
  key: string | null | undefined,
): boolean {
  if (key == null || key === "") return true;
  return SPORT_POSITIONS[sport].some((p) => p.value === key);
}

/** Rótulo em português para exibir na escalação / sorteio; desconhecido → null. */
export function positionLabelForSport(
  sport: Sport,
  key: string | null | undefined,
): string | null {
  if (key == null || key === "") return null;
  const found = SPORT_POSITIONS[sport].find((p) => p.value === key);
  return found?.label ?? null;
}
