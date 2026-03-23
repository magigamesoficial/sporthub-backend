import { AttendanceStatus, GroupMemberRole, Prisma } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canManageGroupGames } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupGamesRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

const createGameSchema = z.object({
  title: z.string().trim().min(1, "Título obrigatório").max(120).optional(),
  location: z.union([z.string().trim().max(200), z.literal("")]).optional(),
  startsAt: z
    .string()
    .min(1, "Data/hora obrigatória")
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "Data/hora inválida (ISO 8601)"),
});

const attendanceBodySchema = z.object({
  status: z.nativeEnum(AttendanceStatus),
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

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const games = await prisma.groupGame.findMany({
      where: { groupId, startsAt: { gte: since } },
      orderBy: { startsAt: "asc" },
      take: 100,
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

    const countMap = new Map<string, { GOING: number; MAYBE: number; NOT_GOING: number }>();
    for (const g of games) {
      countMap.set(g.id, { GOING: 0, MAYBE: 0, NOT_GOING: 0 });
    }
    for (const row of aggregates) {
      const cur = countMap.get(row.gameId);
      if (!cur) continue;
      if (row.status === AttendanceStatus.GOING) cur.GOING += row._count._all;
      if (row.status === AttendanceStatus.MAYBE) cur.MAYBE += row._count._all;
      if (row.status === AttendanceStatus.NOT_GOING) cur.NOT_GOING += row._count._all;
    }

    res.json({
      viewer: {
        canManageGames: canManageGroupGames(member.role),
      },
      games: games.map((g) => ({
        id: g.id,
        title: g.title,
        location: g.location,
        startsAt: g.startsAt.toISOString(),
        createdAt: g.createdAt.toISOString(),
        createdBy: g.createdBy
          ? { id: g.createdBy.id, fullName: g.createdBy.fullName }
          : null,
        counts: countMap.get(g.id) ?? { GOING: 0, MAYBE: 0, NOT_GOING: 0 },
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
        title: parsed.data.title?.trim() || "Jogo",
        location,
        startsAt,
        createdByUserId: userId,
      },
    });

    res.status(201).json({
      game: {
        id: game.id,
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
      },
    });
    if (!game) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }

    const [members, attendances] = await Promise.all([
      prisma.groupMember.findMany({
        where: { groupId },
        include: { user: { select: { id: true, fullName: true, phone: true } } },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.gameAttendance.findMany({
        where: { gameId },
      }),
    ]);

    const attByUser = new Map(attendances.map((a) => [a.userId, a]));

    res.json({
      game: {
        id: game.id,
        title: game.title,
        location: game.location,
        startsAt: game.startsAt.toISOString(),
        createdAt: game.createdAt.toISOString(),
        createdBy: game.createdBy
          ? { id: game.createdBy.id, fullName: game.createdBy.fullName }
          : null,
      },
      viewer: {
        userId,
        canManageGames: canManageGroupGames(member.role),
        myStatus: attByUser.get(userId)?.status ?? null,
      },
      members: members.map((m) => {
        const a = attByUser.get(m.userId);
        return {
          userId: m.user.id,
          fullName: m.user.fullName,
          phone: m.user.phone,
          role: m.role,
          attendance: a ? { status: a.status, updatedAt: a.updatedAt.toISOString() } : null,
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

  const parsed = attendanceBodySchema.safeParse(req.body);
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
    const game = await prisma.groupGame.findFirst({
      where: { id: gameId, groupId },
      select: { id: true },
    });
    if (!game) {
      res.status(404).json({ error: "Jogo não encontrado" });
      return;
    }

    const row = await prisma.gameAttendance.upsert({
      where: { gameId_userId: { gameId, userId } },
      create: {
        gameId,
        userId,
        status: parsed.data.status,
      },
      update: {
        status: parsed.data.status,
      },
    });

    res.json({
      attendance: {
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
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
