'use strict';

// ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError, InvalidAddress, OrderNotFound, NotSupported, DDoSProtection, InsufficientFunds } = require ('./base/errors');

// ---------------------------------------------------------------------------

module.exports = class gateio extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'gateio',
            'name': 'Gate.io',
            'countries': 'CN',
            'version': '2',
            'rateLimit': 1000,
            'has': {
                'CORS': false,
                'createMarketOrder': false,
                'fetchTickers': true,
                'withdraw': true,
                'createDepositAddress': true,
                'fetchDepositAddress': true,
                'fetchClosedOrders': true,
                'fetchOpenOrders': true,
                'fetchOrders': true,
                'fetchOrder': true,
                'fetchMyTrades': true,
            },
            'urls': {
                'logo': 'https://user-images.githubusercontent.com/1294454/31784029-0313c702-b509-11e7-9ccc-bc0da6a0e435.jpg',
                'api': {
                    'public': 'https://data.gate.io/api',
                    'private': 'https://data.gate.io/api',
                },
                'www': 'https://gate.io/',
                'doc': 'https://gate.io/api2',
                'fees': [
                    'https://gate.io/fee',
                    'https://support.gate.io/hc/en-us/articles/115003577673',
                ],
            },
            'api': {
                'public': {
                    'get': [
                        'pairs',
                        'marketinfo',
                        'marketlist',
                        'tickers',
                        'ticker/{id}',
                        'orderBook/{id}',
                        'trade/{id}',
                        'tradeHistory/{id}',
                        'tradeHistory/{id}/{tid}',
                    ],
                },
                'private': {
                    'post': [
                        'balances',
                        'depositAddress',
                        'newAddress',
                        'depositsWithdrawals',
                        'buy',
                        'sell',
                        'cancelOrder',
                        'cancelAllOrders',
                        'getOrder',
                        'openOrders',
                        'tradeHistory',
                        'withdraw',
                    ],
                },
            },
            'fees': {
                'trading': {
                    'tierBased': true,
                    'percentage': true,
                    'maker': 0.002,
                    'taker': 0.002,
                },
            },
            'exceptions': {
                '4': DDoSProtection,
                '7': NotSupported,
                '8': NotSupported,
                '9': NotSupported,
                '15': DDoSProtection,
                '16': OrderNotFound,
                '17': OrderNotFound,
                '21': InsufficientFunds,
            },
            // https://gate.io/api2#errCode
            'errorCodeNames': {
                '1': 'Invalid request',
                '2': 'Invalid version',
                '3': 'Invalid request',
                '4': 'Too many attempts',
                '5': 'Invalid sign',
                '6': 'Invalid sign',
                '7': 'Currency is not supported',
                '8': 'Currency is not supported',
                '9': 'Currency is not supported',
                '10': 'Verified failed',
                '11': 'Obtaining address failed',
                '12': 'Empty params',
                '13': 'Internal error, please report to administrator',
                '14': 'Invalid user',
                '15': 'Cancel order too fast, please wait 1 min and try again',
                '16': 'Invalid order id or order is already closed',
                '17': 'Invalid orderid',
                '18': 'Invalid amount',
                '19': 'Not permitted or trade is disabled',
                '20': 'Your order size is too small',
                '21': 'You don\'t have enough fund',
            },
            'options': {
                'limits': {
                    'cost': {
                        'min': {
                            'BTC': 0.0001,
                            'ETH': 0.001,
                            'USDT': 1,
                        },
                    },
                },
            },
        });
    }

    async fetchMarkets () {
        let response = await this.publicGetMarketinfo ();
        let markets = this.safeValue (response, 'pairs');
        if (!markets)
            throw new ExchangeError (this.id + ' fetchMarkets got an unrecognized response');
        let result = [];
        for (let i = 0; i < markets.length; i++) {
            let market = markets[i];
            let keys = Object.keys (market);
            let id = keys[0];
            let details = market[id];
            let [ base, quote ] = id.split ('_');
            base = base.toUpperCase ();
            quote = quote.toUpperCase ();
            base = this.commonCurrencyCode (base);
            quote = this.commonCurrencyCode (quote);
            let symbol = base + '/' + quote;
            let precision = {
                'amount': 8,
                'price': details['decimal_places'],
            };
            let amountLimits = {
                'min': details['min_amount'],
                'max': undefined,
            };
            let priceLimits = {
                'min': Math.pow (10, -details['decimal_places']),
                'max': undefined,
            };
            let defaultCost = amountLimits['min'] * priceLimits['min'];
            let minCost = this.safeFloat (this.options['limits']['cost']['min'], quote, defaultCost);
            let costLimits = {
                'min': minCost,
                'max': undefined,
            };
            let limits = {
                'amount': amountLimits,
                'price': priceLimits,
                'cost': costLimits,
            };
            result.push ({
                'id': id,
                'symbol': symbol,
                'base': base,
                'quote': quote,
                'info': market,
                'maker': details['fee'] / 100,
                'taker': details['fee'] / 100,
                'precision': precision,
                'limits': limits,
            });
        }
        return result;
    }

    async fetchBalance (params = {}) {
        await this.loadMarkets ();
        let balance = await this.privatePostBalances ();
        let result = { 'info': balance };
        let currencies = Object.keys (this.currencies);
        for (let i = 0; i < currencies.length; i++) {
            let currency = currencies[i];
            let code = this.commonCurrencyCode (currency);
            let account = this.account ();
            if ('available' in balance) {
                if (currency in balance['available']) {
                    account['free'] = parseFloat (balance['available'][currency]);
                }
            }
            if ('locked' in balance) {
                if (currency in balance['locked']) {
                    account['used'] = parseFloat (balance['locked'][currency]);
                }
            }
            account['total'] = this.sum (account['free'], account['used']);
            result[code] = account;
        }
        return this.parseBalance (result);
    }

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let orderbook = await this.publicGetOrderBookId (this.extend ({
            'id': this.marketId (symbol),
        }, params));
        return this.parseOrderBook (orderbook);
    }

    parseTicker (ticker, market = undefined) {
        let timestamp = this.milliseconds ();
        let symbol = undefined;
        if (market)
            symbol = market['symbol'];
        let last = this.safeFloat (ticker, 'last');
        let percentage = this.safeFloat (ticker, 'percentChange');
        let open = undefined;
        let change = undefined;
        let average = undefined;
        if ((typeof last !== 'undefined') && (typeof percentage !== 'undefined')) {
            let relativeChange = percentage / 100;
            open = last / this.sum (1, relativeChange);
            change = last - open;
            average = this.sum (last, open) / 2;
        }
        return {
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'high': this.safeFloat (ticker, 'high24hr'),
            'low': this.safeFloat (ticker, 'low24hr'),
            'bid': this.safeFloat (ticker, 'highestBid'),
            'bidVolume': undefined,
            'ask': this.safeFloat (ticker, 'lowestAsk'),
            'askVolume': undefined,
            'vwap': undefined,
            'open': open,
            'close': last,
            'last': last,
            'previousClose': undefined,
            'change': change,
            'percentage': percentage,
            'average': average,
            'baseVolume': this.safeFloat (ticker, 'quoteVolume'),
            'quoteVolume': this.safeFloat (ticker, 'baseVolume'),
            'info': ticker,
        };
    }

    handleErrors (code, reason, url, method, headers, body) {
        if (body.length <= 0) {
            return;
        }
        if (body[0] !== '{') {
            return;
        }
        let jsonbodyParsed = JSON.parse (body);
        let resultString = this.safeString (jsonbodyParsed, 'result', '');
        if (resultString !== 'false') {
            return;
        }
        let errorCode = this.safeString (jsonbodyParsed, 'code');
        if (typeof errorCode !== 'undefined') {
            const exceptions = this.exceptions;
            const errorCodeNames = this.errorCodeNames;
            if (errorCode in exceptions) {
                let message = '';
                if (errorCode in errorCodeNames) {
                    message = errorCodeNames[errorCode];
                } else {
                    message = this.safeString (jsonbodyParsed, 'message', '(unknown)');
                }
                throw new exceptions[errorCode] (message);
            }
        }
    }

    async fetchTickers (symbols = undefined, params = {}) {
        await this.loadMarkets ();
        let tickers = await this.publicGetTickers (params);
        let result = {};
        let ids = Object.keys (tickers);
        for (let i = 0; i < ids.length; i++) {
            let id = ids[i];
            let [ baseId, quoteId ] = id.split ('_');
            let base = baseId.toUpperCase ();
            let quote = quoteId.toUpperCase ();
            base = this.commonCurrencyCode (base);
            quote = this.commonCurrencyCode (quote);
            let symbol = base + '/' + quote;
            let ticker = tickers[id];
            let market = undefined;
            if (symbol in this.markets)
                market = this.markets[symbol];
            if (id in this.markets_by_id)
                market = this.markets_by_id[id];
            result[symbol] = this.parseTicker (ticker, market);
        }
        return result;
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let ticker = await this.publicGetTickerId (this.extend ({
            'id': market['id'],
        }, params));
        return this.parseTicker (ticker, market);
    }

    parseTrade (trade, market) {
        // exchange reports local time (UTC+8)
        let timestamp = this.parse8601 (trade['date']) - 8 * 60 * 60 * 1000;
        return {
            'id': trade['tradeID'],
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': market['symbol'],
            'type': undefined,
            'side': trade['type'],
            'price': this.safeFloat (trade, 'rate'),
            'amount': this.safeFloat (trade, 'amount'),
        };
    }

    parseMyTrade (trade, market) {
        const ts = +trade['time_unix'] * 1000;
        return {
            'id': trade['tradeID'],
            'order': trade['orderNumber'],
            'info': trade,
            'timestamp': ts,
            'datetime': this.iso8601 (ts),
            'symbol': market['symbol'],
            'type': undefined,
            'side': trade['type'],
            'price': parseFloat (trade['rate']),
            'amount': this.safeFloat (trade, 'amount'),
        };
    }

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let response = await this.publicGetTradeHistoryId (this.extend ({
            'id': market['id'],
        }, params));
        return this.parseTrades (response['data'], market, since, limit);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let request = {};
        let market = undefined;
        if (symbol) {
            market = this.market (symbol);
        }
        let response = await this.privatePostOpenOrders (this.extend (request, params));
        let orders = this.parseOrders (response['orders'], market, since, limit);
        return this.filterBySymbol (orders, symbol);
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = { 'orderNumber': id, 'currencyPair': market['id'] };
        let response = await this.privatePostGetOrder (this.extend (request, params));
        return this.parseOrder (response['order'], market);
    }

    parseOrder (order, market = undefined) {
        let timestamp = this.safeInteger (order, 'timestamp') * 1000;
        let symbol = market['symbol'];
        let amount = this.safeFloat (order, 'initialAmount');
        if (!amount) {
            amount = this.safeFloat (order, 'amount');
        }
        let price = this.safeFloat (order, 'initialRate');
        if (!price) {
            price = this.safeFloat (order, 'rate');
        }
        let filled = this.safeFloat (order, 'filledAmount');
        let feePercentage = this.safeFloat (order, 'feePercentage');
        return {
            'info': order,
            'id': order['orderNumber'],
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'status': order['status'],
            'symbol': symbol,
            'type': 'limit',
            'side': order['type'],
            'price': price,
            'cost': undefined,
            'amount': amount,
            'filled': filled,
            'average': this.safeFloat (order, 'filledRate'),
            'remaining': amount - filled,
            'trades': undefined,
            'fee': feePercentage ? { 'currency': market.base, 'value': amount * feePercentage / 100 } : undefined,
            // gateio states wrong fee currency. this will return wrong value on sell side:
            // 'fee': order.feeValue ?  { currency:order.feeCurrency, value: parseFloat(order.feeValue) * price } : undefined,
        };
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = { 'currencyPair': market['id'] }; // parameter currencyPair is required
        let response = await this.privatePostTradeHistory (this.extend (request, params));
        let result = Object.values (response['trades'] || []).map (trade => this.parseMyTrade (trade, market));
        this.sortBy (result, 'timestamp');
        return this.filterBySinceLimit (result, since, limit);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        if (type === 'market')
            throw new ExchangeError (this.id + ' allows limit orders only');
        await this.loadMarkets ();
        let method = 'privatePost' + this.capitalize (side);
        let market = this.market (symbol);
        let order = {
            'currencyPair': market['id'],
            'rate': price,
            'amount': amount,
        };
        let response = await this[method] (this.extend (order, params));
        return this.parseOrder (this.extend ({
            'status': 'open',
            'type': side,
            'initialAmount': amount,
        }, response), market);
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        return await this.privatePostCancelOrder ({
            'orderNumber': id,
            'currencyPair': this.marketId (symbol),
        });
    }

    async queryDepositAddress (method, code, params = {}) {
        await this.loadMarkets ();
        let currency = this.currency (code);
        method = 'privatePost' + method + 'Address';
        let response = await this[method] (this.extend ({
            'currency': currency['id'],
        }, params));
        let address = this.safeString (response, 'addr');
        let tag = undefined;
        if ((typeof address !== 'undefined') && (address.indexOf ('address') >= 0))
            throw new InvalidAddress (this.id + ' queryDepositAddress ' + address);
        if (code === 'XRP') {
            let parts = address.split ('/', 2);
            address = parts[0];
            tag = parts[1];
        }
        return {
            'currency': currency,
            'address': address,
            'tag': tag,
            'status': (typeof address !== 'undefined') ? 'ok' : 'none',
            'info': response,
        };
    }

    async createDepositAddress (code, params = {}) {
        return await this.queryDepositAddress ('New', code, params);
    }

    async fetchDepositAddress (code, params = {}) {
        return await this.queryDepositAddress ('Deposit', code, params);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = undefined;
        if (typeof symbol !== 'undefined') {
            market = this.market (symbol);
        }
        let response = await this.privatePostOpenOrders ();
        return this.parseOrders (response['orders'], market, since, limit);
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (typeof symbol === 'undefined')
            throw new ExchangeError (this.id + ' fetchMyTrades requires symbol param');
        await this.loadMarkets ();
        let market = this.market (symbol);
        let id = market['id'];
        let response = await this.privatePostTradeHistory (this.extend ({ 'currencyPair': id }, params));
        return this.parseTrades (response['trades'], market, since, limit);
    }

    async withdraw (currency, amount, address, tag = undefined, params = {}) {
        this.checkAddress (address);
        await this.loadMarkets ();
        let response = await this.privatePostWithdraw (this.extend ({
            'currency': currency.toLowerCase (),
            'amount': amount,
            'address': address, // Address must exist in you AddressBook in security settings
        }, params));
        return {
            'info': response,
            'id': undefined,
        };
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let prefix = (api === 'private') ? (api + '/') : '';
        let url = this.urls['api'][api] + this.version + '/1/' + prefix + this.implodeParams (path, params);
        let query = this.omit (params, this.extractParams (path));
        if (api === 'public') {
            if (Object.keys (query).length)
                url += '?' + this.urlencode (query);
        } else {
            this.checkRequiredCredentials ();
            let nonce = this.nonce ();
            let request = { 'nonce': nonce };
            body = this.urlencode (this.extend (request, query));
            let signature = this.hmac (this.encode (body), this.encode (this.secret), 'sha512');
            headers = {
                'Key': this.apiKey,
                'Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded',
            };
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }

    async request (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let response = await this.fetch2 (path, api, method, params, headers, body);
        if ('result' in response) {
            let result = response['result'];
            let message = this.id + ' ' + this.json (response);
            if (typeof result === 'undefined')
                throw new ExchangeError (message);
            if (typeof result === 'string') {
                if (result !== 'true')
                    throw new ExchangeError (message);
            } else if (!result) {
                throw new ExchangeError (message);
            }
        }
        return response;
    }
};
