import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
