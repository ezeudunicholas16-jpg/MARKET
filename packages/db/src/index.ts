import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export { PrismaClient };

export function getPrismaClient(): PrismaClient {
  prisma ??= new PrismaClient();
  return prisma;
}
