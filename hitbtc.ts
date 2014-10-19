/// <reference path="typings/tsd.d.ts" />
/// <reference path="utils.ts" />
/// <reference path="models.ts" />

module HitBtc {

    var crypto = require('crypto');
    var ws = require('ws');
    var request = require('request');

    var apikey = '004ee1065d6c7a6ac556bea221cd6338';
    var secretkey = "aa14d615df5d47cb19a13ffe4ea638eb";

    var _lotMultiplier = 100.0;

    interface NoncePayload<T> {
        nonce: number;
        payload: T;
    }

    interface AuthorizedHitBtcMessage<T> {
        apikey : string;
        signature : string;
        message : NoncePayload<T>;
    }

    interface HitBtcPayload {
    }

    interface Login extends HitBtcPayload {
    }

    interface NewOrder extends HitBtcPayload {
        clientOrderId : string;
        symbol : string;
        side : string;
        quantity : number;
        type : string;
        price : number;
        timeInForce : string;
    }

    interface OrderCancel extends HitBtcPayload {
        clientOrderId : string;
        cancelRequestClientOrderId : string;
        symbol : string;
        side : string;
    }

    interface HitBtcOrderBook {
        asks : Array<Array<string>>;
        bids : Array<Array<string>>;
    }

    interface Update {
        price : number;
        size : number;
        timestamp : number;
    }

    class SideUpdate {
        constructor(public price: number, public size: number) {}
    }

    interface MarketDataSnapshotFullRefresh {
        snapshotSeqNo : number;
        symbol : string;
        exchangeStatus : string;
        ask : Array<Update>;
        bid : Array<Update>
    }

    interface MarketDataIncrementalRefresh {
        seqNo : number;
        timestamp : number;
        symbol : string;
        exchangeStatus : string;
        ask : Array<Update>;
        bid : Array<Update>
        trade : Array<Update>
    }

    interface ExecutionReport {
        orderId : string;
        clientOrderId : string;
        execReportType : string;
        orderStatus : string;
        orderRejectReason? : string;
        symbol : string;
        side : string;
        timestamp : number;
        price : number;
        quantity : number;
        type : string;
        timeInForce : string;
        tradeId? : string;
        lastQuantity? : number;
        lastPrice? : number;
        leavesQuantity? : number;
        cumQuantity? : number;
        averagePrice? : number;
    }

    interface CancelReject {
        clientOrderId : string;
        cancelRequestClientOrderId : string;
        rejectReasonCode : string;
        rejectReasonText : string;
        timestamp : number;
    }

    class HitBtcMarketDataGateway implements IMarketDataGateway {
        MarketData : Evt<MarketBook> = new Evt<MarketBook>();
        _marketDataWs : any;

        _lastBook : { [side: string] : { [px: number]: number}} = null;
        private onMarketDataIncrementalRefresh = (msg : MarketDataIncrementalRefresh) => {
            if (msg.symbol != "BTCUSD" || this._lastBook == null) return;

            // todo: they say they send it?...
            var t : Date = msg.timestamp == undefined ? new Date() : new Date(msg.timestamp/1000.0);

            var ordBids = HitBtcMarketDataGateway._applyIncrementals(msg.bid, this._lastBook["bid"], (a, b) => a.price > b.price ? -1 : 1);
            var ordAsks = HitBtcMarketDataGateway._applyIncrementals(msg.ask, this._lastBook["ask"], (a, b) => a.price > b.price ? 1 : -1);

            var getLevel = (n : number) => {
                var bid = new MarketSide(ordBids[n].price, ordBids[n].size);
                var ask = new MarketSide(ordAsks[n].price, ordAsks[n].size);
                return new MarketUpdate(bid, ask, t);
            };

            this.MarketData.trigger(new MarketBook(getLevel(0), getLevel(1), Exchange.HitBtc));
        };

        private static _applyIncrementals(incomingUpdates : Update[],
                                   side : { [px: number]: number},
                                   cmp : (p1 : SideUpdate, p2 : SideUpdate) => number) {
            for (var i = 0; i < incomingUpdates.length; i++) {
                var u : Update = incomingUpdates[i];
                if (u.size == 0) {
                    delete side[u.price];
                }
                else {
                    side[u.price] = u.size;
                }
            }

            var kvps : SideUpdate[] = [];
            for (var px in side) {
                kvps.push(new SideUpdate(parseFloat(px), side[px] / _lotMultiplier));
            }
            return kvps.sort(cmp);
        }

