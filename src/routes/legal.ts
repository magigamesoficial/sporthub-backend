import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma";

export const legalRouter = Router();

legalRouter.get("/active", async (_req: Request, res: Response) => {
  try {
    const [terms, privacy] = await Promise.all([
      prisma.legalDocument.findFirst({
        where: { slug: "terms", isActive: true },
        orderBy: { version: "desc" },
      }),
      prisma.legalDocument.findFirst({
        where: { slug: "privacy", isActive: true },
        orderBy: { version: "desc" },
      }),
    ]);

    if (!terms || !privacy) {
      res.status(503).json({
        error: "Documentos legais não configurados. Execute o seed ou cadastre no admin.",
      });
      return;
    }

    res.json({
      terms: {
        version: terms.version,
        title: terms.title,
        content: terms.content,
      },
      privacy: {
        version: privacy.version,
        title: privacy.title,
        content: privacy.content,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao carregar documentos";
    res.status(500).json({ error: message });
  }
});
