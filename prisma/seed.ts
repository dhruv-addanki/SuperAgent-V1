import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { whatsappPhone: "+15555550100" },
    update: {},
    create: {
      whatsappPhone: "+15555550100",
      timezone: "America/New_York"
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