        private static getLevel(msg : MarketDataSnapshotFullRefresh, n : number) : MarketUpdate {
            var bid = new MarketSide(msg.bid[n].price, msg.bid[n].size / _lotMultiplier);
            var ask = new MarketSide(msg.ask[n].price, msg.ask[n].size / _lotMultiplier);
            return new MarketUpdate(bid, ask, new Date());
        }

        private onMarketDataSnapshotFullRefresh = (msg : MarketDataSnapshotFullRefresh) => {
            if (msg.symbol != "BTCUSD") return;

            this._lastBook = {bid: {}, ask: {}};

            for (var i = 0; i < msg.ask.length; i++) {
                this._lastBook["ask"][msg.ask[i].price] = msg.ask[i].size;
            }

            for (var i = 0; i < msg.bid.length; i++) {
                this._lastBook["bid"][msg.bid[i].price] = msg.bid[i].size;
            }

            var b = new MarketBook(HitBtcMarketDataGateway.getLevel(msg, 0), HitBtcMarketDataGateway.getLevel(msg, 1), Exchange.HitBtc);
            this.MarketData.trigger(b);
        };

        private onMessage = (raw : string) => {
            var msg = JSON.parse(raw);
            if (msg.hasOwnProperty("MarketDataIncrementalRefresh")) {
                this.onMarketDataIncrementalRefresh(msg.MarketDataIncrementalRefresh);
            }
            else if (msg.hasOwnProperty("MarketDataSnapshotFullRefresh")) {
                this.onMarketDataSnapshotFullRefresh(msg.MarketDataSnapshotFullRefresh);
            }
            else {
                this._log("unhandled message", msg);
            }
        };

        ConnectChanged : Evt<ConnectivityStatus> = new Evt<ConnectivityStatus>();
        private onOpen = () => {
            this.ConnectChanged.trigger(ConnectivityStatus.Connected);
        };

         _log : Logger = log("Hudson:Gateway:HitBtcMD");
        constructor() {
            this._marketDataWs = new ws('ws://demo-api.hitbtc.com:80');
            this._marketDataWs.on('open', this.onOpen);
            this._marketDataWs.on('message', this.onMessage);
            this._marketDataWs.on("error", this.onMessage);

            request.get(
                {url: "https://api.hitbtc.com/api/1/public/BTCUSD/orderbook"},
                (err, body, resp) => {
                    this.onMarketDataSnapshotFullRefresh(resp);
                });
        }
    }

    class HitBtcOrderEntryGateway implements IOrderEntryGateway {
        OrderUpdate : Evt<GatewayOrderStatusReport> = new Evt<GatewayOrderStatusReport>();
        _orderEntryWs : any;

        _nonce = 1;

        cancelOrder = (cancel : BrokeredCancel) => {
            this.sendAuth("OrderCancel", {clientOrderId: cancel.clientOrderId,
                cancelRequestClientOrderId: cancel.requestId,
                symbol: "BTCUSD",
                side: HitBtcOrderEntryGateway.getSide(cancel.side)});

            var status : GatewayOrderStatusReport = {
                orderId: cancel.clientOrderId,
                orderStatus: OrderStatus.PendingCancel,
                time: new Date()
            };
            this.OrderUpdate.trigger(status);
        };

