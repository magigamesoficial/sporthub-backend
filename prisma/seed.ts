import { AccountStatus, PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { normalizeBrazilPhone } from "../src/lib/phone";

const prisma = new PrismaClient();

/**
 * Conta bootstrap do painel ADM em /admin/login (e-mail + senha).
 * O celular é só para cumprir @unique no banco — não use para login de atleta nem reserve para testes.
 * Login de atleta (/login) exige conta com role ATHLETE (ex.: após /cadastro).
 */
const PLATFORM_ADMIN = {
  email: "adminsporthub@gmail.com",
  password: "Sporthub@0411",
  /** Número claramente interno; não reutilize números reais de atletas. */
  phoneDigits: "11900000001",
  fullName: "Paulo Dionizio",
} as const;

async function main() {
  const termsExists = await prisma.legalDocument.findFirst({
    where: { slug: "terms", version: 1 },
  });
  if (!termsExists) {
    await prisma.legalDocument.create({
      data: {
        slug: "terms",
        version: 1,
        title: "Termos de uso",
        content:
          "Texto provisório dos termos de uso do SportHub. O administrador poderá alterar este conteúdo pelo painel. Ao criar conta, o atleta declara ter lido e aceito a versão vigente.",
        isActive: true,
      },
    });
  }

  const privacyExists = await prisma.legalDocument.findFirst({
    where: { slug: "privacy", version: 1 },
  });
  if (!privacyExists) {
    await prisma.legalDocument.create({
      data: {
        slug: "privacy",
        version: 1,
        title: "Política de privacidade",
        content:
          "Texto provisório da política de privacidade (LGPD). Será substituído por versão oficial pelo administrador. Descreve coleta, uso e direitos sobre dados pessoais.",
        isActive: true,
      },
    });
  }

  const termsActive = await prisma.legalDocument.findFirst({
    where: { slug: "terms", isActive: true },
    orderBy: { version: "desc" },
  });
  const privacyActive = await prisma.legalDocument.findFirst({
    where: { slug: "privacy", isActive: true },
    orderBy: { version: "desc" },
  });

  if (termsActive && privacyActive) {
    const emailNorm = PLATFORM_ADMIN.email.toLowerCase();
    /** E-mail que era usado no bootstrap antigo; se ainda existir como ADMIN, migra para `emailNorm`. */
    const legacyAdminEmail = "paulo.dionizio@live.com".toLowerCase();
    if (emailNorm !== legacyAdminEmail) {
      const alreadyNew = await prisma.user.findUnique({ where: { email: emailNorm } });
      const legacy = await prisma.user.findUnique({ where: { email: legacyAdminEmail } });
      if (!alreadyNew && legacy?.role === UserRole.ADMIN) {
        await prisma.user.update({
          where: { id: legacy.id },
          data: { email: emailNorm },
        });
        // eslint-disable-next-line no-console
        console.log(`Seed: e-mail do admin migrado de ${legacyAdminEmail} → ${emailNorm}.`);
      }
    }
    const phoneNorm = normalizeBrazilPhone(PLATFORM_ADMIN.phoneDigits);
    const passwordHash = await bcrypt.hash(PLATFORM_ADMIN.password, 12);
    const now = new Date();
    const birthDate = new Date("1990-04-11T12:00:00.000Z");

    const existingByEmail = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (existingByEmail) {
      await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          phone: phoneNorm,
          role: UserRole.ADMIN,
          accountStatus: AccountStatus.ACTIVE,
          passwordHash,
          termsVersion: termsActive.version,
          privacyVersion: privacyActive.version,
          termsAcceptedAt: now,
          privacyAcceptedAt: now,
        },
      });
      // eslint-disable-next-line no-console
      console.log(
        `Seed: admin existente atualizado (${emailNorm}) — celular ${phoneNorm}, ADMIN e senha redefinidos pelo seed.`,
      );
    } else {
      try {
        await prisma.user.create({
          data: {
            email: emailNorm,
            phone: phoneNorm,
            passwordHash,
            fullName: PLATFORM_ADMIN.fullName,
            birthDate,
            role: UserRole.ADMIN,
            accountStatus: AccountStatus.ACTIVE,
            termsVersion: termsActive.version,
            privacyVersion: privacyActive.version,
            termsAcceptedAt: now,
            privacyAcceptedAt: now,
          },
        });
        // eslint-disable-next-line no-console
        console.log(
          `Seed: conta admin criada — login em /admin/login: e-mail ${emailNorm} + senha do seed; celular ${phoneNorm} só cadastro.`,
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          "Seed: não foi possível criar o admin (telefone ou e-mail já usados?). Ajuste PLATFORM_ADMIN em prisma/seed.ts ou libere o registro.",
          e,
        );
      }
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "Seed: documentos legais ativos ausentes — pulando criação do admin bootstrap até existir terms + privacy vigentes.",
    );
  }

  const promoteEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (promoteEmail) {
    const r = await prisma.user.updateMany({
      where: { email: promoteEmail },
      data: { role: "ADMIN" },
    });
    if (r.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`Seed: usuário ${promoteEmail} promovido a ADMIN.`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
