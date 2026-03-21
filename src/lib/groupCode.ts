import { prisma } from "./prisma";

function randomSixDigits(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}

/**
 * Gera código público de 6 dígitos (000000–999999), único na tabela `groups`.
 */
export async function generateUniquePublicCode(maxAttempts = 80): Promise<string> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const code = randomSixDigits();
    const existing = await prisma.group.findUnique({
      where: { publicCode: code },
      select: { id: true },
    });
    if (!existing) {
      return code;
    }
  }
  throw new Error("Não foi possível gerar código único para o grupo");
}
