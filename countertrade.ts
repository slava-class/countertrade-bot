import { parseArgs } from "node:util";
import {
  DefaultLogger,
  type OrderParamsV5,
  type OrderSideV5,
  type OrderStatusV5,
  type OrderTypeV5,
  RestClientV5,
  type WSAccountOrderEventV5,
  type WSAccountOrderV5,
  WebsocketClient,
} from "bybit-api";
import { Bot } from "grammy";
import * as winston from "winston";
import { version } from "./package.json";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    mainnet: {
      type: "boolean",
    },
  },
  strict: true,
  allowPositionals: true,
});

const logger = winston.createLogger({
  level: "",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.prettyPrint(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "countertrade-bot.log" }),
  ],
});

logger.info(`Running countertrade-bot version ${version}`);

const LOGGING_ENABLED = false;
// If we don't specify --mainnet, default to testnet
const USE_TESTNET = values.mainnet === undefined ? true : !values.mainnet;
const USE_BYBIT_GLOBAL = true;

const ASSUMING_COIN = "USDT";

let BASE_URL = USE_TESTNET
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

let WS_URL = USE_TESTNET
  ? "wss://stream-testnet.bybit.com/v5/private"
  : "wss://stream.bybit.com/v5/private";
if (USE_BYBIT_GLOBAL) {
  BASE_URL = USE_TESTNET
    ? "https://api-testnet.bybitglobal.com"
    : "https://api.bybitglobal.com";

  WS_URL = USE_TESTNET
    ? "wss://stream-testnet.bybitglobal.com/v5/private"
    : "wss://stream.bybitglobal.com/v5/private";
}

const TRADING_SUBACCOUNT_API_KEY = process.env.TRADING_SUBACCOUNT_API_KEY;
const TRADING_SUBACCOUNT_API_SECRET = process.env.TRADING_SUBACCOUNT_API_SECRET;

const COUNTERTRADING_SUBACCOUNT_API_KEY =
  process.env.COUNTERTRADING_SUBACCOUNT_API_KEY;
const COUNTERTRADING_SUBACCOUNT_API_SECRET =
  process.env.COUNTERTRADING_SUBACCOUNT_API_SECRET;

if (!TRADING_SUBACCOUNT_API_KEY) {
  logger.error("TRADING_SUBACCOUNT_API_KEY is not set");
  process.exit(1);
}

if (!TRADING_SUBACCOUNT_API_SECRET) {
  logger.error("TRADING_SUBACCOUNT_API_SECRET is not set");
  process.exit(1);
}

if (!COUNTERTRADING_SUBACCOUNT_API_KEY) {
  logger.error("COUNTERTRADING_SUBACCOUNT_API_KEY is not set");
  process.exit(1);
}

if (!COUNTERTRADING_SUBACCOUNT_API_SECRET) {
  logger.error("COUNTERTRADING_SUBACCOUNT_API_SECRET is not set");
  process.exit(1);
}

const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
let bot: Bot | null = null;
if (TELEGRAM_ENABLED) {
  bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
  if (!TELEGRAM_CHANNEL_ID) {
    logger.error("TELEGRAM_CHANNEL_ID is not set but bot is enabled, quitting");
    process.exit(1);
  } else {
    logger.info(`Telegram bot enabled, channel ID: ${TELEGRAM_CHANNEL_ID}`);
  }
} else {
  logger.error("TELEGRAM_BOT_TOKEN is not set, bot will not run");
}

const RECONNECT_TIMEOUT = 5000;

const customLogger = {
  ...DefaultLogger,
};

if (LOGGING_ENABLED === false) {
  customLogger.info = () => {};
  customLogger.silly = () => {};
  customLogger.notice = () => {};
}

const counterRestClient = new RestClientV5({
  key: COUNTERTRADING_SUBACCOUNT_API_KEY,
  secret: COUNTERTRADING_SUBACCOUNT_API_SECRET,
  testnet: USE_TESTNET,
  baseUrl: BASE_URL,
});

const tradingRestClient = new RestClientV5({
  key: TRADING_SUBACCOUNT_API_KEY,
  secret: TRADING_SUBACCOUNT_API_SECRET,
  testnet: USE_TESTNET,
  baseUrl: BASE_URL,
});

const tradingWsClient = new WebsocketClient(
  {
    key: TRADING_SUBACCOUNT_API_KEY,
    secret: TRADING_SUBACCOUNT_API_SECRET,
    testnet: USE_TESTNET,
    market: "v5",
    reconnectTimeout: RECONNECT_TIMEOUT,
    wsUrl: WS_URL,
    restOptions: {
      baseUrl: BASE_URL,
    },
  },
  customLogger,
);

checkFetchBalances();

