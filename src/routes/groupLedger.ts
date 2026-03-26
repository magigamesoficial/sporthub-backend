import { GroupMemberRole, LedgerEntryKind } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canManageMonthlyFees } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupLedgerRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

const yearMonthParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido (use YYYY-MM)");

const createEntrySchema = z.object({
  kind: z.nativeEnum(LedgerEntryKind),
  amountCents: z
    .number()
    .int("Valor deve ser inteiro (centavos)")
    .positive("Valor deve ser maior que zero")
    .max(100_000_000, "Valor muito alto"),
  description: z.string().trim().min(1, "Descrição obrigatória").max(500),
  occurredAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "Data inválida")
    .optional(),
});

function monthUtcRange(periodMonth: string): { start: Date; end: Date } {
  const [y, mo] = periodMonth.split("-").map(Number);
  const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));
  return { start, end };
}

async function requireGroupMember(
  groupId: string,
  userId: string,
): Promise<{ role: GroupMemberRole } | null> {
  return prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
}

groupLedgerRouter.get("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const rawMonth = req.query.month;
  const monthStr = Array.isArray(rawMonth) ? rawMonth[0] : rawMonth;
  const ymParsed = yearMonthParam.safeParse(monthStr ?? "");
  if (!ymParsed.success) {
    res.status(400).json({
      error: "Informe o mês na query: ?month=YYYY-MM",
      details: ymParsed.error.flatten(),
    });
    return;
  }
  const periodMonth = ymParsed.data;

  const member = await requireGroupMember(groupId, userId);
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  const { start, end } = monthUtcRange(periodMonth);

  try {
    const [cumulativeAgg, rows] = await Promise.all([
      prisma.groupLedgerEntry.groupBy({
        by: ["kind"],
        where: { groupId },
        _sum: { amountCents: true },
      }),
      prisma.groupLedgerEntry.findMany({
        where: {
          groupId,
          occurredAt: { gte: start, lte: end },
        },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        include: {
          recordedBy: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    let cumulativeIncome = 0;
    let cumulativeExpense = 0;
    for (const a of cumulativeAgg) {
      const sum = a._sum.amountCents ?? 0;
      if (a.kind === LedgerEntryKind.INCOME) cumulativeIncome = sum;
      if (a.kind === LedgerEntryKind.EXPENSE) cumulativeExpense = sum;
    }

    let monthIncome = 0;
    let monthExpense = 0;
    for (const r of rows) {
      if (r.kind === LedgerEntryKind.INCOME) monthIncome += r.amountCents;
      else monthExpense += r.amountCents;
    }

    res.json({
      periodMonth,
      viewer: {
        canManageLedger: canManageMonthlyFees(member.role),
      },
      cumulative: {
        incomeCents: cumulativeIncome,
        expenseCents: cumulativeExpense,
        balanceCents: cumulativeIncome - cumulativeExpense,
      },
      monthActivity: {
        incomeCents: monthIncome,
        expenseCents: monthExpense,
      },
      entries: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        amountCents: r.amountCents,
        description: r.description,
        occurredAt: r.occurredAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        recordedBy: r.recordedBy
          ? { id: r.recordedBy.id, fullName: r.recordedBy.fullName }
          : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar caixa";
    res.status(500).json({ error: message });
  }
});

groupLedgerRouter.post("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const actorId = req.auth!.userId;

  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const member = await requireGroupMember(groupId, actorId);
  if (!member || !canManageMonthlyFees(member.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice-presidente ou tesoureiro podem lançar no caixa.",
      code: "LEDGER_FORBIDDEN",
    });
    return;
  }

  const occurredAt = parsed.data.occurredAt
    ? new Date(parsed.data.occurredAt)
    : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    res.status(400).json({ error: "Data do lançamento inválida" });
    return;
  }

  try {
    const row = await prisma.groupLedgerEntry.create({
      data: {
        groupId,
        kind: parsed.data.kind,
        amountCents: parsed.data.amountCents,
        description: parsed.data.description.trim(),
        occurredAt,
        recordedByUserId: actorId,
      },
    });

    res.status(201).json({
      entry: {
        id: row.id,
        kind: row.kind,
        amountCents: row.amountCents,
        description: row.description,
        occurredAt: row.occurredAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao criar lançamento";
    res.status(500).json({ error: message });
  }
});

groupLedgerRouter.delete("/:entryId", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  const entryIdParsed = cuidParam.safeParse(req.params.entryId);
  if (!groupIdParsed.success || !entryIdParsed.success) {
    res.status(400).json({ error: "Parâmetros inválidos" });
    return;
  }
  const groupId = groupIdParsed.data;
  const entryId = entryIdParsed.data;
  const actorId = req.auth!.userId;

  const member = await requireGroupMember(groupId, actorId);
  if (!member || !canManageMonthlyFees(member.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice-presidente ou tesoureiro podem excluir lançamentos.",
      code: "LEDGER_FORBIDDEN",
    });
    return;
  }

  try {
    const deleted = await prisma.groupLedgerEntry.deleteMany({
      where: { id: entryId, groupId },
    });
    if (deleted.count === 0) {
      res.status(404).json({ error: "Lançamento não encontrado" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao excluir";
    res.status(500).json({ error: message });
  }
});
