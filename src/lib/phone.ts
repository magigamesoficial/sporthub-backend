/**
 * Normaliza telefone brasileiro para dígitos com DDI 55 (ex.: 5511987654321).
 */
export function normalizeBrazilPhone(input: string): string {
  const digits = input.replace(/\D/g, "");

  if (digits.length === 0) {
    throw new Error("Telefone inválido");
  }

  if (digits.startsWith("55") && digits.length >= 12) {
    return digits.slice(0, 13);
  }

  if (digits.length === 11 || digits.length === 10) {
    return `55${digits}`;
  }

  throw new Error("Telefone inválido: use DDD + número (Brasil)");
}