        replaceOrder = (replace : BrokeredReplace) => {
            this.cancelOrder(new BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
            this.sendOrder(replace);
        };

        sendOrder = (order : BrokeredOrder) => {
            var hitBtcOrder : NewOrder = {
                clientOrderId: order.orderId,
                symbol: "BTCUSD",
                side: HitBtcOrderEntryGateway.getSide(order.side),
                quantity: order.quantity * _lotMultiplier,
                type: HitBtcOrderEntryGateway.getType(order.type),
                price: order.price,
                timeInForce: HitBtcOrderEntryGateway.getTif(order.timeInForce)
            };

            this.sendAuth("NewOrder", hitBtcOrder);

            var rpt : GatewayOrderStatusReport = {
                orderId: order.orderId,
                orderStatus: OrderStatus.New,
                time: new Date()
            };
            this.OrderUpdate.trigger(rpt);
        };

        private static getStatus(m : ExecutionReport) : OrderStatus {
            if (m.execReportType == "new") return OrderStatus.Working;
            if (m.execReportType == "canceled") return OrderStatus.Cancelled;
            if (m.execReportType == "rejected") return OrderStatus.Rejected;
            if (m.execReportType == "expired") return OrderStatus.Cancelled;
            if (m.orderStatus == "partiallyFilled") return OrderStatus.PartialFill;
            if (m.orderStatus == "filled") return OrderStatus.Filled;
            return OrderStatus.Other;
        }

        private static getTif(tif : TimeInForce) {
            switch (tif) {
                case TimeInForce.FOK:
                    return "FOK";
                case TimeInForce.GTC:
                    return "GTC";
                case TimeInForce.IOC:
                    return "IOC";
                default:
                    throw new Error("TIF " + TimeInForce[tif] + " not supported in HitBtc");
            }
        }

        private static getSide(side : Side) {
            switch (side) {
                case Side.Bid:
                    return "buy";
                case Side.Ask:
                    return "sell";
                default:
                    throw new Error("Side " + Side[side] + " not supported in HitBtc");
            }
        }

        private static getType(t : OrderType) {
            switch (t) {
                case OrderType.Limit:
                    return "limit";
                case OrderType.Market:
                    return "market";
                default:
                    throw new Error("OrderType " + OrderType[t] + " not supported in HitBtc");
            }
        }

        private onExecutionReport = (msg : ExecutionReport) => {
            var status : GatewayOrderStatusReport = {
                exchangeId: msg.orderId,
                orderId: msg.clientOrderId,
                orderStatus: HitBtcOrderEntryGateway.getStatus(msg),
                time: new Date(msg.timestamp) || new Date(),
                rejectMessage: msg.orderRejectReason,
                lastQuantity: msg.lastQuantity / _lotMultiplier,
                lastPrice: msg.lastPrice,
                leavesQuantity: msg.leavesQuantity / _lotMultiplier,
                cumQuantity: msg.cumQuantity / _lotMultiplier,
                averagePrice: msg.averagePrice
            };

            this.OrderUpdate.trigger(status);
        };

        private onCancelReject = (msg : CancelReject) => {
            var status : GatewayOrderStatusReport = {
                orderId: msg.clientOrderId,
                rejectMessage: msg.rejectReasonText,
                orderStatus: OrderStatus.CancelRejected,
                time: new Date()
            };
            this.OrderUpdate.trigger(status);
        };

        private authMsg = <T>(payload : T) : AuthorizedHitBtcMessage<T> => {
            var msg = {nonce: this._nonce, payload: payload};
            this._nonce += 1;

            var signMsg = function (m) : string {
                return crypto.createHmac('sha512', secretkey)
                    .update(JSON.stringify(m))
                    .digest('base64');
            };

            return {apikey: apikey, signature: signMsg(msg), message: msg};
        };

        private sendAuth = <T extends HitBtcPayload>(msgType : string, msg : T) => {
            var v = {};
            v[msgType] = msg;
            var readyMsg = this.authMsg(v);
            this._orderEntryWs.send(JSON.stringify(readyMsg));
        };

        ConnectChanged : Evt<ConnectivityStatus> = new Evt<ConnectivityStatus>();
        private onOpen = () => {
            this.sendAuth("Login", {});
            this.ConnectChanged.trigger(ConnectivityStatus.Connected);
        };

        private onMessage = (raw : string) => {
            var msg = JSON.parse(raw);
            if (msg.hasOwnProperty("ExecutionReport")) {
                this.onExecutionReport(msg.ExecutionReport);
            }
            else if (msg.hasOwnProperty("CancelReject")) {
                this.onCancelReject(msg.CancelReject);
            }
            else {
                this._log("unhandled message", msg);
            }
        };

         _log : Logger = log("Hudson:Gateway:HitBtcOE");
        constructor() {
            this._orderEntryWs = new ws("ws://demo-api.hitbtc.com:8080");
            this._orderEntryWs.on('open', this.onOpen);
            this._orderEntryWs.on('message', this.onMessage);
            this._orderEntryWs.on("error", this.onMessage);
        }
    }

    class HitBtcBaseGateway implements IGateway {
        exchange() : Exchange {
            return Exchange.HitBtc;
        }

        makeFee() : number {
            return -0.0001;
        }

        takeFee() : number {
            return 0.001;
        }

        name() : string {
            return "HitBtc";
        }

        ConnectChanged : Evt<ConnectivityStatus> = new Evt<ConnectivityStatus>();
    }

    export class HitBtc extends CombinedGateway {
        constructor() {
            var baseGw = new HitBtcBaseGateway();
            var mdGw = new HitBtcMarketDataGateway();
            var oeGw = new HitBtcOrderEntryGateway();
            super(mdGw, oeGw, baseGw);
        }
    }
}