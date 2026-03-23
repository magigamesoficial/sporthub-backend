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
import { canApproveJoinRequests, canInviteByPhone } from "../lib/groupPermissions";
import { normalizeBrazilPhone } from "../lib/phone";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export const groupsRouter = Router();

groupsRouter.use(requireAuth);

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

const cuidParam = z.string().cuid("ID de grupo inválido");

const inviteBodySchema = z.object({
  phone: z.string().min(8, "Telefone inválido"),
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
      },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    });

    res.json({
      viewer: {
        userId,
        role: self.role,
        canInviteByPhone: canInviteByPhone(self.role),
        canApproveJoinRequests: canApproveJoinRequests(self.role),
      },
      members: rows.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        user: m.user,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar membros";
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
      res.status(400).json({ error: "Você já faz parte do grupo" });
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
