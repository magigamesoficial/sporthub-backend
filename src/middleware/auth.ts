import { AccountStatus, type UserRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

/**
 * Exige header `Authorization: Bearer <access_token>`.
 * Preenche `req.auth` com `userId` e `role` do payload (assinado pelo servidor).
 * Contas bloqueadas ou banidas recebem 403 (tokens antigos deixam de valer na prática).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Autenticação necessária",
      code: "MISSING_TOKEN",
    });
    return;
  }

  const raw = header.slice("Bearer ".length).trim();
  if (!raw) {
    res.status(401).json({
      error: "Autenticação necessária",
      code: "MISSING_TOKEN",
    });
    return;
  }

  void (async () => {
    let payload: { sub: string; role: string };
    try {
      payload = verifyAccessToken(raw);
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) {
        res.status(401).json({
          error: "Sessão expirada. Faça login novamente.",
          code: "TOKEN_EXPIRED",
        });
        return;
      }
      res.status(401).json({
        error: "Token inválido ou corrompido",
        code: "INVALID_TOKEN",
      });
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { accountStatus: true, moderationReason: true },
      });
      if (!user) {
        res.status(401).json({
          error: "Conta não encontrada ou sessão inválida",
          code: "USER_NOT_FOUND",
        });
        return;
      }
      if (
        user.accountStatus === AccountStatus.BLOCKED ||
        user.accountStatus === AccountStatus.BANNED
      ) {
        res.status(403).json({
          error:
            user.accountStatus === AccountStatus.BANNED
              ? "Esta conta foi banida."
              : "Esta conta está suspensa.",
          code:
            user.accountStatus === AccountStatus.BANNED
              ? "ACCOUNT_BANNED"
              : "ACCOUNT_BLOCKED",
          reason: user.moderationReason,
        });
        return;
      }

      req.auth = {
        userId: payload.sub,
        role: payload.role as UserRole,
      };
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro ao validar sessão";
      res.status(500).json({ error: message });
    }
  })();
}

/**
 * Deve ser usado depois de `requireAuth`. Restringe a um ou mais papéis.
 */
export function requireRole(...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({
        error: "Autenticação necessária",
        code: "MISSING_TOKEN",
      });
      return;
    }

    if (!allowed.includes(req.auth.role)) {
      res.status(403).json({
        error: "Você não tem permissão para esta ação",
        code: "FORBIDDEN",
      });
      return;
    }

    next();
  };
}
