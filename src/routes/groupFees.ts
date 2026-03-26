import { LedgerEntryKind } from "@prisma/client";
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
          feePlan: { select: { id: true, name: true, amountCents: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.memberMonthlyFee.findMany({
        where: { groupId, periodMonth },
        include: {
          recordedBy: { select: { fullName: true } },
          feePlan: { select: { id: true, name: true, amountCents: true } },
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
          feePlan: m.feePlan
            ? {
                id: m.feePlan.id,
                name: m.feePlan.name,
                amountCents: m.feePlan.amountCents,
              }
            : null,
          paid: Boolean(f),
          paidAt: f?.paidAt.toISOString() ?? null,
          paidWithPlan: f?.feePlan
            ? {
                id: f.feePlan.id,
                name: f.feePlan.name,
                amountCents: f.feePlan.amountCents,
              }
            : null,
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
      include: {
        feePlan: true,
        user: { select: { fullName: true } },
      },
    });
    if (!targetMembership) {
      res.status(404).json({
        error: "Este atleta não faz parte do grupo.",
        code: "NOT_GROUP_MEMBER",
      });
      return;
    }

    if (!targetMembership.feePlanId || !targetMembership.feePlan) {
      res.status(400).json({
        error:
          "Defina um plano de mensalidade para este membro antes de registrar o pagamento.",
        code: "MEMBER_NEED_FEE_PLAN",
      });
      return;
    }

    const plan = targetMembership.feePlan;

    const row = await prisma.$transaction(async (tx) => {
      const fee = await tx.memberMonthlyFee.upsert({
        where: {
          groupId_userId_periodMonth: { groupId, userId: targetUserId, periodMonth },
        },
        create: {
          groupId,
          userId: targetUserId,
          periodMonth,
          feePlanId: plan.id,
          recordedByUserId: actorId,
        },
        update: {
          paidAt: new Date(),
          recordedByUserId: actorId,
          feePlanId: plan.id,
        },
      });

      const desc = `Mensalidade (${plan.name}) — ${targetMembership.user.fullName} — ${periodMonth}`;
      const existing = await tx.groupLedgerEntry.findUnique({
        where: { memberMonthlyFeeId: fee.id },
      });
      if (existing) {
        await tx.groupLedgerEntry.update({
          where: { id: existing.id },
          data: {
            amountCents: plan.amountCents,
            description: desc.slice(0, 500),
            occurredAt: new Date(),
            recordedByUserId: actorId,
          },
        });
      } else {
        await tx.groupLedgerEntry.create({
          data: {
            groupId,
            kind: LedgerEntryKind.INCOME,
            amountCents: plan.amountCents,
            description: desc.slice(0, 500),
            occurredAt: new Date(),
            recordedByUserId: actorId,
            memberMonthlyFeeId: fee.id,
          },
        });
      }

      return fee;
    });

    res.status(201).json({
      fee: {
        userId: row.userId,
        periodMonth: row.periodMonth,
        paidAt: row.paidAt.toISOString(),
        feePlanId: plan.id,
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
