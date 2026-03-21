import type { UserRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { verifyAccessToken } from "../lib/jwt";

/**
 * Exige header `Authorization: Bearer <access_token>`.
 * Preenche `req.auth` com `userId` e `role` do payload (assinado pelo servidor).
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

  try {
    const payload = verifyAccessToken(raw);
    req.auth = {
      userId: payload.sub,
      role: payload.role as UserRole,
    };
    next();
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
  }
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
