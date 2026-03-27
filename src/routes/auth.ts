import { AccountStatus, AttendanceStatus, Prisma, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
  computeGroupRankingSnapshot,
  sortRankingRowsByStanding,
} from "../lib/groupRankingCompute";
import { normalizeBrazilPhone } from "../lib/phone";
import { prisma } from "../lib/prisma";
import {
  signAccessToken,
  signCaptchaToken,
  verifyCaptchaToken,
} from "../lib/jwt";
import {
  authCaptchaLimiter,
  authLoginLimiter,
  authRegisterLimiter,
} from "../middleware/rateLimit";

export const authRouter = Router();

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

authRouter.get("/captcha", authCaptchaLimiter, (_req: Request, res: Response) => {
  try {
    const n1 = randomInt(1, 20);
    const n2 = randomInt(1, 20);
    const token = signCaptchaToken(n1, n2);
    res.json({
      token,
      prompt: `Quanto é ${n1} + ${n2}?`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao gerar captcha";
    res.status(500).json({ error: message });
  }
});

const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Nome muito curto"),
  email: z.string().trim().email("E-mail inválido"),
  phone: z.string().min(8, "Telefone inválido"),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data de nascimento use YYYY-MM-DD"),
  password: z.string().min(8, "Senha deve ter no mínimo 8 caracteres"),
  captchaToken: z.string().min(1, "Captcha obrigatório"),
  captchaAnswer: z.union([z.string(), z.number()]),
  acceptTerms: z
    .boolean()
    .refine((v) => v === true, { message: "Aceite os termos de uso" }),
  acceptPrivacy: z
    .boolean()
    .refine((v) => v === true, { message: "Aceite a política de privacidade" }),
});

authRouter.post("/register", authRegisterLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;

  let answerNum: number;
  if (typeof body.captchaAnswer === "number") {
    answerNum = body.captchaAnswer;
  } else {
    const trimmed = body.captchaAnswer.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      res.status(400).json({ error: "Resposta do captcha deve ser um número" });
      return;
    }
    answerNum = Number(trimmed);
  }

  try {
    const captcha = verifyCaptchaToken(body.captchaToken);
    if (answerNum !== captcha.n1 + captcha.n2) {
      res.status(400).json({ error: "Captcha incorreto" });
      return;
    }
  } catch {
    res.status(400).json({ error: "Captcha expirado ou inválido" });
    return;
  }

  let phoneNormalized: string;
  try {
    phoneNormalized = normalizeBrazilPhone(body.phone);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Telefone inválido";
    res.status(400).json({ error: message });
    return;
  }

  const emailNormalized = body.email.toLowerCase();

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
    res.status(503).json({ error: "Documentos legais não disponíveis" });
    return;
  }

  const birthDate = new Date(`${body.birthDate}T12:00:00.000Z`);
  if (Number.isNaN(birthDate.getTime())) {
    res.status(400).json({ error: "Data de nascimento inválida" });
    return;
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(body.password, 12);

  try {
    const user = await prisma.user.create({
      data: {
        fullName: body.fullName,
        email: emailNormalized,
        phone: phoneNormalized,
        passwordHash,
        birthDate,
        termsVersion: terms.version,
        privacyVersion: privacy.version,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
      },
    });

    const token = signAccessToken({ sub: user.id, role: user.role });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const fields = err.meta?.target;
      res.status(409).json({
        error: "E-mail ou telefone já cadastrado",
        fields,
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao criar conta";
    res.status(500).json({ error: message });
  }
});

const loginSchema = z.object({
  phone: z.string().min(8, "Telefone inválido"),
  password: z.string().min(1, "Senha obrigatória"),
});

authRouter.post("/login", authLoginLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  let phoneNormalized: string;
  try {
    phoneNormalized = normalizeBrazilPhone(parsed.data.phone);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Telefone inválido";
    res.status(400).json({ error: message });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { phone: phoneNormalized },
    });

    if (!user) {
      res.status(401).json({
        error:
          "Não encontramos uma conta com este celular. Confira o número com DDD ou crie uma conta.",
        code: "USER_NOT_FOUND",
      });
      return;
    }

    if (user.role === UserRole.ADMIN) {
      res.status(403).json({
        error:
          "Contas de administrador não entram com celular nesta rota. Use o acesso indicado pela direção.",
        code: "ADMIN_EMAIL_LOGIN_REQUIRED",
      });
      return;
    }

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
      res.status(401).json({
        error: "Senha incorreta. Tente novamente.",
        code: "INVALID_PASSWORD",
      });
      return;
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      res.status(403).json({
        error:
          user.accountStatus === AccountStatus.BANNED
            ? "Esta conta foi banida. Entre em contato com o suporte."
            : "Esta conta está suspensa. Entre em contato com o suporte.",
        code:
          user.accountStatus === AccountStatus.BANNED
            ? "ACCOUNT_BANNED"
            : "ACCOUNT_BLOCKED",
        reason: user.moderationReason,
      });
      return;
    }

    const token = signAccessToken({ sub: user.id, role: user.role });

    res.json({
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao entrar";
    res.status(500).json({ error: message });
  }
});

