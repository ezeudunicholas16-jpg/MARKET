import { PrismaClient, AssetClass } from "@prisma/client";

const prisma = new PrismaClient();

const assets = [
  { symbol: "AAPL", name: "Apple Inc.", assetClass: AssetClass.EQUITY, sector: "Technology", exchange: "NASDAQ" },
  { symbol: "NVDA", name: "NVIDIA Corporation", assetClass: AssetClass.EQUITY, sector: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "TSLA", name: "Tesla Inc.", assetClass: AssetClass.EQUITY, sector: "Automobiles", exchange: "NASDAQ" },
  { symbol: "MSFT", name: "Microsoft Corporation", assetClass: AssetClass.EQUITY, sector: "Technology", exchange: "NASDAQ" },
  { symbol: "META", name: "Meta Platforms Inc.", assetClass: AssetClass.EQUITY, sector: "Communication Services", exchange: "NASDAQ" },
  { symbol: "AMZN", name: "Amazon.com Inc.", assetClass: AssetClass.EQUITY, sector: "Consumer Discretionary", exchange: "NASDAQ" },
  { symbol: "GOOGL", name: "Alphabet Inc.", assetClass: AssetClass.EQUITY, sector: "Communication Services", exchange: "NASDAQ" },
  { symbol: "AMD", name: "Advanced Micro Devices Inc.", assetClass: AssetClass.EQUITY, sector: "Semiconductors", exchange: "NASDAQ" },
  { symbol: "EURUSD", name: "Euro / U.S. Dollar", assetClass: AssetClass.FOREX, baseCurrency: "EUR", quoteCurrency: "USD" },
  { symbol: "GBPUSD", name: "British Pound / U.S. Dollar", assetClass: AssetClass.FOREX, baseCurrency: "GBP", quoteCurrency: "USD" },
  { symbol: "USDJPY", name: "U.S. Dollar / Japanese Yen", assetClass: AssetClass.FOREX, baseCurrency: "USD", quoteCurrency: "JPY" },
  { symbol: "USDCAD", name: "U.S. Dollar / Canadian Dollar", assetClass: AssetClass.FOREX, baseCurrency: "USD", quoteCurrency: "CAD" },
  { symbol: "AUDUSD", name: "Australian Dollar / U.S. Dollar", assetClass: AssetClass.FOREX, baseCurrency: "AUD", quoteCurrency: "USD" },
  { symbol: "GOLD", name: "Gold Spot", assetClass: AssetClass.COMMODITY },
  { symbol: "SILVER", name: "Silver Spot", assetClass: AssetClass.COMMODITY },
  { symbol: "OIL", name: "WTI Crude Oil", assetClass: AssetClass.COMMODITY },
  { symbol: "NATGAS", name: "Natural Gas", assetClass: AssetClass.COMMODITY },
  { symbol: "SPX", name: "S&P 500 Index", assetClass: AssetClass.INDEX },
  { symbol: "NDX", name: "Nasdaq 100 Index", assetClass: AssetClass.INDEX },
  { symbol: "DJI", name: "Dow Jones Industrial Average", assetClass: AssetClass.INDEX },
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
