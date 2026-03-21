import { UserRole } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(UserRole.ADMIN));

adminRouter.get("/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, scope: "admin" });
});

const legalSlugSchema = z.enum(["terms", "privacy"]);

const createLegalSchema = z.object({
  slug: legalSlugSchema,
  title: z.string().trim().min(1, "Título obrigatório"),
  content: z.string().min(1, "Conteúdo obrigatório"),
  setActive: z.boolean(),
});

adminRouter.get("/legal-documents", async (_req: Request, res: Response) => {
  try {
    const docs = await prisma.legalDocument.findMany({
      orderBy: [{ slug: "asc" }, { version: "desc" }],
    });
    res.json({ documents: docs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar documentos";
    res.status(500).json({ error: message });
  }
});

adminRouter.post("/legal-documents", async (req: Request, res: Response) => {
  const parsed = createLegalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const { slug, title, content, setActive } = parsed.data;

  try {
    const doc = await prisma.$transaction(async (tx) => {
      const agg = await tx.legalDocument.aggregate({
        where: { slug },
        _max: { version: true },
      });
      const nextVersion = (agg._max.version ?? 0) + 1;

      if (setActive) {
        await tx.legalDocument.updateMany({
          where: { slug },
          data: { isActive: false },
        });
      }

      return tx.legalDocument.create({
        data: {
          slug,
          version: nextVersion,
          title,
          content,
          isActive: setActive,
        },
      });
    });

    res.status(201).json({ document: doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao criar documento";
    res.status(500).json({ error: message });
  }
});