const adminLoginSchema = z.object({
  email: z.string().trim().email("E-mail inválido"),
  password: z.string().min(1, "Senha obrigatória"),
});

authRouter.post("/admin-login", authLoginLimiter, async (req: Request, res: Response) => {
  const parsed = adminLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const emailNormalized = parsed.data.email.toLowerCase();

  try {
    const user = await prisma.user.findUnique({
      where: { email: emailNormalized },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      res.status(401).json({
        error: "E-mail ou senha incorretos.",
        code: "ADMIN_LOGIN_FAILED",
      });
      return;
    }

    const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!passwordOk) {
      res.status(401).json({
        error: "E-mail ou senha incorretos.",
        code: "ADMIN_LOGIN_FAILED",
      });
      return;
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      res.status(403).json({
        error:
          user.accountStatus === AccountStatus.BANNED
            ? "Esta conta foi banida. Entre em contato com o suporte."
            : "Esta conta está suspensa. Entre em contato com o suporte.",
        code:
          user.accountStatus === AccountStatus.BANNED
            ? "ACCOUNT_BANNED"
            : "ACCOUNT_BLOCKED",
        reason: user.moderationReason,
      });
      return;
    }

    const token = signAccessToken({ sub: user.id, role: user.role });

    res.json({
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao entrar";
    res.status(500).json({ error: message });
  }
});

const meSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  birthDate: true,
  createdAt: true,
  termsVersion: true,
  privacyVersion: true,
} as const;

const patchMeSchema = z
  .object({
    fullName: z.string().trim().min(2, "Nome muito curto").optional(),
    email: z.string().trim().email("E-mail inválido").optional(),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD").optional(),
    currentPassword: z.string().optional(),
    newPassword: z.union([z.string().min(8, "Nova senha: mínimo 8 caracteres"), z.literal("")]).optional(),
  })
  .superRefine((data, ctx) => {
    const np = data.newPassword?.trim() ?? "";
    if (np.length > 0) {
      const cur = data.currentPassword?.trim() ?? "";
      if (cur.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe a senha atual para definir uma nova senha.",
          path: ["currentPassword"],
        });
      }
    }
  });

authRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: meSelect,
    });

    if (!user) {
      res.status(401).json({
        error: "Conta não encontrada ou sessão inválida",
        code: "USER_NOT_FOUND",
      });
      return;
    }

    res.json({ user });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao carregar perfil";
    res.status(500).json({ error: message });
  }
});

