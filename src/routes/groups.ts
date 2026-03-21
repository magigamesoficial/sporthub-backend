import { GroupMemberRole, GroupVisibility, Sport } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateUniquePublicCode } from "../lib/groupCode";
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
