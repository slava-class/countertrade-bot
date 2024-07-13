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
import { version } from "./package.json";

console.log(`Running countertrade-bot version ${version}`);

const LOGGING_ENABLED = false;
const USE_TESTNET = true;
const COUNTER_MULTIPLIER = 10;

const TRADING_SUBACCOUNT_API_KEY = process.env.TRADING_SUBACCOUNT_API_KEY;
const TRADING_SUBACCOUNT_API_SECRET = process.env.TRADING_SUBACCOUNT_API_SECRET;

const COUNTERTRADING_SUBACCOUNT_API_KEY =
  process.env.COUNTERTRADING_SUBACCOUNT_API_KEY;
const COUNTERTRADING_SUBACCOUNT_API_SECRET =
  process.env.COUNTERTRADING_SUBACCOUNT_API_SECRET;

if (!TRADING_SUBACCOUNT_API_KEY) {
  console.error("TRADING_SUBACCOUNT_API_KEY is not set");
  process.exit(1);
}

if (!TRADING_SUBACCOUNT_API_SECRET) {
  console.error("TRADING_SUBACCOUNT_API_SECRET is not set");
  process.exit(1);
}

if (!COUNTERTRADING_SUBACCOUNT_API_KEY) {
  console.error("COUNTERTRADING_SUBACCOUNT_API_KEY is not set");
  process.exit(1);
}

if (!COUNTERTRADING_SUBACCOUNT_API_SECRET) {
  console.error("COUNTERTRADING_SUBACCOUNT_API_SECRET is not set");
  process.exit(1);
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

const restClient = new RestClientV5({
  key: COUNTERTRADING_SUBACCOUNT_API_KEY,
  secret: COUNTERTRADING_SUBACCOUNT_API_SECRET,
  testnet: USE_TESTNET,
});

const wsClient = new WebsocketClient(
  {
    key: TRADING_SUBACCOUNT_API_KEY,
    secret: TRADING_SUBACCOUNT_API_SECRET,
    testnet: USE_TESTNET,
    market: "v5",
    reconnectTimeout: RECONNECT_TIMEOUT,
  },
  customLogger,
);

// Subscribe to the private linear perps order channel
wsClient.subscribeV5(["order"], "linear", true);

wsClient.on("update", async (data: WSAccountOrderEventV5) => {
  for (const orderData of data.data) {
    if (respondToOrder(orderData)) {
      console.log("New original order detected:", orderData);
      await placeCounterOrder(orderData);
    }
  }
});

wsClient.on("error", (err) => {
  console.error("WebSocket error:", err);
});

wsClient.on("open", () => {
  console.log("WebSocket connection opened");
});

wsClient.on("close", () => {
  console.log("WebSocket connection closed");
});

wsClient.on("reconnected", () => {
  console.log("WebSocket reconnected");
});

wsClient.connectAll();
console.log("Counter trading bot is running. Waiting for new orders...");

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  wsClient.closeAll();
  process.exit(0);
});

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
  const counterQty = (
    Number.parseFloat(orderData.qty) * COUNTER_MULTIPLIER
  ).toString();

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
    qty: counterQty,
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

  console.log("Placing counter order:", counterOrder);

  try {
    const response = await restClient.submitOrder(counterOrder);
    switch (response.retCode) {
      case 110007: {
        console.log("Insufficent balance in countertrade account for order");
        break;
      }
      default: {
        console.log("Countertrade result code", response.retCode);
        console.log("Countertrade result message", response.retMsg);
        console.log("Counter order placed:", response.result);
      }
    }
  } catch (error) {
    console.error("Error placing counter order:", error);
  }
}
