import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canManageMonthlyFees } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupFeesRouter = Router({ mergeParams: true });

const yearMonthParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido (use YYYY-MM)");

const markUserBodySchema = z.object({
  userId: z.string().cuid("ID de usuário inválido"),
});

groupFeesRouter.get("/:yearMonth", async (req: Request, res: Response) => {
  const ymParsed = yearMonthParam.safeParse(req.params.yearMonth);
  if (!ymParsed.success) {
    res.status(400).json({ error: "Mês inválido", details: ymParsed.error.flatten() });
    return;
  }
  const periodMonth = ymParsed.data;
  const groupId = req.params.groupId as string;
  const viewerId = req.auth!.userId;

  try {
    const self = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: viewerId } },
    });
    if (!self) {
      res.status(403).json({ error: "Você não participa deste grupo" });
      return;
    }

    const [members, fees] = await Promise.all([
      prisma.groupMember.findMany({
        where: { groupId },
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.memberMonthlyFee.findMany({
        where: { groupId, periodMonth },
        include: {
          recordedBy: { select: { fullName: true } },
        },
      }),
    ]);

    const feeByUser = new Map(fees.map((f) => [f.userId, f]));

    res.json({
      periodMonth,
      viewer: {
        canManageMonthlyFees: canManageMonthlyFees(self.role),
      },
      rows: members.map((m) => {
        const f = feeByUser.get(m.userId);
        return {
          userId: m.user.id,
          fullName: m.user.fullName,
          phone: m.user.phone,
          role: m.role,
          paid: Boolean(f),
          paidAt: f?.paidAt.toISOString() ?? null,
          recordedByName: f?.recordedBy?.fullName ?? null,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar mensalidades";
    res.status(500).json({ error: message });
  }
});

groupFeesRouter.post("/:yearMonth/mark-paid", async (req: Request, res: Response) => {
  const ymParsed = yearMonthParam.safeParse(req.params.yearMonth);
  if (!ymParsed.success) {
    res.status(400).json({ error: "Mês inválido", details: ymParsed.error.flatten() });
    return;
  }
  const periodMonth = ymParsed.data;
  const groupId = req.params.groupId as string;
  const actorId = req.auth!.userId;

  const bodyParsed = markUserBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: bodyParsed.error.flatten() });
    return;
  }
  const targetUserId = bodyParsed.data.userId;

  try {
    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canManageMonthlyFees(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice-presidente ou tesoureiro podem registrar pagamento.",
        code: "FEE_MANAGE_FORBIDDEN",
      });
      return;
    }

    const targetMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });
    if (!targetMembership) {
      res.status(404).json({
        error: "Este atleta não faz parte do grupo.",
        code: "NOT_GROUP_MEMBER",
      });
      return;
    }

    const row = await prisma.memberMonthlyFee.upsert({
      where: {
        groupId_userId_periodMonth: { groupId, userId: targetUserId, periodMonth },
      },
      create: {
        groupId,
        userId: targetUserId,
        periodMonth,
        recordedByUserId: actorId,
      },
      update: {
        paidAt: new Date(),
        recordedByUserId: actorId,
      },
    });

    res.status(201).json({
      fee: {
        userId: row.userId,
        periodMonth: row.periodMonth,
        paidAt: row.paidAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao registrar pagamento";
    res.status(500).json({ error: message });
  }
});

groupFeesRouter.post("/:yearMonth/mark-unpaid", async (req: Request, res: Response) => {
  const ymParsed = yearMonthParam.safeParse(req.params.yearMonth);
  if (!ymParsed.success) {
    res.status(400).json({ error: "Mês inválido", details: ymParsed.error.flatten() });
    return;
  }
  const periodMonth = ymParsed.data;
  const groupId = req.params.groupId as string;
  const actorId = req.auth!.userId;

  const bodyParsed = markUserBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: bodyParsed.error.flatten() });
    return;
  }
  const targetUserId = bodyParsed.data.userId;

  try {
    const actorMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: actorId } },
    });
    if (!actorMembership || !canManageMonthlyFees(actorMembership.role)) {
      res.status(403).json({
        error: "Apenas presidente, vice-presidente ou tesoureiro podem alterar o status.",
        code: "FEE_MANAGE_FORBIDDEN",
      });
      return;
    }

    const deleted = await prisma.memberMonthlyFee.deleteMany({
      where: { groupId, userId: targetUserId, periodMonth },
    });

    res.json({ ok: true, removed: deleted.count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao remover registro";
    res.status(500).json({ error: message });
  }
});
