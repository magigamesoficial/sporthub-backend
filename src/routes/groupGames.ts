import {
  AttendanceStatus,
  GameKind,
  GameOutcome,
  GameTeamSide,
  GroupMemberRole,
  Prisma,
} from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  computeAutoGoingCap,
  isPastRsvpDeadline,
  eventSettingsDeadlineAt,
} from "../lib/eventRsvp";
import { positionLabelForSport } from "../lib/sportPositions";
import { RESULT_AND_SCOUT_UNLOCK_MS, resultAndScoutUnlocked } from "../lib/gameUnlock";
import { canAssignGameTeams, canManageGroupGames } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupGamesRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

const createGameSchema = z.object({
  kind: z.nativeEnum(GameKind).optional(),
  title: z.string().trim().min(1, "Título obrigatório").max(120).optional(),
  location: z.union([z.string().trim().max(200), z.literal("")]).optional(),
  startsAt: z
    .string()
    .min(1, "Data/hora obrigatória")
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "Data/hora inválida (ISO 8601)"),
});

const selfAttendanceBodySchema = z.object({
  status: z.union([
    z.literal(AttendanceStatus.GOING),
    z.literal(AttendanceStatus.NOT_GOING),
    z.literal(AttendanceStatus.MAYBE),
  ]),
});

const moderatorAttendanceBodySchema = z.object({
  status: z.nativeEnum(AttendanceStatus),
});

const patchGameSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("scores"),
    teamAScore: z.number().int().min(0),
    teamBScore: z.number().int().min(0),
  }),
  z.object({
    mode: z.literal("legacy"),
    outcome: z.nativeEnum(GameOutcome),
  }),
  z.object({
    mode: z.literal("clear"),
  }),
  z.object({
    mode: z.literal("details"),
    kind: z.nativeEnum(GameKind),
    title: z.string().trim().max(120),
    location: z.union([z.string().trim().max(200), z.literal("")]),
    startsAt: z
      .string()
      .min(1, "Data/hora obrigatória")
      .refine((s) => !Number.isNaN(new Date(s).getTime()), "Data/hora inválida (ISO 8601)"),
  }),
]);

const teamAssignmentsBodySchema = z.object({
  assignments: z.array(
    z.object({
      userId: z.string().cuid(),
      teamSide: z.union([z.nativeEnum(GameTeamSide), z.null()]),
    }),
  ),
});

const scoutStatRowSchema = z.object({
  userId: z.string().cuid(),
  metricDefinitionId: z.string().cuid(),
  value: z.number().int().min(0),
});

const putScoutStatsSchema = z.object({
  stats: z.array(scoutStatRowSchema),
});

async function requireGroupMember(
  groupId: string,
  userId: string,
): Promise<{ role: GroupMemberRole } | null> {
  const m = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  return m;
}

async function countVoluntaryGoing(
  tx: Prisma.TransactionClient,
  gameId: string,
): Promise<number> {
  return tx.gameAttendance.count({
    where: {
      gameId,
      status: AttendanceStatus.GOING,
      forcedByModerator: false,
    },
  });
}

async function promoteWaitlistForGame(
  tx: Prisma.TransactionClient,
  gameId: string,
  group: { eventMaxParticipants: number | null; eventReservedSlots: number },
): Promise<void> {
  const autoCap = computeAutoGoingCap(group.eventMaxParticipants, group.eventReservedSlots);
  if (!Number.isFinite(autoCap)) {
    await tx.gameAttendance.updateMany({
      where: { gameId, status: AttendanceStatus.WAITLIST },
      data: {
        status: AttendanceStatus.GOING,
        waitlistEnteredAt: null,
        forcedByModerator: false,
        teamSide: null,
      },
    });
    return;
  }
  for (;;) {
    const vol = await countVoluntaryGoing(tx, gameId);
    if (vol >= autoCap) break;
    const next = await tx.gameAttendance.findFirst({
      where: { gameId, status: AttendanceStatus.WAITLIST },
      orderBy: [{ waitlistEnteredAt: "asc" }, { updatedAt: "asc" }],
    });
    if (!next) break;
    await tx.gameAttendance.update({
      where: { id: next.id },
      data: {
        status: AttendanceStatus.GOING,
        waitlistEnteredAt: null,
        forcedByModerator: false,
      },
    });
  }
}

async function enabledScoutMetricIds(groupId: string): Promise<string[]> {
  const rows = await prisma.groupEnabledScout.findMany({
    where: { groupId },
    select: { scoutMetricDefinitionId: true },
  });
  return rows.map((r) => r.scoutMetricDefinitionId);
}

