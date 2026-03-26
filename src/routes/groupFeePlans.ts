import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canManageMonthlyFees } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupFeePlansRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

const createSchema = z.object({
  name: z.string().trim().min(1, "Nome obrigatório").max(80),
  amountCents: z.number().int().positive("Valor deve ser positivo (centavos)"),
  sortOrder: z.number().int().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  amountCents: z.number().int().positive().optional(),
  sortOrder: z.number().int().optional(),
});

async function requireMembership(groupId: string, userId: string) {
  return prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
}

groupFeePlansRouter.get("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const m = await requireMembership(groupId, userId);
  if (!m) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    const plans = await prisma.groupFeePlan.findMany({
      where: { groupId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({
      viewer: { canManage: canManageMonthlyFees(m.role) },
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        amountCents: p.amountCents,
        sortOrder: p.sortOrder,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar planos";
    res.status(500).json({ error: message });
  }
});

groupFeePlansRouter.post("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const m = await requireMembership(groupId, userId);
  if (!m || !canManageMonthlyFees(m.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice ou tesoureiro podem gerenciar planos de mensalidade.",
      code: "FEE_PLAN_FORBIDDEN",
    });
    return;
  }

  try {
    const p = await prisma.groupFeePlan.create({
      data: {
        groupId,
        name: parsed.data.name,
        amountCents: parsed.data.amountCents,
        sortOrder: parsed.data.sortOrder ?? 0,
      },
    });
    res.status(201).json({
      plan: {
        id: p.id,
        name: p.name,
        amountCents: p.amountCents,
        sortOrder: p.sortOrder,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao criar plano";
    res.status(500).json({ error: message });
  }
});

groupFeePlansRouter.patch("/:planId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const planIdParsed = cuidParam.safeParse(req.params.planId);
  if (!groupIdParsed.success || !planIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const planId = planIdParsed.data;
  const userId = req.auth!.userId;

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const m = await requireMembership(groupId, userId);
  if (!m || !canManageMonthlyFees(m.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice ou tesoureiro podem editar planos.",
      code: "FEE_PLAN_FORBIDDEN",
    });
    return;
  }

  try {
    const updated = await prisma.groupFeePlan.updateMany({
      where: { id: planId, groupId },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.amountCents !== undefined ? { amountCents: parsed.data.amountCents } : {}),
        ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      },
    });
    if (updated.count === 0) {
      res.status(404).json({ error: "Plano não encontrado" });
      return;
    }
    const p = await prisma.groupFeePlan.findFirst({ where: { id: planId, groupId } });
    res.json({
      plan: p
        ? {
            id: p.id,
            name: p.name,
            amountCents: p.amountCents,
            sortOrder: p.sortOrder,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao atualizar plano";
    res.status(500).json({ error: message });
  }
});

groupFeePlansRouter.delete("/:planId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const planIdParsed = cuidParam.safeParse(req.params.planId);
  if (!groupIdParsed.success || !planIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const planId = planIdParsed.data;
  const userId = req.auth!.userId;

  const m = await requireMembership(groupId, userId);
  if (!m || !canManageMonthlyFees(m.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice ou tesoureiro podem excluir planos.",
      code: "FEE_PLAN_FORBIDDEN",
    });
    return;
  }

  try {
    const inUse = await prisma.groupMember.count({
      where: { groupId, feePlanId: planId },
    });
    if (inUse > 0) {
      res.status(409).json({
        error: "Há membros usando este plano. Reatribua os planos antes de excluir.",
        code: "FEE_PLAN_IN_USE",
      });
      return;
    }

    const del = await prisma.groupFeePlan.deleteMany({
      where: { id: planId, groupId },
    });
    if (del.count === 0) {
      res.status(404).json({ error: "Plano não encontrado" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao excluir plano";
    res.status(500).json({ error: message });
  }
});
