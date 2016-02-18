var bcoin = require('../lib/bcoin');
var net = require('net-browserify');
var Dexie = require('dexie');

 // ( function() {
 //        var cons = console;
 //        var EventEmitter = require('events').EventEmitter;
 //        var inspect = require('util').inspect;
 //        var emit_ = EventEmitter.prototype.emit;
 //        EventEmitter.prototype.emit = function(name) {
 //            var args = Array.prototype.slice.call(arguments);
 //            if (!(this === process.stderr && name === 'drain')) {
 //                cons.log("Event '%s', arguments: %s", name, inspect(args.slice(1), false, 1));
 //            }
 //            return emit_.apply(this, args);
 //        };
 //    } )();

function addTimestamp(o) {
    if (o.__ts__) {
        return;
    }
    var slice = Array.prototype.slice;
    ['log', 'debug', 'info', 'warn', 'error'].forEach(function(f) {
        var _ = o[f];
        o[f] = function() {
            var args = slice.call(arguments);
            args[0] = new Date().toISOString() + ' ' + args[0];
            return _.apply(o, args);
        };
    });
    o.__ts__ = true;
}

addTimestamp(console);

var crypto = require('crypto');
var sourceCreateHash = crypto.createHash;
crypto.createHash = function createHash(alg) {
if (alg === 'ripemd160') {
    return sourceCreateHash('rmd160');
}

return sourceCreateHash(alg);
};

net.setProxy({
    // hostname: 'bcoin.herokuapp.com',
    hostname: 'localhost',
    port: 3000
});

var storage = new Dexie('chain-db');

storage.version(1).stores({
    chain: 'paddedHeight, &hash'
});

storage.open();

var pool = bcoin.pool({
    debug: true,
    size: 64,
    createSocket: function(port, host) {
        return net.connect(port, host);
    },
    storage: storage,
    db: bcoin.TestChainDB
});


pool.on('block', function(block) {
    var hash = bcoin.utils.revHex(block.hash('hex'));
    console.debug('Got: %s from %s chain len %d orp %d act %d queue %d',
        hash,
        new Date(block.ts * 1000).toString(),
        pool.chain.index.hashes.length,
        pool.chain.orphan.count,
        pool.request.active,
        pool.request.queue.length);
});

pool.on('peer', function(peer) {
    var ips = pool.peers.all.map(function(peer) {
        if (!peer.socket || !peer.socket.remoteAddress)
            return;
        return peer.socket.remoteAddress;
    }).filter(Boolean);
    console.debug('Peer IPs: ', ips);
})

pool.on('error', function(err) {
    console.error('Error: %s', err.message);
});

pool.on('debug', function(co) {
    console.log.apply(console, arguments);
});

pool.on('chain-progress', function(pr) {
    console.info('Progress: ' + pr);
    progress.html(pr);
});

pool.on('tx', function(tx) {
    console.debug('Transaction: %s, block: %s', tx.hash('hex'), tx.block);
    console.debug('Transaction: %j', tx);
});

pool.on('watched', function(tx) {
    console.info('Watched transaction: %s, block: %s', tx.hash('hex'), tx.block);
    console.info('Watched transaction: %j', tx);
    wallet.addTX(tx);
    container.append('<div>Transaction: ' + tx.hash('hex') + ' block: ' + tx.block + '</div>');
})

pool.on('pool block', function(block) {
    console.debug('Pool block: %s, tx: %j', block.rhash, block.tx);
})

pool.on('headers', function(headers, peer) {
    for (var i = 0; i < headers.length; i++) {
        console.debug('Received header hash: %s from %s', bcoin.utils.revHex(headers[i].hash), peer.socket.remoteAddress);
    }
});

var privkey = PRIV_KEY;

var wallet = new bcoin.wallet({
    priv: privkey
});

pool.once('full', finish);

var once = false;
function finish() {
    if (once)
        return;
    once = true;
    console.info('Balance: %s', wallet.balance());
    console.info('Finished syncing');
}

pool.addWallet(wallet)

pool.watch(wallet.getPublicKey());
pool.watch(wallet.getHash());

wallet.on('balance', function(balance) {
    // Convert satoshis to BTC.
    console.log('Balance: ' + balance);
    var btc = bcoin.utils.toBTC(balance);
    console.log('Your wallet balance has been updated: %s', btc);
});

console.info('Wallet address: %s', wallet.getAddress());
pool.startSync();

var container = null;
var progress = null;

window.wat = function() {
console.info('WAT')
};
window.go = function(el, prog) {
container = el;
progress = prog;
}
window.balance = function() {
container.append('Balance: ' + wallet.balance());
}
window.db = storage.chain;