groupGamesRouter.get("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  const rawWhen = req.query.when;
  const whenParam = Array.isArray(rawWhen) ? rawWhen[0] : rawWhen;
  const listWhen = whenParam === "past" ? "past" : "future";
  const now = new Date();

  const whereClause =
    listWhen === "future"
      ? { groupId, startsAt: { gte: now } }
      : { groupId, startsAt: { lt: now } };

  try {
    const games = await prisma.groupGame.findMany({
      where: whereClause,
      orderBy: { startsAt: listWhen === "future" ? "asc" : "desc" },
      take: listWhen === "future" ? 100 : 50,
      include: {
        createdBy: { select: { id: true, fullName: true } },
      },
    });

    const gameIds = games.map((g) => g.id);
    const aggregates =
      gameIds.length === 0
        ? []
        : await prisma.gameAttendance.groupBy({
            by: ["gameId", "status"],
            where: { gameId: { in: gameIds } },
            _count: { _all: true },
          });

    const countMap = new Map<
      string,
      { GOING: number; MAYBE: number; NOT_GOING: number; WAITLIST: number }
    >();
    for (const g of games) {
      countMap.set(g.id, { GOING: 0, MAYBE: 0, NOT_GOING: 0, WAITLIST: 0 });
    }
    for (const row of aggregates) {
      const cur = countMap.get(row.gameId);
      if (!cur) continue;
      if (row.status === AttendanceStatus.GOING) cur.GOING += row._count._all;
      if (row.status === AttendanceStatus.MAYBE) cur.MAYBE += row._count._all;
      if (row.status === AttendanceStatus.NOT_GOING) cur.NOT_GOING += row._count._all;
      if (row.status === AttendanceStatus.WAITLIST) cur.WAITLIST += row._count._all;
    }

    res.json({
      listWhen,
      viewer: {
        canManageGames: canManageGroupGames(member.role),
      },
      games: games.map((g) => ({
        id: g.id,
        title: g.title,
        location: g.location,
        startsAt: g.startsAt.toISOString(),
        outcome: g.outcome,
        teamAScore: g.teamAScore,
        teamBScore: g.teamBScore,
        createdAt: g.createdAt.toISOString(),
        createdBy: g.createdBy
          ? { id: g.createdBy.id, fullName: g.createdBy.fullName }
          : null,
        kind: g.kind,
        counts: countMap.get(g.id) ?? {
          GOING: 0,
          MAYBE: 0,
          NOT_GOING: 0,
          WAITLIST: 0,
        },
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar jogos";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.post("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = createGameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  const startsAt = new Date(parsed.data.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    res.status(400).json({ error: "Data/hora inválida" });
    return;
  }

  const location =
    parsed.data.location === undefined || parsed.data.location === ""
      ? null
      : parsed.data.location;

  try {
    const game = await prisma.groupGame.create({
      data: {
        groupId,
        kind: parsed.data.kind ?? GameKind.MATCH,
        title: parsed.data.title?.trim() || "Jogo",
        location,
        startsAt,
        createdByUserId: userId,
      },
    });

    res.status(201).json({
      game: {
        id: game.id,
        kind: game.kind,
        title: game.title,
        location: game.location,
        startsAt: game.startsAt.toISOString(),
        createdAt: game.createdAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao criar jogo";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.get("/:gameId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    const game = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        group: {
          select: {
            rsvpAllowMaybe: true,
            rsvpDeadlineHoursBeforeStart: true,
            eventMaxParticipants: true,
            eventReservedSlots: true,
            eventReservedSlotsPositionKey: true,
            sport: true,
          },
        },
      },
    });
    if (!game) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }

    const groupSport = game.group.sport;

    const [members, attendances, enabledIds, statRows] = await Promise.all([
      prisma.groupMember.findMany({
        where: { groupId },
        include: { user: { select: { id: true, fullName: true, phone: true } } },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.gameAttendance.findMany({
        where: { gameId },
      }),
      enabledScoutMetricIds(groupId),
      prisma.gameScoutStat.findMany({
        where: { gameId },
      }),
    ]);

    const statMetricIds = [...new Set(statRows.map((s) => s.scoutMetricDefinitionId))];
    const defIdsForUi = [...new Set([...enabledIds, ...statMetricIds])];

    const metricDefs =
      defIdsForUi.length > 0
        ? await prisma.scoutMetricDefinition.findMany({
            where: { sport: groupSport, id: { in: defIdsForUi } },
            orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
          })
        : [];

    const attByUser = new Map(attendances.map((a) => [a.userId, a]));

    const statsByUser = new Map<string, { metricId: string; value: number }[]>();
    for (const s of statRows) {
      if (!statsByUser.has(s.userId)) statsByUser.set(s.userId, []);
      statsByUser.get(s.userId)!.push({
        metricId: s.scoutMetricDefinitionId,
        value: s.value,
      });
    }

    const unlocked = resultAndScoutUnlocked(game.startsAt);
    const gset = game.group;
    const autoCap = computeAutoGoingCap(gset.eventMaxParticipants, gset.eventReservedSlots);

    res.json({
      eventSettings: {
        rsvpAllowMaybe: gset.rsvpAllowMaybe,
        rsvpDeadlineHoursBeforeStart: gset.rsvpDeadlineHoursBeforeStart,
        eventMaxParticipants: gset.eventMaxParticipants,
        eventReservedSlots: gset.eventReservedSlots,
        eventReservedSlotsPositionKey: gset.eventReservedSlotsPositionKey ?? null,
        eventReservedSlotsPositionLabel: positionLabelForSport(
          groupSport,
          gset.eventReservedSlotsPositionKey,
        ),
        deadlineAt: eventSettingsDeadlineAt(game.startsAt, gset.rsvpDeadlineHoursBeforeStart),
        autoGoingCap: Number.isFinite(autoCap) ? autoCap : null,
      },
      game: {
        id: game.id,
        kind: game.kind,
        title: game.title,
        location: game.location,
        startsAt: game.startsAt.toISOString(),
        outcome: game.outcome,
        teamAScore: game.teamAScore,
        teamBScore: game.teamBScore,
        createdAt: game.createdAt.toISOString(),
        createdBy: game.createdBy
          ? { id: game.createdBy.id, fullName: game.createdBy.fullName }
          : null,
        resultAndScoutUnlocked: unlocked,
        resultAndScoutUnlocksAt: new Date(
          game.startsAt.getTime() + RESULT_AND_SCOUT_UNLOCK_MS,
        ).toISOString(),
      },
      viewer: {
        userId,
        canManageGames: canManageGroupGames(member.role),
        canAssignTeams: canAssignGameTeams(member.role),
        canModerateAttendance: canManageGroupGames(member.role),
        myStatus: attByUser.get(userId)?.status ?? null,
      },
      scout: {
        enabledMetricIds: enabledIds,
        optionalMetrics: metricDefs.map((d) => ({
          id: d.id,
          key: d.key,
          label: d.label,
          isActive: d.isActive,
        })),
      },
      members: members.map((m) => {
        const a = attByUser.get(m.userId);
        return {
          userId: m.user.id,
          fullName: m.user.fullName,
          phone: m.user.phone,
          role: m.role,
          positionKey: m.positionKey ?? null,
          positionLabel: positionLabelForSport(groupSport, m.positionKey),
          attendance: a
            ? {
                status: a.status,
                teamSide: a.teamSide,
                updatedAt: a.updatedAt.toISOString(),
                waitlistEnteredAt: a.waitlistEnteredAt?.toISOString() ?? null,
                forcedByModerator: a.forcedByModerator,
              }
            : null,
          scoutValues: statsByUser.get(m.userId) ?? [],
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar jogo";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.post("/:gameId/attendance", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = selfAttendanceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    const gameRow = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      select: { id: true, startsAt: true },
    });
    if (!gameRow) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }

    const groupRow = await prisma.group.findUnique({
      where: { id: groupId },
      select: {
        rsvpAllowMaybe: true,
        rsvpDeadlineHoursBeforeStart: true,
        eventMaxParticipants: true,
        eventReservedSlots: true,
      },
    });
    if (!groupRow) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    if (parsed.data.status === AttendanceStatus.MAYBE && !groupRow.rsvpAllowMaybe) {
      res.status(400).json({
        error: "Este grupo não permite resposta «Talvez».",
        code: "MAYBE_DISABLED",
      });
      return;
    }

    const now = new Date();
    const deadlinePassed = isPastRsvpDeadline(
      now,
      gameRow.startsAt,
      groupRow.rsvpDeadlineHoursBeforeStart,
    );
    const autoCap = computeAutoGoingCap(
      groupRow.eventMaxParticipants,
      groupRow.eventReservedSlots,
    );

    const row = await prisma.$transaction(async (tx) => {
      let nextStatus: AttendanceStatus = parsed.data.status;
      let waitAt: Date | null = null;
      let forced = false;

      if (parsed.data.status === AttendanceStatus.GOING) {
        const selfRow = await tx.gameAttendance.findUnique({
          where: { gameId_userId: { gameId, userId } },
          select: { status: true, forcedByModerator: true },
        });
        const vol = await countVoluntaryGoing(tx, gameId);
        const selfVoluntary =
          selfRow?.status === AttendanceStatus.GOING && !selfRow.forcedByModerator;
        const volExcl = selfVoluntary ? vol - 1 : vol;

        if (deadlinePassed || (Number.isFinite(autoCap) && volExcl >= autoCap)) {
          nextStatus = AttendanceStatus.WAITLIST;
          waitAt = now;
          forced = false;
        } else {
          nextStatus = AttendanceStatus.GOING;
          waitAt = null;
          forced = false;
        }
      } else {
        waitAt = null;
        forced = false;
      }

      const createData: Prisma.GameAttendanceCreateInput = {
        game: { connect: { id: gameId } },
        user: { connect: { id: userId } },
        status: nextStatus,
        waitlistEnteredAt: waitAt,
        forcedByModerator: forced,
        teamSide: null,
      };

      const updateData: Prisma.GameAttendanceUpdateInput = {
        status: nextStatus,
        waitlistEnteredAt: waitAt,
        forcedByModerator: forced,
      };

      if (
        nextStatus === AttendanceStatus.NOT_GOING ||
        nextStatus === AttendanceStatus.MAYBE ||
        nextStatus === AttendanceStatus.WAITLIST
      ) {
        updateData.teamSide = null;
      }

      const saved = await tx.gameAttendance.upsert({
        where: { gameId_userId: { gameId, userId } },
        create: createData,
        update: updateData,
      });

      await promoteWaitlistForGame(tx, gameId, groupRow);
      return saved;
    });

    res.json({
      attendance: {
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        waitlistEnteredAt: row.waitlistEnteredAt?.toISOString() ?? null,
        forcedByModerator: row.forcedByModerator,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "Conflito ao salvar presença. Tente novamente." });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao salvar presença";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.put("/:gameId/members/:targetUserId/attendance", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  const targetParsed = cuidParam.safeParse(req.params.targetUserId);
  if (!groupIdParsed.success || !gameIdParsed.success || !targetParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const targetUserId = targetParsed.data;
  const actorId = req.auth!.userId;

  const parsed = moderatorAttendanceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const actor = await requireGroupMember(groupId, actorId);
  if (!actor || !canManageGroupGames(actor.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice, tesoureiro ou moderador podem ajustar presenças.",
      code: "ATT_MODERATE_FORBIDDEN",
    });
    return;
  }

  const targetMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });
  if (!targetMember) {
    res.status(404).json({ error: "Atleta não participa deste grupo." });
    return;
  }

  try {
    const gameRow = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      select: { id: true, startsAt: true },
    });
    if (!gameRow) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }

    const groupRow = await prisma.group.findUnique({
      where: { id: groupId },
      select: {
        rsvpAllowMaybe: true,
        eventMaxParticipants: true,
        eventReservedSlots: true,
      },
    });
    if (!groupRow) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    if (parsed.data.status === AttendanceStatus.MAYBE && !groupRow.rsvpAllowMaybe) {
      res.status(400).json({
        error: "Este grupo não permite resposta «Talvez».",
        code: "MAYBE_DISABLED",
      });
      return;
    }

    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const st = parsed.data.status;
      let waitAt: Date | null = null;
      let forced = false;

      if (st === AttendanceStatus.GOING) {
        forced = true;
        waitAt = null;
      } else if (st === AttendanceStatus.WAITLIST) {
        forced = false;
        waitAt = now;
      } else {
        forced = false;
        waitAt = null;
      }

      const updatePayload: Prisma.GameAttendanceUpdateInput = {
        status: st,
        waitlistEnteredAt: waitAt,
        forcedByModerator: forced,
      };
      if (st !== AttendanceStatus.GOING) {
        updatePayload.teamSide = null;
      }

      const saved = await tx.gameAttendance.upsert({
        where: { gameId_userId: { gameId, userId: targetUserId } },
        create: {
          game: { connect: { id: gameId } },
          user: { connect: { id: targetUserId } },
          status: st,
          waitlistEnteredAt: waitAt,
          forcedByModerator: forced,
          teamSide: null,
        },
        update: updatePayload,
      });

      await promoteWaitlistForGame(tx, gameId, groupRow);
      return saved;
    });

    res.json({
      attendance: {
        userId: targetUserId,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        waitlistEnteredAt: row.waitlistEnteredAt?.toISOString() ?? null,
        forcedByModerator: row.forcedByModerator,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao salvar presença";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.patch("/:gameId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = patchGameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    if (parsed.data.mode === "details") {
      const gameRow = await prisma.groupGame.findFirst({
        where: { id: gameId, groupId },
        select: { id: true, createdByUserId: true },
      });
      if (!gameRow) {
        res.status(404).json({ error: "Jogo não encontrado" });
        return;
      }
      const isCreator = gameRow.createdByUserId === userId;
      if (!canManageGroupGames(member.role) && !isCreator) {
        res.status(403).json({
          error:
            "Apenas quem criou o evento ou a diretoria (presidente, vice, tesoureiro ou moderador) pode alterar estes dados.",
          code: "GAME_DETAILS_FORBIDDEN",
        });
        return;
      }
      const d = parsed.data;
      const startsAt = new Date(d.startsAt);
      const title = d.title.trim() || "Jogo";
      const location = d.location === "" ? null : d.location.trim();

      const updatedGame = await prisma.groupGame.update({
        where: { id: gameId },
        data: {
          kind: d.kind,
          title,
          location,
          startsAt,
        },
        select: {
          id: true,
          kind: true,
          title: true,
          location: true,
          startsAt: true,
        },
      });

      res.json({
        game: {
          id: updatedGame.id,
          kind: updatedGame.kind,
          title: updatedGame.title,
          location: updatedGame.location,
          startsAt: updatedGame.startsAt.toISOString(),
        },
      });
      return;
    }

    if (!canManageGroupGames(member.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice, tesoureiro ou moderador podem registrar resultado.",
        code: "GAME_OUTCOME_FORBIDDEN",
      });
      return;
    }

    const game = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      select: { id: true, startsAt: true },
    });
    if (!game) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }
    if (!resultAndScoutUnlocked(game.startsAt)) {
      res.status(403).json({
        error:
          "Placar e resultado só podem ser informados a partir de 1 minuto após o horário marcado do jogo.",
        code: "GAME_EDIT_LOCKED",
      });
      return;
    }

    if (parsed.data.mode === "scores") {
      await prisma.groupGame.update({
        where: { id: gameId },
        data: {
          teamAScore: parsed.data.teamAScore,
          teamBScore: parsed.data.teamBScore,
          outcome: null,
        },
      });
    } else if (parsed.data.mode === "legacy") {
      await prisma.groupGame.update({
        where: { id: gameId },
        data: {
          outcome: parsed.data.outcome,
          teamAScore: null,
          teamBScore: null,
        },
      });
    } else {
      await prisma.groupGame.update({
        where: { id: gameId },
        data: { outcome: null, teamAScore: null, teamBScore: null },
      });
    }

    const updated = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      select: { outcome: true, teamAScore: true, teamBScore: true },
    });
    res.json({
      game: {
        id: gameId,
        outcome: updated?.outcome ?? null,
        teamAScore: updated?.teamAScore ?? null,
        teamBScore: updated?.teamBScore ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao atualizar jogo";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.put("/:gameId/scout-stats", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = putScoutStatsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, userId);
  if (!member || !canManageGroupGames(member.role)) {
    res.status(403).json({
      error: "Apenas líderes podem lançar scouts.",
      code: "SCOUT_WRITE_FORBIDDEN",
    });
    return;
  }

  const game = await prisma.groupGame.findFirst({
    where: { id: gameId, groupId },
    select: { id: true, startsAt: true },
  });
  if (!game) {
    res.status(404).json({ error: "Jogo não encontrado" });
    return;
  }
  if (!resultAndScoutUnlocked(game.startsAt)) {
    res.status(403).json({
      error:
        "Scouts só podem ser lançados a partir de 1 minuto após o horário marcado do jogo.",
      code: "SCOUT_EDIT_LOCKED",
    });
    return;
  }

  const allowed = new Set(await enabledScoutMetricIds(groupId));
  const activeInGroup = await prisma.scoutMetricDefinition.findMany({
    where: { id: { in: [...allowed] }, isActive: true },
    select: { id: true },
  });
  const allowedActive = new Set(activeInGroup.map((d) => d.id));

  const memberIds = new Set(
    (await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } })).map(
      (m) => m.userId,
    ),
  );

  for (const s of parsed.data.stats) {
    if (!allowed.has(s.metricDefinitionId)) {
      res.status(400).json({
        error: "Métrica não habilitada para este grupo.",
        code: "SCOUT_METRIC_NOT_ENABLED",
      });
      return;
    }
    if (!allowedActive.has(s.metricDefinitionId)) {
      res.status(400).json({
        error: "Esta métrica está desativada na plataforma e não pode ser alterada.",
        code: "SCOUT_METRIC_INACTIVE",
      });
      return;
    }
    if (!memberIds.has(s.userId)) {
      res.status(400).json({
        error: "Usuário não participa do grupo.",
        code: "SCOUT_USER_NOT_MEMBER",
      });
      return;
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const s of parsed.data.stats) {
        if (s.value === 0) {
          await tx.gameScoutStat.deleteMany({
            where: {
              gameId,
              userId: s.userId,
              scoutMetricDefinitionId: s.metricDefinitionId,
            },
          });
        } else {
          await tx.gameScoutStat.upsert({
            where: {
              gameId_userId_scoutMetricDefinitionId: {
                gameId,
                userId: s.userId,
                scoutMetricDefinitionId: s.metricDefinitionId,
              },
            },
            create: {
              gameId,
              userId: s.userId,
              scoutMetricDefinitionId: s.metricDefinitionId,
              value: s.value,
            },
            update: { value: s.value },
          });
        }
      }
    });
    res.json({ ok: true, saved: parsed.data.stats.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao salvar scouts";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.put("/:gameId/team-assignments", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = teamAssignmentsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, userId);
  if (!member || !canAssignGameTeams(member.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice-presidente ou moderador podem definir times.",
      code: "TEAM_ASSIGN_FORBIDDEN",
    });
    return;
  }

  const game = await prisma.groupGame.findFirst({
    where: { id: gameId, groupId },
    select: { id: true },
  });
  if (!game) {
    res.status(404).json({ error: "Jogo não encontrado" });
    return;
  }

  const memberIds = new Set(
    (await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } })).map(
      (m) => m.userId,
    ),
  );

  const groupRow = await prisma.group.findUnique({
    where: { id: groupId },
    select: { eventMaxParticipants: true, eventReservedSlots: true },
  });
  if (!groupRow) {
    res.status(404).json({ error: "Grupo não encontrado" });
    return;
  }

  try {
    let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const a of parsed.data.assignments) {
        if (!memberIds.has(a.userId)) {
          throw new Error(`NOT_MEMBER:${a.userId}`);
        }
        if (a.teamSide === null) {
          const r = await tx.gameAttendance.updateMany({
            where: { gameId, userId: a.userId },
            data: { teamSide: null },
          });
          updated += r.count;
          continue;
        }
        const r = await tx.gameAttendance.updateMany({
          where: { gameId, userId: a.userId },
          data: {
            teamSide: a.teamSide,
            status: AttendanceStatus.GOING,
            forcedByModerator: true,
            waitlistEnteredAt: null,
          },
        });
        if (r.count > 0) {
          updated += r.count;
          continue;
        }
        await tx.gameAttendance.create({
          data: {
            gameId,
            userId: a.userId,
            status: AttendanceStatus.GOING,
            teamSide: a.teamSide,
            forcedByModerator: true,
            waitlistEnteredAt: null,
          },
        });
        updated += 1;
      }
      await promoteWaitlistForGame(tx, gameId, groupRow);
    });
    res.json({ ok: true, assignmentsUpdated: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("NOT_MEMBER:")) {
      res.status(400).json({ error: "Usuário não participa deste grupo." });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao salvar times";
    res.status(500).json({ error: message });
  }
});

groupGamesRouter.delete("/:gameId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const gameIdParsed = cuidParam.safeParse(req.params.gameId);
  if (!groupIdParsed.success || !gameIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const gameId = gameIdParsed.data;
  const userId = req.auth!.userId;

  const member = await requireGroupMember(groupId, userId);
  if (!member || !canManageGroupGames(member.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice, tesoureiro ou moderador podem excluir jogos.",
      code: "GAME_DELETE_FORBIDDEN",
    });
    return;
  }

  try {
    const deleted = await prisma.groupGame.deleteMany({
      where: { id: gameId, groupId },
    });
    if (deleted.count === 0) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao excluir jogo";
    res.status(500).json({ error: message });
  }
});
