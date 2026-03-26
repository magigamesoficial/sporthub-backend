import { AccountStatus, Sport, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ADMIN_RESET_PASSWORD_PLAIN } from "../lib/adminPasswordReset";
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

const scoutKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, "Chave: minúsculas, números e _; comece com letra")
  .max(64);

const createScoutSchema = z.object({
  sport: z.nativeEnum(Sport),
  key: scoutKeySchema,
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().optional(),
});

const patchScoutSchema = createScoutSchema
  .partial()
  .omit({ sport: true, key: true })
  .extend({
    isActive: z.boolean().optional(),
  });

adminRouter.get("/scout-metrics", async (req: Request, res: Response) => {
  const sportRaw = typeof req.query.sport === "string" ? req.query.sport : undefined;
  const sportParsed = sportRaw
    ? z.nativeEnum(Sport).safeParse(sportRaw)
    : { success: true as const, data: undefined };
  if (!sportParsed.success) {
    res.status(400).json({ error: "Esporte inválido" });
    return;
  }

  try {
    const rows = await prisma.scoutMetricDefinition.findMany({
      where: sportParsed.data ? { sport: sportParsed.data } : {},
      orderBy: [{ sport: "asc" }, { sortOrder: "asc" }, { label: "asc" }],
    });
    res.json({ metrics: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar métricas";
    res.status(500).json({ error: message });
  }
});

adminRouter.post("/scout-metrics", async (req: Request, res: Response) => {
  const parsed = createScoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  try {
    const row = await prisma.scoutMetricDefinition.create({
      data: {
        sport: parsed.data.sport,
        key: parsed.data.key,
        label: parsed.data.label,
        sortOrder: parsed.data.sortOrder ?? 0,
      },
    });
    res.status(201).json({ metric: row });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      res.status(409).json({ error: "Já existe métrica com esta chave neste esporte." });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao criar métrica";
    res.status(500).json({ error: message });
  }
});

adminRouter.patch("/scout-metrics/:id", async (req: Request, res: Response) => {
  const id = z.string().cuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const parsed = patchScoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Nada para atualizar" });
    return;
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.scoutMetricDefinition.update({
        where: { id: id.data },
        data: parsed.data,
      });
      if (parsed.data.isActive === false) {
        await tx.groupEnabledScout.deleteMany({
          where: { scoutMetricDefinitionId: id.data },
        });
      }
      return updated;
    });
    res.json({ metric: row });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      res.status(404).json({ error: "Métrica não encontrada" });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao atualizar métrica";
    res.status(500).json({ error: message });
  }
});

adminRouter.get("/meta/sports", (_req: Request, res: Response) => {
  res.json({ sports: Object.values(Sport) as Sport[] });
});

adminRouter.get("/users", async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        email: true,
        phone: true,
        fullName: true,
        role: true,
        accountStatus: true,
        moderationReason: true,
        moderatedAt: true,
        createdAt: true,
      },
    });
    res.json({ users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar usuários";
    res.status(500).json({ error: message });
  }
});

adminRouter.get("/groups", async (_req: Request, res: Response) => {
  try {
    const groups = await prisma.group.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        name: true,
        publicCode: true,
        visibility: true,
        sport: true,
        createdAt: true,
        president: {
          select: { id: true, fullName: true, email: true, phone: true },
        },
        _count: { select: { members: true } },
      },
    });
    res.json({ groups });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao listar grupos";
    res.status(500).json({ error: message });
  }
});

const accountStatusBodySchema = z.discriminatedUnion("accountStatus", [
  z.object({
    accountStatus: z.literal(AccountStatus.ACTIVE),
    reason: z.string().optional(),
  }),
  z.object({
    accountStatus: z.literal(AccountStatus.BLOCKED),
    reason: z.string().trim().min(3, "Motivo obrigatório (mín. 3 caracteres)"),
  }),
  z.object({
    accountStatus: z.literal(AccountStatus.BANNED),
    reason: z.string().trim().min(3, "Motivo obrigatório (mín. 3 caracteres)"),
  }),
]);

adminRouter.patch("/users/:id/account-status", async (req: Request, res: Response) => {
  const idParsed = z.string().cuid().safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const targetId = idParsed.data;
  const actorId = req.auth!.userId;

  if (targetId === actorId) {
    res.status(400).json({
      error: "Não é possível alterar o status da sua própria conta por aqui.",
      code: "SELF_FORBIDDEN",
    });
    return;
  }

  const parsed = accountStatusBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const now = new Date();
  const moderationReason =
    parsed.data.accountStatus === AccountStatus.ACTIVE ? null : parsed.data.reason;

  try {
    await prisma.user.update({
      where: { id: targetId },
      data: {
        accountStatus: parsed.data.accountStatus,
        moderationReason,
        moderatedAt: now,
      },
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao atualizar status";
    res.status(500).json({ error: message });
  }
});

adminRouter.post("/users/:id/reset-password", async (req: Request, res: Response) => {
  const idParsed = z.string().cuid().safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const targetId = idParsed.data;
  const actorId = req.auth!.userId;

  if (targetId === actorId) {
    res.status(400).json({
      error: "Para sua própria conta, altere a senha por um fluxo próprio no futuro.",
      code: "SELF_FORBIDDEN",
    });
    return;
  }

  const hash = await bcrypt.hash(ADMIN_RESET_PASSWORD_PLAIN, 12);

  try {
    await prisma.user.update({
      where: { id: targetId },
      data: { passwordHash: hash },
    });
    res.json({
      ok: true,
      temporaryPassword: ADMIN_RESET_PASSWORD_PLAIN,
      message: `Senha definida para a padrão temporária (${ADMIN_RESET_PASSWORD_PLAIN}).`,
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao redefinir senha";
    res.status(500).json({ error: message });
  }
});
