import jwt, { type SignOptions } from "jsonwebtoken";

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET é obrigatório em produção");
  }
  return secret ?? "dev-only-change-me";
}

export type AccessTokenPayload = {
  sub: string;
  role: string;
};

export function signAccessToken(payload: AccessTokenPayload, expiresIn: SignOptions["expiresIn"] = "7d"): string {
  const options: SignOptions = { expiresIn };
  return jwt.sign(payload, getJwtSecret(), options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, getJwtSecret());
  if (typeof decoded !== "object" || decoded === null || !("sub" in decoded)) {
    throw new Error("Token inválido");
  }
  const { sub, role } = decoded as AccessTokenPayload;
  if (typeof sub !== "string" || typeof role !== "string") {
    throw new Error("Token inválido");
  }
  return { sub, role };
}

type CaptchaJwtPayload = {
  typ: "captcha";
  n1: number;
  n2: number;
};

export function signCaptchaToken(n1: number, n2: number): string {
  const payload: CaptchaJwtPayload = { typ: "captcha", n1, n2 };
  const options: SignOptions = { expiresIn: "15m" };
  return jwt.sign(payload, getJwtSecret(), options);
}

export function verifyCaptchaToken(token: string): CaptchaJwtPayload {
  const decoded = jwt.verify(token, getJwtSecret());
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Captcha inválido");
  }
  const { typ, n1, n2 } = decoded as Record<string, unknown>;
  if (typ !== "captcha" || typeof n1 !== "number" || typeof n2 !== "number") {
    throw new Error("Captcha inválido");
  }
  return { typ, n1, n2 };
}