async function checkFetchBalances() {
  const tradingBalance = await getBalanceOfCoin(
    tradingRestClient,
    ASSUMING_COIN,
    "trading",
  );
  console.log({ tradingBalance });
  const counterTradingBalance = await getBalanceOfCoin(
    counterRestClient,
    ASSUMING_COIN,
    "counter",
  );
  console.log({ counterTradingBalance });

  // console.log({ tradingBalance, counterTradingBalance });
  process.exit(0);
}

// Subscribe to the private linear perps order channel
tradingWsClient.subscribeV5(["order"], "linear", true);

tradingWsClient.on("update", async (data: WSAccountOrderEventV5) => {
  for (const orderData of data.data) {
    if (respondToOrder(orderData)) {
      logger.info("New original order detected:", orderData);
      const telegramMessage = `
      Original Order:
      ${orderData.side} ${orderData.symbol}
      Size: ${orderData.qty}
      Entry: ${orderData.price || "Market"}
      TP: ${orderData.takeProfit || "None"}
      SL: ${orderData.stopLoss || "None"}
      `;

      await sendTelegramMessage(telegramMessage);
      await placeCounterOrder(orderData);
    }
  }
});

tradingWsClient.on("error", (err) => {
  logger.error("WebSocket error:", err);
});

tradingWsClient.on("open", () => {
  logger.info("WebSocket connection opened");
});

tradingWsClient.on("close", () => {
  logger.info("WebSocket connection closed");
});

tradingWsClient.on("reconnected", () => {
  logger.info("WebSocket reconnected");
});

tradingWsClient.connectAll();
logger.info("Counter trading bot is running. Waiting for new orders...");

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down gracefully...");
  tradingWsClient.closeAll();
  process.exit(0);
});

if (TELEGRAM_ENABLED && bot) {
  bot.start();
  logger.info("Telegram bot started");
}

const OrderStatusToRespondTo: OrderStatusV5[] = [
  "New",
  "Filled",
  "PartiallyFilled",
  "Created",
];

function respondToOrder(orderData: WSAccountOrderV5): boolean {
  return (
    OrderStatusToRespondTo.includes(orderData.orderStatus) &&
    orderData.createType === "CreateByUser" &&
    !orderData.orderLinkId.startsWith("counter_")
  );
}

