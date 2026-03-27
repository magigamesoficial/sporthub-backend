import {
  AttendanceStatus,
  GameOutcome,
  GameTeamSide,
  type Sport,
} from "@prisma/client";
import { resultAndScoutUnlocked } from "./gameUnlock";
import { prisma } from "./prisma";

type CountResult = { w: number; d: number; l: number; pts: number };

export function rowResultForRanking(
  game: {
    teamAScore: number | null;
    teamBScore: number | null;
    outcome: GameOutcome | null;
    startsAt: Date;
  },
  att: { status: AttendanceStatus; teamSide: GameTeamSide | null },
  now: Date,
): CountResult | null {
  if (att.status !== AttendanceStatus.GOING) return null;
  if (!resultAndScoutUnlocked(game.startsAt, now)) return null;

  if (game.teamAScore !== null && game.teamBScore !== null) {
    if (!att.teamSide) return null;
    const a = game.teamAScore;
    const b = game.teamBScore;
    if (a === b) return { w: 0, d: 1, l: 0, pts: 1 };
    const aWins = a > b;
    const won =
      (att.teamSide === GameTeamSide.TEAM_A && aWins) ||
      (att.teamSide === GameTeamSide.TEAM_B && !aWins);
    if (won) return { w: 1, d: 0, l: 0, pts: 3 };
    return { w: 0, d: 0, l: 1, pts: 0 };
  }

  if (game.outcome) {
    if (game.outcome === GameOutcome.WIN) return { w: 1, d: 0, l: 0, pts: 3 };
    if (game.outcome === GameOutcome.DRAW) return { w: 0, d: 1, l: 0, pts: 1 };
    return { w: 0, d: 0, l: 1, pts: 0 };
  }

  return null;
}

export type RankingRowComputed = {
  userId: string;
  fullName: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  winRate: number;
  scouts: Record<string, number>;
};

export type GroupRankingSnapshot = {
  group: { id: string; name: string; sport: Sport };
  metrics: { id: string; key: string; label: string }[];
  rows: RankingRowComputed[];
};

/** Ordem igual à classificação padrão por pontos no front (desempate estável). */
export function sortRankingRowsByStanding(rows: RankingRowComputed[]): RankingRowComputed[] {
  return [...rows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.draws !== a.draws) return b.draws - a.draws;
    if (a.losses !== b.losses) return a.losses - b.losses;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return a.fullName.localeCompare(b.fullName, "pt-BR", { sensitivity: "base" });
  });
}

/**
 * Calcula classificação do grupo (mesma regra que GET /groups/:id/ranking).
 * Não verifica se o chamador é membro — use apenas após autorização.
 */
export async function computeGroupRankingSnapshot(
  groupId: string,
  now: Date,
): Promise<GroupRankingSnapshot | null> {
  const [group, members, games, enabledRows, allStats] = await Promise.all([
    prisma.group.findUnique({
      where: { id: groupId },
      select: { sport: true, name: true },
    }),
    prisma.groupMember.findMany({
      where: { groupId },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    }),
    prisma.groupGame.findMany({
      where: { groupId, startsAt: { lt: now } },
      select: {
        id: true,
        startsAt: true,
        outcome: true,
        teamAScore: true,
        teamBScore: true,
      },
      orderBy: { startsAt: "desc" },
    }),
    prisma.groupEnabledScout.findMany({
      where: { groupId },
      select: { scoutMetricDefinitionId: true },
    }),
    prisma.gameScoutStat.findMany({
      where: { game: { groupId } },
      select: {
        gameId: true,
        userId: true,
        scoutMetricDefinitionId: true,
        value: true,
        game: { select: { startsAt: true } },
      },
    }),
  ]);

  if (!group) {
    return null;
  }

  const enabledIds = enabledRows.map((r) => r.scoutMetricDefinitionId);
  const metricDefs =
    enabledIds.length > 0
      ? await prisma.scoutMetricDefinition.findMany({
          where: {
            sport: group.sport,
            id: { in: enabledIds },
            isActive: true,
          },
          orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
        })
      : [];

  const gameIds = new Set(games.map((g) => g.id));
  const attendances = await prisma.gameAttendance.findMany({
    where: { gameId: { in: [...gameIds] } },
  });
  const attByGameUser = new Map<string, (typeof attendances)[0]>();
  for (const a of attendances) {
    attByGameUser.set(`${a.gameId}:${a.userId}`, a);
  }

  const gameById = new Map(games.map((g) => [g.id, g]));

  const acc = new Map<
    string,
    { wins: number; draws: number; losses: number; points: number; gamesRanked: number }
  >();
  for (const m of members) {
    acc.set(m.userId, { wins: 0, draws: 0, losses: 0, points: 0, gamesRanked: 0 });
  }

  for (const g of games) {
    for (const mem of members) {
      const att = attByGameUser.get(`${g.id}:${mem.userId}`);
      if (!att) continue;
      const rr = rowResultForRanking(g, att, now);
      if (!rr) continue;
      const cur = acc.get(mem.userId)!;
      cur.gamesRanked += 1;
      cur.wins += rr.w;
      cur.draws += rr.d;
      cur.losses += rr.l;
      cur.points += rr.pts;
    }
  }

  const scoutTotals = new Map<string, Map<string, number>>();
  for (const m of members) {
    scoutTotals.set(m.userId, new Map());
    for (const def of metricDefs) {
      scoutTotals.get(m.userId)!.set(def.id, 0);
    }
  }

  const activeScoutDefIds = new Set(metricDefs.map((d) => d.id));
  for (const s of allStats) {
    const gMeta = gameById.get(s.gameId);
    if (!gMeta) continue;
    if (gMeta.startsAt >= now) continue;
    if (!enabledIds.includes(s.scoutMetricDefinitionId)) continue;
    if (!activeScoutDefIds.has(s.scoutMetricDefinitionId)) continue;
    const um = scoutTotals.get(s.userId);
    if (!um) continue;
    const prev = um.get(s.scoutMetricDefinitionId) ?? 0;
    um.set(s.scoutMetricDefinitionId, prev + s.value);
  }

  const rows: RankingRowComputed[] = members.map((m) => {
    const a = acc.get(m.userId)!;
    const g = a.gamesRanked;
    const winRate =
      g === 0 ? 0 : Math.round(((a.points / (3 * g)) * 100 + Number.EPSILON) * 100) / 100;
    const scouts: Record<string, number> = {};
    const sm = scoutTotals.get(m.userId);
    if (sm) {
      for (const def of metricDefs) {
        scouts[def.id] = sm.get(def.id) ?? 0;
      }
    }
    return {
      userId: m.userId,
      fullName: m.user.fullName,
      games: g,
      wins: a.wins,
      draws: a.draws,
      losses: a.losses,
      points: a.points,
      winRate,
      scouts,
    };
  });

  return {
    group: { id: groupId, name: group.name, sport: group.sport },
    metrics: metricDefs.map((d) => ({
      id: d.id,
      key: d.key,
      label: d.label,
    })),
    rows,
  };
}
