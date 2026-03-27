import {
  GroupMemberRole,
  GroupVisibility,
  JoinRequestStatus,
  Prisma,
  Sport,
} from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateUniquePublicCode } from "../lib/groupCode";
import {
  canApproveJoinRequests,
  canEditGroupSettings,
  canInviteByPhone,
  canManageMonthlyFees,
} from "../lib/groupPermissions";
import { normalizeBrazilPhone } from "../lib/phone";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { groupFeePlansRouter } from "./groupFeePlans";
import { groupFeesRouter } from "./groupFees";
import { groupGamesRouter } from "./groupGames";
import { groupLedgerRouter } from "./groupLedger";
import { groupRankingRouter } from "./groupRanking";
import { groupScoutSettingsRouter } from "./groupScoutSettings";

export const groupsRouter = Router();

/** Mês corrente no fuso do servidor (YYYY-MM), alinhado às rotas de mensalidade. */
function currentPeriodMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

groupsRouter.use(requireAuth);

groupsRouter.use("/:groupId/fees", groupFeesRouter);
groupsRouter.use("/:groupId/fee-plans", groupFeePlansRouter);
groupsRouter.use("/:groupId/games", groupGamesRouter);
groupsRouter.use("/:groupId/ledger", groupLedgerRouter);
groupsRouter.use("/:groupId/scout-settings", groupScoutSettingsRouter);
groupsRouter.use("/:groupId/ranking", groupRankingRouter);

const createGroupSchema = z.object({
  name: z.string().trim().min(2, "Nome do grupo muito curto"),
  visibility: z.nativeEnum(GroupVisibility),
  sport: z.nativeEnum(Sport),
});

groupsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const userId = req.auth!.userId;
  const { name, visibility, sport } = parsed.data;

  try {
    const publicCode = await generateUniquePublicCode();

    const group = await prisma.$transaction(async (tx) => {
      const g = await tx.group.create({
        data: {
          publicCode,
          name,
          visibility,
          sport,
          presidentId: userId,
        },
      });

      await tx.groupMember.create({
        data: {
          groupId: g.id,
          userId,
          role: GroupMemberRole.PRESIDENT,
        },
      });

      return g;
    });

    res.status(201).json({
      group: {
        id: group.id,
        publicCode: group.publicCode,
        name: group.name,
        visibility: group.visibility,
        sport: group.sport,
        presidentId: group.presidentId,
        createdAt: group.createdAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao criar grupo";
    res.status(500).json({ error: message });
  }
});

const publicCodeSchema = z
  .string()
  .regex(/^\d{6}$/, "Informe o código de 6 dígitos do grupo");

const joinByCodeBodySchema = z.object({
  publicCode: publicCodeSchema,
});

groupsRouter.get("/preview-code/:publicCode", async (req: Request, res: Response) => {
  const codeParsed = publicCodeSchema.safeParse(req.params.publicCode);
  if (!codeParsed.success) {
    res.status(400).json({ error: "Código inválido", details: codeParsed.error.flatten() });
    return;
  }
  const publicCode = codeParsed.data;
  const userId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({
      where: { publicCode },
      select: {
        id: true,
        publicCode: true,
        name: true,
        sport: true,
        visibility: true,
      },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado", code: "GROUP_NOT_FOUND" });
      return;
    }

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (membership) {
      res.json({
        group,
        isMember: true,
        hasPendingRequest: false,
        canRequestJoin: false,
      });
      return;
    }

    if (group.visibility === GroupVisibility.PRIVATE) {
      res.status(403).json({
        error: "Este grupo é privado. Peça ao líder um convite pelo telefone.",
        code: "PRIVATE_GROUP",
      });
      return;
    }

    const pending = await prisma.groupJoinRequest.findFirst({
      where: {
        groupId: group.id,
        userId,
        status: JoinRequestStatus.PENDING,
      },
    });

    res.json({
      group,
      isMember: false,
      hasPendingRequest: Boolean(pending),
      canRequestJoin: !pending,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar grupo";
    res.status(500).json({ error: message });
  }
});

groupsRouter.post("/join-by-code", async (req: Request, res: Response) => {
  const parsed = joinByCodeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }
  const userId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({
      where: { publicCode: parsed.data.publicCode },
      select: { id: true, visibility: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado", code: "GROUP_NOT_FOUND" });
      return;
    }

    if (group.visibility !== GroupVisibility.PUBLIC) {
      res.status(403).json({
        error: "Grupo privado: use o convite por telefone.",
        code: "PRIVATE_GROUP",
      });
      return;
    }

    const member = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (member) {
      res.status(409).json({
        error: "Você já participa deste grupo",
        code: "ALREADY_MEMBER",
      });
      return;
    }

    const pending = await prisma.groupJoinRequest.findFirst({
      where: {
        groupId: group.id,
        userId,
        status: JoinRequestStatus.PENDING,
      },
    });
    if (pending) {
      res.status(409).json({
        error: "Solicitação já enviada — aguarde análise",
        code: "PENDING_EXISTS",
      });
      return;
    }

    const created = await prisma.groupJoinRequest.create({
      data: {
        groupId: group.id,
        userId,
        status: JoinRequestStatus.PENDING,
      },
    });

    res.status(201).json({
      request: {
        id: created.id,
        groupId: created.groupId,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao solicitar entrada";
    res.status(500).json({ error: message });
  }
});

groupsRouter.get("/mine", async (req: Request, res: Response) => {
  const userId = req.auth!.userId;

  try {
    const rows = await prisma.groupMember.findMany({
      where: { userId },
      include: {
        group: true,
      },
      orderBy: { joinedAt: "desc" },
    });

    const groups = rows.map((m) => ({
      role: m.role,
      joinedAt: m.joinedAt,
      group: {
        id: m.group.id,
        publicCode: m.group.publicCode,
        name: m.group.name,
        visibility: m.group.visibility,
        sport: m.group.sport,
        presidentId: m.group.presidentId,
        createdAt: m.group.createdAt,
      },
    }));

    res.json({ groups });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar grupos";
    res.status(500).json({ error: message });
  }
});

const browseQuerySchema = z.object({
  q: z.string().optional(),
  sport: z.nativeEnum(Sport).optional(),
});

groupsRouter.get("/browse", async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const parsed = browseQuerySchema.safeParse({
    q: typeof req.query.q === "string" ? req.query.q.trim() : undefined,
    sport: typeof req.query.sport === "string" ? req.query.sport : undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos", details: parsed.error.flatten() });
    return;
  }

  const { q, sport } = parsed.data;

  try {
    const where: Prisma.GroupWhereInput = {};
    if (sport) where.sport = sport;
    if (q && q.length > 0) {
      const digits = q.replace(/\D/g, "").slice(0, 6);
      const orClause: Prisma.GroupWhereInput[] = [
        { name: { contains: q, mode: "insensitive" } },
      ];
      if (digits.length >= 4) {
        orClause.push({ publicCode: { contains: digits } });
      }
      where.OR = orClause;
    }

    const groups = await prisma.group.findMany({
      where,
      take: 80,
      orderBy: { name: "asc" },
      select: {
        id: true,
        publicCode: true,
        name: true,
        sport: true,
        visibility: true,
        presidentId: true,
        createdAt: true,
      },
    });

    if (groups.length === 0) {
      res.json({ groups: [] });
      return;
    }

    const ids = groups.map((g) => g.id);
    const [myMemberships, allMembers, myPendingJoins] = await Promise.all([
      prisma.groupMember.findMany({
        where: { userId, groupId: { in: ids } },
        select: { groupId: true },
      }),
      prisma.groupMember.findMany({
        where: { groupId: { in: ids } },
        include: {
          user: { select: { id: true, fullName: true } },
          feePlan: { select: { name: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.groupJoinRequest.findMany({
        where: {
          userId,
          groupId: { in: ids },
          status: JoinRequestStatus.PENDING,
        },
        select: { groupId: true, id: true },
      }),
    ]);

    const memberMap = new Map<string, typeof allMembers>();
    for (const m of allMembers) {
      if (!memberMap.has(m.groupId)) memberMap.set(m.groupId, []);
      memberMap.get(m.groupId)!.push(m);
    }

    const mySet = new Set(myMemberships.map((m) => m.groupId));
    const pendingJoinByGroup = new Map(myPendingJoins.map((r) => [r.groupId, r.id]));

    const shaped = groups.map((g) => {
      const raw = memberMap.get(g.id) ?? [];
      const viewerIsMember = mySet.has(g.id);
      const isPrivateHidden = g.visibility === GroupVisibility.PRIVATE && !viewerIsMember;
      const membersPayload = isPrivateHidden
        ? raw
            .filter((m) => m.role === GroupMemberRole.PRESIDENT)
            .map((m) => ({
              userId: m.userId,
              fullName: m.user.fullName,
              role: m.role,
              feePlanName: m.feePlan?.name ?? null,
            }))
        : raw.map((m) => ({
            userId: m.userId,
            fullName: m.user.fullName,
            role: m.role,
            feePlanName: m.feePlan?.name ?? null,
          }));

      return {
        id: g.id,
        publicCode: g.publicCode,
        name: g.name,
        sport: g.sport,
        visibility: g.visibility,
        presidentId: g.presidentId,
        createdAt: g.createdAt.toISOString(),
        viewerIsMember,
        viewerPendingJoinRequestId: pendingJoinByGroup.get(g.id) ?? null,
        canRequestJoin:
          g.visibility === GroupVisibility.PUBLIC && !viewerIsMember,
        members: membersPayload,
        memberCount: isPrivateHidden ? null : raw.length,
      };
    });

    res.json({ groups: shaped });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao buscar grupos";
    res.status(500).json({ error: message });
  }
});

const cuidParam = z.string().cuid("ID de grupo inválido");

const inviteBodySchema = z.object({
  phone: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(8, "Informe o celular com DDD (ex.: 11987654321)")),
});

const groupSettingsPatchSchema = z.object({
  statuteUrl: z.union([z.string().url().max(2000), z.literal(""), z.null()]).optional(),
  localRulesNote: z.union([z.string().max(20_000), z.literal(""), z.null()]).optional(),
  richPublicProfile: z.boolean().optional(),
});

const memberRolePatchSchema = z.object({
  role: z.nativeEnum(GroupMemberRole),
});

groupsRouter.get("/:groupId/members", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const self = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!self) {
      res.status(403).json({ error: "Você não participa deste grupo" });
      return;
    }

    const rows = await prisma.groupMember.findMany({
      where: { groupId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
        feePlan: { select: { id: true, name: true, amountCents: true } },
      },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    });

    res.json({
      viewer: {
        userId,
        role: self.role,
        canInviteByPhone: canInviteByPhone(self.role),
        canApproveJoinRequests: canApproveJoinRequests(self.role),
        canManageMonthlyFees: canManageMonthlyFees(self.role),
        canEditGroupSettings: canEditGroupSettings(self.role),
      },
      members: rows.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        feePlan: m.feePlan
          ? {
              id: m.feePlan.id,
              name: m.feePlan.name,
              amountCents: m.feePlan.amountCents,
            }
          : null,
        user: m.user,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar membros";
    res.status(500).json({ error: message });
  }
});

const feePlanAssignBodySchema = z.object({
  feePlanId: z.union([z.string().cuid(), z.null()]),
});

groupsRouter.get("/:groupId/settings", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;
  const periodMonth = currentPeriodMonth();

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        sport: true,
        visibility: true,
        statuteUrl: true,
        localRulesNote: true,
        richPublicProfile: true,
        presidentId: true,
      },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const self = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!self) {
      res.status(403).json({ error: "Você não participa deste grupo" });
      return;
    }

    const [members, fees, plans] = await Promise.all([
      prisma.groupMember.findMany({
        where: { groupId },
        include: {
          user: { select: { id: true, fullName: true, phone: true, email: true } },
          feePlan: { select: { id: true, name: true, amountCents: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.memberMonthlyFee.findMany({
        where: { groupId, periodMonth },
        select: { userId: true },
      }),
      prisma.groupFeePlan.findMany({
        where: { groupId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, amountCents: true },
      }),
    ]);

    const paidUserIds = new Set(fees.map((f) => f.userId));

    type FeeStatus = "em_dia" | "em_atraso" | "sem_plano";
    function feeStatusForMember(m: (typeof members)[0]): FeeStatus {
      if (!m.feePlanId) return "sem_plano";
      return paidUserIds.has(m.userId) ? "em_dia" : "em_atraso";
    }

    res.json({
      periodMonth,
      group: {
        id: group.id,
        name: group.name,
        sport: group.sport,
        visibility: group.visibility,
        statuteUrl: group.statuteUrl,
        localRulesNote: group.localRulesNote,
        richPublicProfile: group.richPublicProfile,
        presidentId: group.presidentId,
      },
      viewer: {
        canEditSettings: canEditGroupSettings(self.role),
      },
      feePlans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        amountCents: p.amountCents,
      })),
      members: members.map((m) => ({
        userId: m.userId,
        fullName: m.user.fullName,
        role: m.role,
        feePlan: m.feePlan
          ? { id: m.feePlan.id, name: m.feePlan.name, amountCents: m.feePlan.amountCents }
          : null,
        feeStatus: feeStatusForMember(m),
        phone: m.user.phone,
        email: m.user.email,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar configurações";
    res.status(500).json({ error: message });
  }
});

groupsRouter.patch("/:groupId/settings", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const actorId = req.auth!.userId;

  const parsed = groupSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Nenhum campo para atualizar" });
    return;
  }

  try {
    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canEditGroupSettings(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice, tesoureiro ou moderador alteram estas configurações.",
        code: "GROUP_SETTINGS_FORBIDDEN",
      });
      return;
    }

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const data: Prisma.GroupUpdateInput = {};
    if (parsed.data.statuteUrl !== undefined) {
      const v = parsed.data.statuteUrl;
      data.statuteUrl = v === "" || v === null ? null : v;
    }
    if (parsed.data.localRulesNote !== undefined) {
      const v = parsed.data.localRulesNote;
      data.localRulesNote = v === "" || v === null ? null : v;
    }
    if (parsed.data.richPublicProfile !== undefined) {
      data.richPublicProfile = parsed.data.richPublicProfile;
    }

    const updated = await prisma.group.update({
      where: { id: groupId },
      data,
      select: {
        statuteUrl: true,
        localRulesNote: true,
        richPublicProfile: true,
      },
    });

    res.json({ group: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao salvar configurações";
    res.status(500).json({ error: message });
  }
});

groupsRouter.patch("/:groupId/members/:targetUserId/role", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const targetParsed = cuidParam.safeParse(req.params.targetUserId);
  if (!groupIdParsed.success || !targetParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const targetUserId = targetParsed.data;
  const actorId = req.auth!.userId;

  const parsed = memberRolePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }
  const newRole = parsed.data.role;

  try {
    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canEditGroupSettings(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice, tesoureiro ou moderador atribuem papéis de direção.",
        code: "MEMBER_ROLE_FORBIDDEN",
      });
      return;
    }

    const targetMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });
    if (!targetMembership) {
      res.status(404).json({ error: "Membro não encontrado neste grupo" });
      return;
    }

    if (
      targetMembership.role === GroupMemberRole.PRESIDENT &&
      newRole !== GroupMemberRole.PRESIDENT
    ) {
      res.status(400).json({
        error:
          "Para alterar o papel do presidente atual, atribua primeiro a presidência a outro membro.",
        code: "PRESIDENT_TRANSFER_REQUIRED",
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (newRole === GroupMemberRole.PRESIDENT) {
        await tx.groupMember.updateMany({
          where: { groupId, role: GroupMemberRole.PRESIDENT },
          data: { role: GroupMemberRole.MEMBER },
        });
        await tx.groupMember.update({
          where: { groupId_userId: { groupId, userId: targetUserId } },
          data: { role: GroupMemberRole.PRESIDENT },
        });
        await tx.group.update({
          where: { id: groupId },
          data: { presidentId: targetUserId },
        });
        return;
      }

      if (newRole === GroupMemberRole.VICE_PRESIDENT) {
        await tx.groupMember.updateMany({
          where: { groupId, role: GroupMemberRole.VICE_PRESIDENT },
          data: { role: GroupMemberRole.MEMBER },
        });
        await tx.groupMember.update({
          where: { groupId_userId: { groupId, userId: targetUserId } },
          data: { role: GroupMemberRole.VICE_PRESIDENT },
        });
        return;
      }

      if (newRole === GroupMemberRole.TREASURER) {
        await tx.groupMember.updateMany({
          where: { groupId, role: GroupMemberRole.TREASURER },
          data: { role: GroupMemberRole.MEMBER },
        });
        await tx.groupMember.update({
          where: { groupId_userId: { groupId, userId: targetUserId } },
          data: { role: GroupMemberRole.TREASURER },
        });
        return;
      }

      await tx.groupMember.update({
        where: { groupId_userId: { groupId, userId: targetUserId } },
        data: { role: newRole },
      });
    });

    res.json({ ok: true, userId: targetUserId, role: newRole });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao atualizar o papel";
    res.status(500).json({ error: message });
  }
});

groupsRouter.get("/:groupId/public-profile", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        publicCode: true,
        name: true,
        sport: true,
        visibility: true,
        presidentId: true,
        createdAt: true,
        statuteUrl: true,
        localRulesNote: true,
        richPublicProfile: true,
      },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const self = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    const [allMembers, pendingSelf] = await Promise.all([
      prisma.groupMember.findMany({
        where: { groupId },
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          feePlan: { select: { name: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.groupJoinRequest.findFirst({
        where: { groupId, userId, status: JoinRequestStatus.PENDING },
        select: { id: true },
      }),
    ]);

    const viewerIsMember = Boolean(self);
    const isPrivateHidden = group.visibility === GroupVisibility.PRIVATE && !viewerIsMember;
    const mapMember = (m: (typeof allMembers)[0]) => ({
      userId: m.userId,
      fullName: m.user.fullName,
      role: m.role,
      feePlanName: m.feePlan?.name ?? null,
      whatsappPhone:
        m.role === GroupMemberRole.PRESIDENT || m.role === GroupMemberRole.VICE_PRESIDENT
          ? m.user.phone
          : null,
    });
    const membersPayload = isPrivateHidden
      ? allMembers.filter((m) => m.role === GroupMemberRole.PRESIDENT).map(mapMember)
      : allMembers.map(mapMember);

    const showRichPublic =
      group.richPublicProfile &&
      !isPrivateHidden &&
      (group.visibility === GroupVisibility.PUBLIC || viewerIsMember);

    type PublicMemberPayload = (typeof membersPayload)[0] & {
      feeStatus?: "em_dia" | "em_atraso" | "sem_plano";
    };
    let enrichedMembers: PublicMemberPayload[] = membersPayload;
    let feePlansPayload:
      | { id: string; name: string; amountCents: number }[]
      | undefined;

    let richPeriodMonth: string | undefined;
    if (showRichPublic) {
      richPeriodMonth = currentPeriodMonth();
      const [fees, plans] = await Promise.all([
        prisma.memberMonthlyFee.findMany({
          where: { groupId, periodMonth: richPeriodMonth },
          select: { userId: true },
        }),
        prisma.groupFeePlan.findMany({
          where: { groupId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, amountCents: true },
        }),
      ]);
      const paid = new Set(fees.map((f) => f.userId));
      const byUserId = new Map(allMembers.map((m) => [m.userId, m]));
      feePlansPayload = plans.map((p) => ({
        id: p.id,
        name: p.name,
        amountCents: p.amountCents,
      }));
      enrichedMembers = membersPayload.map((row) => {
        const m = byUserId.get(row.userId);
        let feeStatus: "em_dia" | "em_atraso" | "sem_plano" = "sem_plano";
        if (m) {
          if (!m.feePlanId) feeStatus = "sem_plano";
          else feeStatus = paid.has(m.userId) ? "em_dia" : "em_atraso";
        }
        return { ...row, feeStatus };
      });
    }

    res.json({
      group: {
        id: group.id,
        publicCode: group.publicCode,
        name: group.name,
        sport: group.sport,
        visibility: group.visibility,
        presidentId: group.presidentId,
        createdAt: group.createdAt.toISOString(),
        richPublicProfile: group.richPublicProfile,
        ...(showRichPublic
          ? {
              statuteUrl: group.statuteUrl,
              localRulesNote: group.localRulesNote,
            }
          : {}),
      },
      viewerIsMember,
      viewerPendingJoinRequestId: pendingSelf?.id ?? null,
      canRequestJoin:
        group.visibility === GroupVisibility.PUBLIC && !viewerIsMember,
      members: enrichedMembers,
      memberCount: isPrivateHidden ? null : allMembers.length,
      ...(showRichPublic && feePlansPayload && richPeriodMonth
        ? { periodMonth: richPeriodMonth, feePlans: feePlansPayload }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar grupo";
    res.status(500).json({ error: message });
  }
});

groupsRouter.patch("/:groupId/members/:targetUserId/fee-plan", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const targetParsed = cuidParam.safeParse(req.params.targetUserId);
  if (!groupIdParsed.success || !targetParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const targetUserId = targetParsed.data;
  const actorId = req.auth!.userId;

  const parsed = feePlanAssignBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  try {
    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canManageMonthlyFees(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice ou tesoureiro podem atribuir planos.",
        code: "FEE_PLAN_ASSIGN_FORBIDDEN",
      });
      return;
    }

    const targetMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });
    if (!targetMembership) {
      res.status(404).json({ error: "Membro não encontrado neste grupo" });
      return;
    }

    if (parsed.data.feePlanId) {
      const plan = await prisma.groupFeePlan.findFirst({
        where: { id: parsed.data.feePlanId, groupId },
      });
      if (!plan) {
        res.status(400).json({ error: "Plano inválido para este grupo" });
        return;
      }
    }

    const updated = await prisma.groupMember.update({
      where: { id: targetMembership.id },
      data: { feePlanId: parsed.data.feePlanId },
      include: {
        feePlan: { select: { id: true, name: true, amountCents: true } },
      },
    });

    res.json({
      member: {
        userId: updated.userId,
        feePlan: updated.feePlan
          ? {
              id: updated.feePlan.id,
              name: updated.feePlan.name,
              amountCents: updated.feePlan.amountCents,
            }
          : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao atualizar plano";
    res.status(500).json({ error: message });
  }
});

groupsRouter.post("/:groupId/members/invite", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const actorId = req.auth!.userId;

  const parsed = inviteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  let phoneNormalized: string;
  try {
    phoneNormalized = normalizeBrazilPhone(parsed.data.phone);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Telefone inválido";
    res.status(400).json({ error: message });
    return;
  }

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canInviteByPhone(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice-presidente ou tesoureiro podem adicionar por telefone",
        code: "INVITE_FORBIDDEN",
      });
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where: { phone: phoneNormalized },
      select: { id: true, fullName: true, phone: true, email: true },
    });
    if (!targetUser) {
      res.status(404).json({
        error:
          "Nenhum atleta encontrado com este telefone. A pessoa precisa criar conta no SportHub antes.",
        code: "USER_NOT_FOUND",
      });
      return;
    }

    if (targetUser.id === actorId) {
      res.status(400).json({
        error:
          "Informe o celular de outra pessoa. Este número é o da sua conta — você já está no grupo.",
        code: "INVITE_SELF",
      });
      return;
    }

    const created = await prisma.groupMember.create({
      data: {
        groupId,
        userId: targetUser.id,
        role: GroupMemberRole.MEMBER,
      },
    });

    res.status(201).json({
      member: {
        membershipId: created.id,
        userId: created.userId,
        role: created.role,
        joinedAt: created.joinedAt,
        user: targetUser,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      res.status(409).json({
        error: "Este atleta já faz parte do grupo",
        code: "ALREADY_MEMBER",
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao convidar";
    res.status(500).json({ error: message });
  }
});

groupsRouter.post("/:groupId/join-requests", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, visibility: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    if (group.visibility !== GroupVisibility.PUBLIC) {
      res.status(403).json({
        error: "Grupo privado: use o convite por telefone.",
        code: "PRIVATE_GROUP",
      });
      return;
    }

    const member = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (member) {
      res.status(409).json({
        error: "Você já participa deste grupo",
        code: "ALREADY_MEMBER",
      });
      return;
    }

    const pending = await prisma.groupJoinRequest.findFirst({
      where: { groupId, userId, status: JoinRequestStatus.PENDING },
    });
    if (pending) {
      res.status(409).json({
        error: "Solicitação já enviada — aguarde análise",
        code: "PENDING_EXISTS",
      });
      return;
    }

    const created = await prisma.groupJoinRequest.create({
      data: { groupId, userId, status: JoinRequestStatus.PENDING },
    });

    res.status(201).json({
      request: {
        id: created.id,
        groupId: created.groupId,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao solicitar entrada";
    res.status(500).json({ error: message });
  }
});

/** Atleta cancela o próprio pedido pendente de entrada no grupo público. */
groupsRouter.delete("/:groupId/join-requests/me", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  try {
    const del = await prisma.groupJoinRequest.deleteMany({
      where: { groupId, userId, status: JoinRequestStatus.PENDING },
    });
    if (del.count === 0) {
      res.status(404).json({
        error: "Não há solicitação pendente para cancelar.",
        code: "NO_PENDING_REQUEST",
      });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao cancelar pedido";
    res.status(500).json({ error: message });
  }
});

groupsRouter.get("/:groupId/join-requests", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const actorId = req.auth!.userId;

  try {
    const group = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canApproveJoinRequests(actorMembership.role)) {
      res.status(403).json({
        error: "Você não pode gerenciar solicitações deste grupo",
        code: "JOIN_ADMIN_FORBIDDEN",
      });
      return;
    }

    const rows = await prisma.groupJoinRequest.findMany({
      where: { groupId, status: JoinRequestStatus.PENDING },
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        user: r.user,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar solicitações";
    res.status(500).json({ error: message });
  }
});

groupsRouter.post(
  "/:groupId/join-requests/:requestId/approve",
  async (req: Request, res: Response) => {
    const groupIdParsed = cuidParam.safeParse(req.params.groupId);
    const requestIdParsed = cuidParam.safeParse(req.params.requestId);
    if (!groupIdParsed.success || !requestIdParsed.success) {
      res.status(400).json({ error: "Parâmetros inválidos" });
      return;
    }
    const groupId = groupIdParsed.data;
    const requestId = requestIdParsed.data;
    const actorId = req.auth!.userId;

    try {
      const actorMembership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: actorId } },
      });
      if (!actorMembership || !canApproveJoinRequests(actorMembership.role)) {
        res.status(403).json({
          error: "Você não pode aprovar solicitações deste grupo",
          code: "JOIN_ADMIN_FORBIDDEN",
        });
        return;
      }

      const joinReq = await prisma.groupJoinRequest.findFirst({
        where: { id: requestId, groupId, status: JoinRequestStatus.PENDING },
      });
      if (!joinReq) {
        res.status(404).json({ error: "Solicitação não encontrada ou já respondida" });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.create({
          data: {
            groupId,
            userId: joinReq.userId,
            role: GroupMemberRole.MEMBER,
          },
        });
        await tx.groupJoinRequest.update({
          where: { id: requestId },
          data: {
            status: JoinRequestStatus.APPROVED,
            respondedAt: new Date(),
          },
        });
      });

      res.json({ ok: true });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        await prisma.groupJoinRequest.updateMany({
          where: { id: requestId, groupId, status: JoinRequestStatus.PENDING },
          data: {
            status: JoinRequestStatus.APPROVED,
            respondedAt: new Date(),
          },
        });
        res.json({ ok: true, note: "Membro já existia; solicitação marcada como aprovada." });
        return;
      }
      const message = err instanceof Error ? err.message : "Erro ao aprovar";
      res.status(500).json({ error: message });
    }
  },
);

groupsRouter.post(
  "/:groupId/join-requests/:requestId/reject",
  async (req: Request, res: Response) => {
    const groupIdParsed = cuidParam.safeParse(req.params.groupId);
    const requestIdParsed = cuidParam.safeParse(req.params.requestId);
    if (!groupIdParsed.success || !requestIdParsed.success) {
      res.status(400).json({ error: "Parâmetros inválidos" });
      return;
    }
    const groupId = groupIdParsed.data;
    const requestId = requestIdParsed.data;
    const actorId = req.auth!.userId;

    try {
      const actorMembership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: actorId } },
      });
      if (!actorMembership || !canApproveJoinRequests(actorMembership.role)) {
        res.status(403).json({
          error: "Você não pode recusar solicitações deste grupo",
          code: "JOIN_ADMIN_FORBIDDEN",
        });
        return;
      }

      const updated = await prisma.groupJoinRequest.updateMany({
        where: { id: requestId, groupId, status: JoinRequestStatus.PENDING },
        data: {
          status: JoinRequestStatus.REJECTED,
          respondedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        res.status(404).json({ error: "Solicitação não encontrada ou já respondida" });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro ao recusar";
      res.status(500).json({ error: message });
    }
  },
);