async function placeCounterOrder(orderData: WSAccountOrderV5) {
  // Calculate the counter position size
  // const counterQty = (
  //   Number.parseFloat(orderData.qty) * COUNTER_MULTIPLIER
  // ).toString();

  const tradingAccountBalance = await getBalanceOfCoin(
    tradingRestClient,
    ASSUMING_COIN,
    "trading",
  );

  if (tradingAccountBalance === null) {
    logger.error("Error fetching trading account balance");
    return;
  }

  const tradeValue = Number.parseFloat(orderData.cumExecValue);

  const marginPercentage = tradeValue / tradingAccountBalance.equity;

  const countertradeAccountBalance = await getBalanceOfCoin(
    counterRestClient,
    ASSUMING_COIN,
    "counter",
  );

  if (countertradeAccountBalance === null) {
    logger.error("Error fetching counter-trading account balance");
    return;
  }

  const counterTradeValue =
    countertradeAccountBalance.equity * marginPercentage;

  const symbolInfo = await getSymbolInfo(orderData.symbol);
  const {
    maxOrderQty,
    minOrderQty,
    qtyStep,
    maxMktOrderQty,
    minNotionalValue,
  } = symbolInfo.lotSizeFilter;

  const maxQty = Number(maxOrderQty);
  const minQty = Number(minOrderQty);
  const step = Number(qtyStep);
  const maxMarketQty = Number(maxMktOrderQty);
  const minNotional = Number(minNotionalValue);

  // Initial calculation
  const initialCounterQty = counterTradeValue / +orderData.price;

  // Round to the nearest step
  const steppedCounterQty = Math.round(initialCounterQty / step) * step;

  // Ensure it's within min and max bounds
  const boundedCounterQty = Math.max(
    minQty,
    Math.min(maxQty, steppedCounterQty),
  );

  // Check if it's a market order and apply the market order limit
  const marketAdjustedCounterQty =
    orderData.orderType === "Market"
      ? Math.min(boundedCounterQty, maxMarketQty)
      : boundedCounterQty;

  // Ensure the notional value meets the minimum
  const notionalValue = marketAdjustedCounterQty * +orderData.price;
  const minNotionalAdjustedCounterQty =
    notionalValue < minNotional
      ? Math.ceil(minNotional / +orderData.price / step) * step
      : marketAdjustedCounterQty;

  // Final check to ensure we're still within bounds after adjustments
  const finalCounterQty = Math.max(
    minQty,
    Math.min(maxQty, minNotionalAdjustedCounterQty),
  );

  const counterQtyString = finalCounterQty.toFixed(getDecimalPlaces(step));
  // const info = {
  //   tradingAccountBalance,
  //   countertradeAccountBalance,
  //   tradeValue,
  //   marginPercentage,
  //   counterTradeValue,
  //   initialCounterQty,
  //   lotSizeInfo: symbolInfo.lotSizeFilter,
  //   finalCounterQty,
  //   counterQtyString,
  //   symbol: orderData.symbol,
  // };

  // sendTelegramMessage(JSON.stringify(info, null, 2));

  // Counter the side (Buy becomes Sell, and vice versa)
  const counterSide: OrderSideV5 = orderData.side === "Buy" ? "Sell" : "Buy";

  // Swap take profit and stop loss
  const counterTakeProfit = orderData.stopLoss;
  const counterStopLoss = orderData.takeProfit;

  const counterOrder: OrderParamsV5 = {
    category: "linear",
    symbol: orderData.symbol,
    side: counterSide,
    orderType: orderData.orderType as OrderTypeV5,
    qty: counterQtyString,
    price: orderData.orderType === "Limit" ? orderData.price : undefined,
    takeProfit: counterTakeProfit,
    stopLoss: counterStopLoss,
    // tpTriggerBy: orderData.slTriggerBy as OrderTriggerByV5,
    // slTriggerBy: orderData.tpTriggerBy as OrderTriggerByV5,
    positionIdx: orderData.positionIdx,
    timeInForce: orderData.timeInForce,
    reduceOnly: false,
    closeOnTrigger: false,
    tpslMode: "Partial",
    orderLinkId: `counter_${orderData.orderId}`, // Link to original order
  };

  logger.info("Placing counter order:", counterOrder);
  const telegramMessage = `
${counterOrder.side} ${counterOrder.symbol}
Size: ${counterOrder.qty}
Entry: ${counterOrder.price || "Market"}
TP: ${counterOrder.takeProfit || "None"}
SL: ${counterOrder.stopLoss || "None"}
`;

  await sendTelegramMessage(telegramMessage);
  try {
    const response = await counterRestClient.submitOrder(counterOrder);
    switch (response.retCode) {
      case 110007: {
        logger.warn("Insufficent balance in countertrade account for order");
        break;
      }
      default: {
        logger.info("Countertrade result code", response.retCode);
        logger.info("Countertrade result message", response.retMsg);
        logger.info("Counter order placed:", response.result);
        await sendTelegramMessage(
          `Order placed: ${counterOrder.symbol} ${counterOrder.side}`,
        );
      }
    }
  } catch (error) {
    logger.error("Error placing counter order:", error);
    await sendTelegramMessage(
      `Error placing order: ${counterOrder.symbol} ${counterOrder.side}`,
    );
  }
}

async function sendTelegramMessage(message: string) {
  if (TELEGRAM_ENABLED && bot) {
    try {
      await bot.api.sendMessage(process.env.TELEGRAM_CHANNEL_ID || "", message);
    } catch (error) {
      logger.error("Error sending Telegram message:", error);
    }
  }
}

async function getBalanceOfCoin(
  client: RestClientV5,
  coin: string,
  account: string,
) {
  try {
    const response = await client.getWalletBalance({
      accountType: "CONTRACT",
      coin: coin,
    });

    if (response.retCode === 0) {
      // Successful response
      const balance = response.result.list[0];

      const foundCoin = balance.coin.find(
        (balanceCoin) => balanceCoin.coin === coin,
      );
      if (foundCoin) {
        return {
          walletBalance: +foundCoin.walletBalance,
          availableToWithdraw: +foundCoin.availableToWithdraw,
          equity: +foundCoin.equity,
        };
      }

      logger.error(`Could not find ${coin} in ${account} account balance`);
    } else {
      logger.error(
        `Response code ${response.retCode} when fetching ${account} account balance`,
      );
    }
  } catch (error) {
    logger.error(`Exception when fetching ${account} account balance:`, error);
  }

  return null;
}

async function getSymbolInfo(symbol: string) {
  try {
    const response = await counterRestClient.getInstrumentsInfo({
      category: "linear",
      symbol: symbol,
    });
    if (response.retCode === 0 && response.result.list.length > 0) {
      return response.result.list[0];
    }

    throw new Error(`Failed to get symbol info for ${symbol}`);
  } catch (error) {
    logger.error(`Error fetching symbol info for ${symbol}:`, error);
    throw error;
  }
}

function getDecimalPlaces(step: number): number {
  return -Math.floor(Math.log10(step));
}
