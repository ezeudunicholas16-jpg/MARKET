import { PrismaClient, AssetClass } from "@prisma/client";

const prisma = new PrismaClient();

const assets = [
  { symbol: "AAPL", name: "Apple Inc.", assetClass: AssetClass.EQUITY, sector: "Technology", exchange: "NASDAQ" },
  { symbol: "NVDA", name: "NVIDIA Corporation", assetClass: AssetClass.EQUITY, sector: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "TSLA", name: "Tesla Inc.", assetClass: AssetClass.EQUITY, sector: "Automobiles", exchange: "NASDAQ" },
  { symbol: "EURUSD", name: "Euro / U.S. Dollar", assetClass: AssetClass.FOREX, baseCurrency: "EUR", quoteCurrency: "USD" },
  { symbol: "GBPUSD", name: "British Pound / U.S. Dollar", assetClass: AssetClass.FOREX, baseCurrency: "GBP", quoteCurrency: "USD" },
  { symbol: "GOLD", name: "Gold Spot", assetClass: AssetClass.COMMODITY },
  { symbol: "OIL", name: "WTI Crude Oil", assetClass: AssetClass.COMMODITY },
  { symbol: "NATGAS", name: "Natural Gas", assetClass: AssetClass.COMMODITY },
  { symbol: "DXY", name: "U.S. Dollar Index", assetClass: AssetClass.INDEX }
];

async function main() {
  for (const asset of assets) {
    const saved = await prisma.asset.upsert({
      where: { symbol: asset.symbol },
      update: asset,
      create: asset
    });

    await prisma.watchlistItem.upsert({
      where: {
        symbol_assetClass: {
          symbol: asset.symbol,
          assetClass: asset.assetClass
        }
      },
      update: {
        assetId: saved.id,
        isActive: true
      },
      create: {
        assetId: saved.id,
        symbol: asset.symbol,
        assetClass: asset.assetClass,
        reason: "Seed watchlist asset",
        priority: asset.assetClass === AssetClass.EQUITY ? 4 : 5
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
