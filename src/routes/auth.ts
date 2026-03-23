import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
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

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
      res.status(401).json({
        error: "Senha incorreta. Tente novamente.",
        code: "INVALID_PASSWORD",
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

authRouter.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        birthDate: true,
        createdAt: true,
        termsVersion: true,
        privacyVersion: true,
      },
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

