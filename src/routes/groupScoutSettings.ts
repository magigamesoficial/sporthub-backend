import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canEditGroupSettings } from "../lib/groupPermissions";
import { prisma } from "../lib/prisma";

export const groupScoutSettingsRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

const putBodySchema = z.object({
  enabledMetricDefinitionIds: z.array(z.string().cuid()),
});

groupScoutSettingsRouter.get("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, sport: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const [catalog, enabled] = await Promise.all([
      prisma.scoutMetricDefinition.findMany({
        where: { sport: group.sport, isActive: true },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      }),
      prisma.groupEnabledScout.findMany({
        where: { groupId },
        select: { scoutMetricDefinitionId: true },
      }),
    ]);

    const enabledSet = new Set(enabled.map((e) => e.scoutMetricDefinitionId));

    res.json({
      viewer: {
        canConfigure: canEditGroupSettings(member.role),
      },
      sport: group.sport,
      /** Estatísticas de ranking derivadas do resultado do jogo (sempre disponíveis). */
      coreStats: [
        { key: "games", label: "Jogos (confirmou presença)" },
        { key: "wins", label: "Vitórias" },
        { key: "draws", label: "Empates" },
        { key: "losses", label: "Derrotas" },
        { key: "points", label: "Pontos (3/1/0)" },
        { key: "winRate", label: "Aproveitamento (%)" },
      ],
      optionalMetrics: catalog.map((d) => ({
        id: d.id,
        key: d.key,
        label: d.label,
        sortOrder: d.sortOrder,
        isActive: d.isActive,
        enabled: enabledSet.has(d.id),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar scouts";
    res.status(500).json({ error: message });
  }
});

groupScoutSettingsRouter.put("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;

  const bodyParsed = putBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: bodyParsed.error.flatten() });
    return;
  }

  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member || !canEditGroupSettings(member.role)) {
    res.status(403).json({
      error: "Apenas presidente, vice, tesoureiro ou moderador podem configurar scouts.",
      code: "SCOUT_CONFIG_FORBIDDEN",
    });
    return;
  }

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, sport: true },
    });
    if (!group) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }

    const ids = bodyParsed.data.enabledMetricDefinitionIds;
    if (ids.length > 0) {
      const defs = await prisma.scoutMetricDefinition.findMany({
        where: { id: { in: ids }, sport: group.sport, isActive: true },
        select: { id: true },
      });
      if (defs.length !== ids.length) {
        res.status(400).json({
          error:
            "Alguma métrica não existe, é de outro esporte ou está desativada na plataforma.",
          code: "SCOUT_METRIC_INVALID",
        });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.groupEnabledScout.deleteMany({ where: { groupId } });
      if (ids.length > 0) {
        await tx.groupEnabledScout.createMany({
          data: ids.map((scoutMetricDefinitionId) => ({
            groupId,
            scoutMetricDefinitionId,
          })),
        });
      }
    });

    res.json({ ok: true, enabledCount: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao salvar scouts";
    res.status(500).json({ error: message });
  }
});
