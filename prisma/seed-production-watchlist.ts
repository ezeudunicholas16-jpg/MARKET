import { PrismaClient, AssetClass } from "@prisma/client";

const prisma = new PrismaClient();

const defaultSymbols = [
  "AAPL",
  "NVDA",
  "TSLA",
  "MSFT",
  "META",
  "AMZN",
  "GOOGL",
  "AMD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCAD",
  "AUDUSD",
  "GOLD",
  "SILVER",
  "OIL",
  "NATGAS",
  "SPX",
  "NDX",
  "DJI",
  "DXY"
];
const symbols = (process.env.PRODUCTION_WATCHLIST ?? defaultSymbols.join(","))
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

async function main() {
  for (const symbol of symbols) {
    const assetClass = inferAssetClass(symbol);
    const saved = await prisma.asset.upsert({
      where: { symbol },
      update: { isActive: true, assetClass },
      create: {
        symbol,
        name: symbol,
        assetClass,
        isActive: true
      }
    });

    await prisma.watchlistItem.upsert({
      where: {
        symbol_assetClass: {
          symbol,
          assetClass
        }
      },
      update: {
        assetId: saved.id,
        isActive: true,
        reason: "Production watchlist seed"
      },
      create: {
        assetId: saved.id,
        symbol,
        assetClass,
        reason: "Production watchlist seed",
        priority: 5,
        isActive: true
      }
    });
  }

  console.log(`Seeded ${symbols.length} production watchlist assets.`);
}

function inferAssetClass(symbol: string): AssetClass {
  if (["GOLD", "SILVER", "OIL", "NATGAS"].includes(symbol)) {
    return AssetClass.COMMODITY;
  }
  if (/^[A-Z]{6}$/.test(symbol) && !["NATGAS"].includes(symbol)) {
    return AssetClass.FOREX;
  }
  if (["DXY", "SPX", "NDX", "DJI", "RUT"].includes(symbol)) {
    return AssetClass.INDEX;
  }
  return AssetClass.EQUITY;
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
