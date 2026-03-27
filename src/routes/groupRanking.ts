import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { computeGroupRankingSnapshot } from "../lib/groupRankingCompute";
import { prisma } from "../lib/prisma";

export const groupRankingRouter = Router({ mergeParams: true });

const cuidParam = z.string().cuid("ID inválido");

groupRankingRouter.get("/", async (req: Request, res: Response) => {
  const groupIdParsed = cuidParam.safeParse(req.params.groupId);
  if (!groupIdParsed.success) {
    res.status(400).json({ error: "ID de grupo inválido" });
    return;
  }
  const groupId = groupIdParsed.data;
  const userId = req.auth!.userId;
  const now = new Date();

  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member) {
    res.status(403).json({ error: "Você não participa deste grupo" });
    return;
  }

  try {
    const snapshot = await computeGroupRankingSnapshot(groupId, now);
    if (!snapshot) {
      res.status(404).json({ error: "Grupo não encontrado" });
      return;
    }
    res.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao calcular classificação";
    res.status(500).json({ error: message });
  }
});