authRouter.patch("/me", requireAuth, async (req: Request, res: Response) => {
  if (req.auth!.role !== UserRole.ATHLETE) {
    res.status(403).json({
      error: "Alteração de perfil de atleta não se aplica a administradores.",
      code: "ADMIN_FORBIDDEN",
    });
    return;
  }

  const parsed = patchMeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Dados inválidos", details: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;
  const userId = req.auth!.userId;
  const newPw = body.newPassword?.trim() ?? "";

  const data: Prisma.UserUpdateInput = {};
  if (body.fullName !== undefined) data.fullName = body.fullName;
  if (body.birthDate !== undefined) {
    data.birthDate = new Date(`${body.birthDate}T12:00:00.000Z`);
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true },
    });
    if (!existing) {
      res.status(401).json({ error: "Conta não encontrada", code: "USER_NOT_FOUND" });
      return;
    }

    if (body.email !== undefined) {
      const emailNorm = body.email.toLowerCase();
      if (emailNorm !== existing.email) {
        const taken = await prisma.user.findUnique({ where: { email: emailNorm } });
        if (taken) {
          res.status(409).json({
            error: "Este e-mail já está em uso por outra conta.",
            code: "EMAIL_TAKEN",
          });
          return;
        }
      }
      data.email = emailNorm;
    }

    if (newPw.length > 0) {
      const cur = body.currentPassword ?? "";
      const ok = await bcrypt.compare(cur, existing.passwordHash);
      if (!ok) {
        res.status(401).json({
          error: "Senha atual incorreta.",
          code: "INVALID_PASSWORD",
        });
        return;
      }
      data.passwordHash = await bcrypt.hash(newPw, 12);
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "Nenhum dado para atualizar." });
      return;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: meSelect,
    });

    res.json({ user });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "E-mail já cadastrado.", code: "UNIQUE_VIOLATION" });
      return;
    }
    const message = err instanceof Error ? err.message : "Erro ao atualizar perfil";
    res.status(500).json({ error: message });
  }
});

/** Painel “Início” do atleta: jogos, esporte mais frequente, posição no ranking por grupo. */
authRouter.get("/me/dashboard", requireAuth, async (req: Request, res: Response) => {
  if (req.auth!.role !== UserRole.ATHLETE) {
    res.status(403).json({
      error: "Este painel é para atletas. Use o painel administrativo.",
      code: "ADMIN_FORBIDDEN",
    });
    return;
  }

  const userId = req.auth!.userId;
  const now = new Date();

  try {
    const gamesPlayed = await prisma.gameAttendance.count({
      where: {
        userId,
        status: AttendanceStatus.GOING,
        game: { startsAt: { lt: now } },
      },
    });

    const attendancesWithSport = await prisma.gameAttendance.findMany({
      where: {
        userId,
        status: AttendanceStatus.GOING,
        game: { startsAt: { lt: now } },
      },
      select: { game: { select: { group: { select: { sport: true } } } } },
    });
    const sportCount = new Map<string, number>();
    for (const a of attendancesWithSport) {
      const s = a.game.group.sport;
      sportCount.set(s, (sportCount.get(s) ?? 0) + 1);
    }
    const sportEntries = [...sportCount.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const topSport =
      sportEntries.length > 0
        ? { sport: sportEntries[0]![0], gamesCount: sportEntries[0]![1] }
        : null;

    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      select: { group: { select: { id: true, name: true, sport: true } } },
    });

    const groupRankings: {
      groupId: string;
      groupName: string;
      sport: string;
      rank: number;
      memberCount: number;
      points: number;
    }[] = [];

    for (const { group } of memberships) {
      const snap = await computeGroupRankingSnapshot(group.id, now);
      if (!snap) continue;
      const sorted = sortRankingRowsByStanding(snap.rows);
      const idx = sorted.findIndex((r) => r.userId === userId);
      if (idx < 0) continue;
      const meRow = sorted[idx]!;
      groupRankings.push({
        groupId: group.id,
        groupName: group.name,
        sport: group.sport,
        rank: idx + 1,
        memberCount: sorted.length,
        points: meRow.points,
      });
    }
    groupRankings.sort((a, b) =>
      a.groupName.localeCompare(b.groupName, "pt-BR", { sensitivity: "base" }),
    );

    res.json({
      gamesPlayed,
      topSport,
      groupRankings,
      groupsCount: memberships.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao montar painel";
    res.status(500).json({ error: message });
  }
});

