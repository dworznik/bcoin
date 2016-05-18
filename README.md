# BCoin

**BCoin** is a bitcoin node which can act as an SPV node or a fully validating
fullnode. Bcoin runs in node.js, but it can also be browserified.

## Features

- SPV mode
- HD Wallets (using BIP44 (or optionally BIP45) derivation)
- Fully browserifiable
- Full block validation
- Full block database
- Fully validating mempool (stored in-memory or on-disk)
- Wallet database
- HTTP server which acts as a wallet server and can also serve:
  blocks, txs (by hash/address), and utxos (by id/address).
  - Fast UTXO retrieval by address for wallets (10000 utxos from 10000 different
    addresses in ~700ms, 50000+ utxos from 10-100 addresses in ~400ms)
- Segregated witness support for block/tx validation and wallets.
- Versionbits suport.

## Install

```
$ npm install bcoin
```

## Documentation

Read the docs here: http://bcoin.io/docs/

## Example Usage

### High-level usage for Node object

``` js
var bcoin = require('bcoin').set('main');

var node = bcoin.fullnode({
  prune: false,
  useCheckpoints: true,
  debug: true,
  // Primary wallet passphrase
  passsphrase: 'node'
});

// Start the node
node.open(function(err) {
  if (err)
    throw err;

  // Create a new wallet (or get an existing one with the same ID)
  var options = {
    id: 'mywallet',
    witness: false,
    type: 'pubkeyhash',
    derivation: 'bip44',
    passphrase: 'foo'
  };

  node.createWallet(options, function(err, wallet) {
    if (err)
      throw err;

    console.log('Created wallet with address: %s', wallet.getAddress());

    // Start syncing the blockchain
    // (this will take a while since we're a fullnode)
    node.startSync();

    // Wait for balance and send it to a new address.
    wallet.once('balance', function(balance) {
      var newReceiving = wallet.createAddress();
      console.log('Created new receiving address: %s', newReceiving);
      // Create a transaction, fill
      // it with coins, and sign it.
      wallet.createTX({
        address: newReceiving,
        value: balance.confirmed
      }, function(err, tx) {
        if (err)
          throw err;

        console.log('sending tx:');
        console.log(tx);

        // Destroy wallet to clean up the listeners.
        wallet.destroy();

        // Broadcast the transaction (alternatively,
        // we could just add it to our own mempool
        // and have the mempool object relay it).
        node.broadcast(tx, function(err) {
          if (err) {
            // Could be a reject
            // packet or a timeout.
            return console.log(err);
          }
          console.log('tx sent!');
        });
      });
    });
  });
});

node.chain.on('block', function(block) {
  console.log(block);
});

node.mempool.on('tx', function(tx) {
  console.log(block);
});

node.chain.on('full', function() {
  node.mempool.getAll(function(err, txs) {
    if (err)
      throw err;

    console.log(txs);
  });
});
```

### CLI Usage

``` bash
$ BCOIN_NETWORK=segnet4 node bin/node
# View the genesis block
$ node bin/bcoin-cli block 0
# View primary wallet
$ node bin/bcoin-cli wallet primary --passphrase=node
# View the mempool
$ node bin/bcoin-cli mempool
```

### Creating a blockchain and mempool

``` js
var bcoin = require('bcoin').set('regtest');
var chain = new bcoin.chain({ db: 'memory' });
var mempool = new bcoin.mempool({ chain: chain, db: 'memory' });
var miner = new bcoin.miner({ chain: chain, mempool: mempool });

// Create a block "attempt"
miner.createBlock(function(err, attempt) {
  if (err)
    throw err;

  // Mine the block on the worker pool (use mine() for the master process)
  attempt.mineAsync(function(err, block) {
    if (err)
      throw err;

    // Add the block to the chain
    chain.add(block, function(err) {
      if (err)
        throw err;

      console.log('Added %s to the blockchain.', block.rhash);
      console.log(block);
    });
  });
});
```

### Connecting to the P2P network

``` js
var bcoin = require('bcoin').set('testnet');

var chain = new bcoin.chain({ db: 'leveldb' });
var mempool = new bcoin.mempool({ chain: chain, db: 'memory' });
var pool = new bcoin.pool({ chain: chain, mempool: mempool, size: 8 });

// Connect, start retrieving and relaying txs
pool.connect();

// Start the blockchain sync.
pool.startSync();

chain.on('block', function(block) {
  console.log('Added block:');
  console.log(block);
});

mempool.on('tx', function(tx) {
  console.log('Added tx to mempool:');
  console.log(tx);
});

pool.on('tx', function(tx) {
  console.log('Saw transaction:');
  console.log(tx);
});
```

### Doing an SPV sync

``` js
var bcoin = require('bcoin').set('testnet');

var chain = new bcoin.chain({
  db: 'leveldb',
  location: process.env.HOME + '/chain.db',
  spv: true
});

var pool = new bcoin.pool({
  chain: chain,
  spv: true,
  size: 8
});

var walletdb = new bcoin.walletdb({ db: 'memory' });

var wallet = new bcoin.wallet({
  provider: walletdb.provider(),
  derivation: 'bip44',
  type: 'pubkeyhash'
});

walletdb.save(wallet);
pool.watchWallet(wallet);

console.log('Created wallet with address %s', wallet.getAddress());

// Connect, start retrieving and relaying txs
pool.connect();

// Start the blockchain sync.
pool.startSync();

pool.on('tx', function(tx) {
  wallet.addTX(tx);
});

wallet.on('balance', function(balance) {
  console.log('Balance updated.');
  console.log(bcoin.utils.btc(balance.unconfirmed));
});
```



### TX creation

TODO

### Scripting

TODO

### Wallet usage

TODO

### Accessing the mempool

TODO

### HTTP server/client

TODO

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2014-2016.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

[bip37]: https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki
[escrow]: https://en.bitcoin.it/wiki/Contract#Example_2:_Escrow_and_dispute_mediation
