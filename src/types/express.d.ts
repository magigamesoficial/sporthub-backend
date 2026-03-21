import type { UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      /** Preenchido por `requireAuth` após validar o Bearer JWT. */
      auth?: {
        userId: string;
        role: UserRole;
      };
    }
  }
}

export {};
