/*!
 * chaindb.js - blockchain data management for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

/*
 * Database Layout:
 *   R -> tip hash
 *   e/[hash] -> entry
 *   h/[hash] -> height
 *   H/[height] -> hash
 *   n/[hash] -> next hash
 *   b/[hash] -> block
 *   t/[hash] -> extended tx
 *   c/[hash]/[index] -> coin
 *   u/[hash] -> undo coins
 *   T/[address]/[hash] -> dummy (tx by address)
 *   C/[address]/[hash] -> dummy (coin by address)
 */

var bcoin = require('./env');
var EventEmitter = require('events').EventEmitter;
var constants = bcoin.protocol.constants;
var utils = require('./utils');
var assert = utils.assert;
var pad32 = utils.pad32;
var DUMMY = new Buffer([0]);
var BufferWriter = require('./writer');
var BufferReader = require('./reader');
var Framer = bcoin.protocol.framer;
var Parser = bcoin.protocol.parser;

/**
 * The database backend for the {@link Chain} object.
 * @exports ChainDB
 * @constructor
 * @param {Object} options
 * @param {Boolean?} options.prune - Whether to prune the chain.
 * @param {Boolean?} options.spv - SPV-mode, will not save block
 * data, only entries.
 * @param {Number?} [options.keepBlocks=288] - Number of
 * blocks to keep when pruning.
 * @param {Boolean?} options.paranoid - Perform some paranoid checks
 * against hashes. Will throw if corruption is detected.
 * @param {String?} options.name - Database name
 * @param {String?} options.location - Database location
 * @param {String?} options.db - Database backend name
 * @property {Boolean} prune
 * @property {Boolean} loaded
 * @property {Number} keepBlocks
 * @emits ChainDB#open
 * @emits ChainDB#error
 * @emits ChainDB#add block
 * @emits ChainDB#remove block
 * @emits ChainDB#add entry
 * @emits ChainDB#remove entry
 */

function ChainDB(chain, options) {
  if (!(this instanceof ChainDB))
    return new ChainDB(chain, options);

  if (!options)
    options = {};

  EventEmitter.call(this);

  this.options = options;
  this.chain = chain;
  this.network = this.chain.network;

  this.keepBlocks = options.keepBlocks || 288;
  this.prune = !!options.prune;

  this.loaded = false;

  // We want at least 1 retarget interval cached
  // for retargetting, but we need at least two
  // cached for optimal versionbits state checks.
  // We add a padding of 100 for forked chains,
  // reorgs, chain locator creation and the bip34
  // check.
  this.cacheWindow = (this.network.pow.retargetInterval + 1) * 2 + 100;

  this.coinCache = new NullCache(100000);
  this.cacheHash = new bcoin.lru(this.cacheWindow);
  this.cacheHeight = new bcoin.lru(this.cacheWindow);

  this._init();
}

utils.inherits(ChainDB, EventEmitter);

ChainDB.prototype._init = function _init() {
  var self = this;
  var genesis, block;

  if (this.loaded)
    return;

  this.db = bcoin.ldb({
    network: this.network,
    name: this.options.name || (this.options.spv ? 'spvchain' : 'chain'),
    location: this.options.location,
    dbName: this.options.dbName,
    dbVersion: this.options.dbVersion,
    db: this.options.db,
    compression: true,
    cacheSize: 16 << 20,
    writeBufferSize: 8 << 20
  });

  bcoin.debug('Starting chain load.');

  this.db.open(function(err) {
    if (err)
      return self.emit('error', err);

    function finish(err) {
      if (err)
        return self.emit('error', err);

      bcoin.debug('Chain successfully loaded.');

      self.loaded = true;
      self.emit('open');
    }

    self.db.has('h/' + self.network.genesis.hash, function(err, exists) {
      if (err)
        return self.emit('error', err);

      if (exists)
        return finish();

      genesis = new bcoin.chainentry(self.chain, {
        hash: self.network.genesis.hash,
        version: self.network.genesis.version,
        prevBlock: self.network.genesis.prevBlock,
        merkleRoot: self.network.genesis.merkleRoot,
        ts: self.network.genesis.ts,
        bits: self.network.genesis.bits,
        nonce: self.network.genesis.nonce,
        height: 0,
        chainwork: null
      }, null);

      block = bcoin.block.fromRaw(self.network.genesisBlock, 'hex');
      block.setHeight(0);

      self.save(genesis, block, true, finish);
    });
  });
};

/**
 * Open the chain, wait for the database to load.
 * @param {Function} callback
 */

ChainDB.prototype.open = function open(callback) {
  if (this.loaded)
    return utils.nextTick(callback);

  this.once('open', callback);
};

/**
 * Close the chain, wait for the database to close.
 * @method
 * @param {Function} callback
 */

ChainDB.prototype.close =
ChainDB.prototype.destroy = function destroy(callback) {
  callback = utils.ensure(callback);
  this.db.close(callback);
};

/**
 * Dump the database to a map for debugging.
 * @param {Function} callback - Returns [Error, Object].
 */

ChainDB.prototype.dump = function dump(callback) {
  var records = {};

  var iter = this.db.iterator({
    gte: 'c',
    lte: 'c~',
    keys: true,
    values: true,
    fillCache: false,
    keyAsBuffer: false,
    valueAsBuffer: true
  });

  callback = utils.ensure(callback);

  (function next() {
    iter.next(function(err, key, value) {
      if (err) {
        return iter.end(function() {
          callback(err);
        });
      }

      if (key === undefined) {
        return iter.end(function(err) {
          if (err)
            return callback(err);
          return callback(null, records);
        });
      }

      records[key] = value;

      next();
    });
  })();
};

/**
 * Add an entry to the LRU cache.
 * @param {ChainEntry} entry
 */

ChainDB.prototype.addCache = function addCache(entry) {
  this.cacheHash.set(entry.hash, entry);
  this.cacheHeight.set(entry.height, entry);
};

/**
 * Test the cache for a present entry hash or height.
 * @param {Hash|Number} hash - Hash or height.
 */

ChainDB.prototype.hasCache = function hasCache(hash) {
  if (hash == null || hash < 0)
    return false;

  if (typeof hash === 'number')
    return this.cacheHeight.has(hash);

  return this.cacheHash.has(hash);
};

/**
 * Get an entry directly from the LRU cache. This is
 * useful for optimization if we don't want to wait on a
 * nextTick during a `get()` call.
 * @param {Hash|Number} hash - Hash or height.
 */

ChainDB.prototype.getCache = function getCache(hash) {
  if (hash == null || hash < 0)
    return;

  if (typeof hash === 'number')
    return this.cacheHeight.get(hash);

  return this.cacheHash.get(hash);
};

/**
 * Get the height of a block by hash.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Number].
 */

ChainDB.prototype.getHeight = function getHeight(hash, callback) {
  callback = utils.asyncify(callback);

  if (hash == null || hash < 0)
    return callback(null, -1);

  if (typeof hash === 'number')
    return callback(null, hash);

  if (hash === constants.NULL_HASH)
    return callback(null, -1);

  if (this.cacheHash.has(hash))
    return callback(null, this.cacheHash.get(hash).height);

  this.db.fetch('h/' + hash, function(data) {
    assert(data.length === 4, 'Database corruption.');
    return data.readUInt32LE(0, true);
  }, function(err, height) {
    if (err)
      return callback(err);

    if (height == null)
      return callback(null, -1);

    return callback(null, height);
  });
};

/**
 * Get the hash of a block by height. Note that this
 * will only return hashes in the main chain.
 * @param {Number} height
 * @param {Function} callback - Returns [Error, {@link Hash}].
 */

ChainDB.prototype.getHash = function getHash(height, callback) {
  callback = utils.asyncify(callback);

  if (height == null || height < 0)
    return callback(null, null);

  if (typeof height === 'string')
    return callback(null, height);

  if (this.cacheHeight.has(height))
    return callback(null, this.cacheHeight.get(height).hash);

  this.db.fetch('H/' + pad32(height), function(data) {
    assert(data.length === 32, 'Database corruption.');
    return data.toString('hex');
  }, callback);
};

/**
 * Get the current chain height from the tip record.
 * @param {Function} callback - Returns [Error, Number].
 */

ChainDB.prototype.getChainHeight = function getChainHeight(callback) {
  return this.getTip(function(err, entry) {
    if (err)
      return callback(err);

    if (!entry)
      return callback(null, -1);

    return callback(null, entry.height);
  });
};

/**
 * Get both hash and height depending on the value passed in.
 * @param {Hash|Number} block - Can be a has or height.
 * @param {Function} callback - Returns [Error, {@link Hash}, Number].
 */

ChainDB.prototype.getBoth = function getBoth(block, callback) {
  var hash, height;

  if (block == null || block < 0)
    return utils.asyncify(callback)(null, null, -1);

  if (typeof block === 'string')
    hash = block;
  else
    height = block;

  if (!hash) {
    return this.getHash(height, function(err, hash) {
      if (err)
        return callback(err);

      if (hash == null)
        height = -1;

      return callback(null, hash, height);
    });
  }

  return this.getHeight(hash, function(err, height) {
    if (err)
      return callback(err);

    if (height === -1)
      hash = null;

    return callback(null, hash, height);
  });
};

/**
 * Retrieve a chain entry but do _not_ add it to the LRU cache.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link ChainEntry}].
 */

ChainDB.prototype.getEntry = function getEntry(hash, callback) {
  var self = this;

  if (hash == null || hash < 0)
    return utils.nextTick(callback);

  return this.getHash(hash, function(err, hash) {
    if (err && err.type !== 'NotFoundError')
      return callback(err);

    if (!hash)
      return callback();

    if (self.cacheHash.has(hash))
      return callback(null, self.cacheHash.get(hash));

    return self.db.fetch('e/' + hash, function(data) {
      return bcoin.chainentry.fromRaw(self.chain, data);
    }, callback);
  });
};

/**
 * Retrieve a chain entry and add it to the LRU cache.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link ChainEntry}].
 */

ChainDB.prototype.get = function get(hash, callback) {
  var self = this;

  return this.getEntry(hash, function(err, entry) {
    if (err)
      return callback(err);

    if (!entry)
      return callback();

    // There's no efficient way to check whether
    // this is in the main chain or not, so
    // don't add it to the height cache.
    self.cacheHash.set(entry.hash, entry);

    return callback(null, entry);
  });
};

/**
 * Save an entry to the database and optionally
 * connect it as the tip. Note that this method
 * does _not_ perform any verification which is
 * instead performed in {@link Chain#add}.
 * @param {ChainEntry} entry
 * @param {Block} block
 * @param {Boolean} connect - Whether to connect the
 * block's inputs and add it as a tip.
 * @param {Function} callback
 */

ChainDB.prototype.save = function save(entry, block, connect, callback) {
  var batch, hash, height;

  callback = utils.ensure(callback);

  assert(entry.height >= 0);

  batch = this.db.batch();

  hash = new Buffer(entry.hash, 'hex');

  height = new Buffer(4);
  height.writeUInt32LE(height, 0, true);

  batch.put('h/' + entry.hash, height);
  batch.put('e/' + entry.hash, entry.toRaw());

  this.cacheHash.set(entry.hash, entry);

  if (!connect) {
    return this.saveBlock(block, batch, false, function(err) {
      if (err)
        return callback(err);
      return batch.write(callback);
    });
  }

  this.cacheHeight.set(entry.height, entry);

  batch.put('n/' + entry.prevBlock, hash);
  batch.put('H/' + pad32(entry.height), hash);
  batch.put('R', hash);

  this.emit('add entry', entry);

  this.saveBlock(block, batch, true, function(err) {
    if (err)
      return callback(err);
    return batch.write(callback);
  });
};

/**
 * Retrieve the tip entry from the tip record.
 * @param {Function} callback - Returns [Error, {@link ChainEntry}].
 */

ChainDB.prototype.getTip = function getTip(callback) {
  var self = this;
  return this.db.fetch('R', function(data) {
    assert(data.length === 32, 'Database corruption.');
    return data.toString('hex');
  }, function(err, hash) {
    if (err)
      return callback(err);

    if (!hash)
      return callback();

    return self.get(hash, callback);
  });
};

/**
 * Connect the block to the chain.
 * @param {ChainEntry|Hash|Height} block - entry, height, or hash.
 * @param {Function} callback - Returns [Error, {@link ChainEntry}].
 */

ChainDB.prototype.connect = function connect(entry, block, callback) {
  var batch = this.db.batch();
  var hash = new Buffer(entry.hash, 'hex');

  batch.put('n/' + entry.prevBlock, hash);
  batch.put('H/' + pad32(entry.height), hash);
  batch.put('R', hash);

  this.cacheHash.set(entry.hash, entry);
  this.cacheHeight.set(entry.height, entry);

  this.emit('add entry', entry);

  this.connectBlock(block, batch, function(err) {
    if (err)
      return callback(err);

    batch.write(function(err) {
      if (err)
        return callback(err);
      return callback(null, entry);
    });
  });
};

/**
 * Disconnect block from the chain.
 * @param {ChainEntry|Hash|Height} block - Entry, height, or hash.
 * @param {Function} callback - Returns [Error, {@link ChainEntry}].
 */

ChainDB.prototype.disconnect = function disconnect(block, callback) {
  var self = this;
  var batch;

  this._ensureEntry(block, function(err, entry) {
    if (err)
      return callback(err);

    if (!entry)
      return callback(new Error('Entry not found.'));

    batch = self.db.batch();

    batch.del('n/' + entry.prevBlock);
    batch.del('H/' + pad32(entry.height));
    batch.put('R', new Buffer(entry.prevBlock, 'hex'));

    self.cacheHeight.remove(entry.height);

    self.emit('remove entry', entry);

    self.disconnectBlock(entry.hash, batch, function(err) {
      if (err)
        return callback(err);

      batch.write(function(err) {
        if (err)
          return callback(err);
        return callback(null, entry);
      });
    });
  });
};

ChainDB.prototype._ensureEntry = function _ensureEntry(block, callback) {
  if (block instanceof bcoin.chainentry)
    return callback(null, block);
  return this.get(block, callback);
};

/**
 * Get the _next_ block hash (does not work by height).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link Hash}].
 */

ChainDB.prototype.getNextHash = function getNextHash(hash, callback) {
  return this.db.fetch('n/' + hash, function(data) {
    assert(data.length === 32, 'Database corruption.');
    return data.toString('hex');
  }, callback);
};

/**
 * Check to see if a block is on the main chain.
 * @param {ChainEntry|Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

ChainDB.prototype.isMainChain = function isMainChain(hash, callback) {
  var self = this;
  var query;

  if (hash instanceof bcoin.chainentry) {
    query = hash.height;
    hash = hash.hash;
  } else {
    query = hash;
  }

  if (hash === this.chain.tip.hash || hash === this.network.genesis.hash)
    return utils.asyncify(callback)(null, true);

  return this.getHeight(query, function(err, height) {
    if (err)
      return callback(err);

    return self.getHash(height, function(err, existing) {
      if (err)
        return callback(err);

      if (!existing)
        return callback(null, false);

      return callback(null, hash === existing);
    });
  });
};

/**
 * Reset the chain to a height or hash. Useful for replaying
 * the blockchain download for SPV.
 * @param {Hash|Number} block - hash/height
 * @param {Function} callback
 */

ChainDB.prototype.reset = function reset(block, callback) {
  var self = this;
  var batch;

  this.get(block, function(err, entry) {
    if (err)
      return callback(err);

    if (!entry)
      return callback();

    self.getTip(function(err, tip) {
      if (err)
        return callback(err);

      if (!tip)
        return callback();

      (function next(err, tip) {
        if (err)
          return callback(err);

        if (!tip)
          return callback();

        batch = self.db.batch();

        if (tip.hash === entry.hash) {
          batch.put('R', new Buffer(tip.hash, 'hex'));
          return batch.write(callback);
        }

        batch.del('H/' + pad32(tip.height));
        batch.del('h/' + tip.hash);
        batch.del('e/' + tip.hash);
        batch.del('n/' + tip.prevBlock);

        self.emit('remove entry', tip);

        self.removeBlock(tip.hash, batch, function(err) {
          if (err)
            return callback(err);

          batch.write(function(err) {
            if (err)
              return next(err);
            self.get(tip.prevBlock, next);
          });
        });
      })(null, tip);
    });
  });
};

/**
 * Test whether the chain contains a block in the
 * main chain or an alternate chain. Alternate chains will only
 * be tested if the lookup is done by hash.
 * @param {Hash|Number} height - Hash or height.
 * @param {Function} callback - Returns [Error, Boolean].
 */

ChainDB.prototype.has = function has(height, callback) {
  if (height == null || height < 0)
    return utils.asyncify(callback)(null, false);

  return this.getBoth(height, function(err, hash, height) {
    if (err)
      return callback(err);
    return callback(null, hash != null);
  });
};

/**
 * Save a block (not an entry) to the
 * database and potentially connect the inputs.
 * @param {Block} block
 * @param {Batch} batch
 * @param {Boolean} connect - Whether to connect the inputs.
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.saveBlock = function saveBlock(block, batch, connect, callback) {
  if (this.options.spv)
    return utils.nextTick(callback);

  batch.put('b/' + block.hash('hex'), block.render());

  if (!connect)
    return utils.nextTick(callback);

  this.connectBlock(block, batch, callback);
};

/**
 * Remove a block (not an entry) to the database.
 * Disconnect inputs.
 * @param {Block|Hash} block - {@link Block} or hash.
 * @param {Batch} batch
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.removeBlock = function removeBlock(hash, batch, callback) {
  var self = this;

  if (this.options.spv)
    return utils.nextTick(callback);

  this._ensureHistory(hash, function(err, block) {
    if (err)
      return callback(err);

    if (!block)
      return callback();

    batch.del('b/' + block.hash('hex'));

    self.disconnectBlock(block, batch, callback);
  });
};

/**
 * Connect block inputs.
 * @param {Block} block
 * @param {Batch} batch
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.connectBlock = function connectBlock(block, batch, callback) {
  var self = this;
  var undo = new BufferWriter();
  var i, j, tx, input, output, key, addresses, address, hash, coin;

  if (this.options.spv) {
    self.emit('add block', block);
    return utils.nextTick(callback);
  }

  // Genesis block's coinbase is unspendable.
  if (this.chain.isGenesis(block))
    return utils.nextTick(callback);

  this._ensureBlock(block, function(err, block) {
    if (err)
      return callback(err);

    if (!block)
      return callback();

    for (i = 0; i < block.txs.length; i++) {
      tx = block.txs[i];
      hash = tx.hash('hex');

      if (self.options.indexTX) {
        batch.put('t/' + hash, tx.toExtended());
        if (self.options.indexAddress) {
          addresses = tx.getHashes();
          for (j = 0; j < addresses.length; j++) {
            address = addresses[j];
            batch.put('T/' + address + '/' + hash, DUMMY);
          }
        }
      }

      for (j = 0; j < tx.inputs.length; j++) {
        input = tx.inputs[j];
        key = input.prevout.hash + '/' + input.prevout.index;

        if (tx.isCoinbase())
          break;

        assert(input.coin);

        if (self.options.indexAddress) {
          address = input.getHash();
          if (address)
            batch.del('C/' + address + '/' + key);
        }

        batch.del('c/' + key);

        Framer.coin(input.coin, false, undo);

        self.coinCache.remove(key);
      }

      for (j = 0; j < tx.outputs.length; j++) {
        output = tx.outputs[j];
        key = hash + '/' + j;

        if (output.script.isUnspendable())
          continue;

        coin = bcoin.coin.fromTX(tx, j);

        if (self.options.indexAddress) {
          address = output.getHash();
          if (address)
            batch.put('C/' + address + '/' + key, DUMMY);
        }

        batch.put('c/' + key, coin.toRaw());

        self.coinCache.set(key, coin);
      }
    }

    if (undo.written > 0)
      batch.put('u/' + block.hash('hex'), undo.render());

    self.emit('add block', block);

    self._pruneBlock(block, batch, function(err) {
      if (err)
        return callback(err);
      return callback(null, block);
    });
  });
};

/**
 * Disconnect block inputs.
 * @param {Block|Hash} block - {@link Block} or hash.
 * @param {Batch} batch
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.disconnectBlock = function disconnectBlock(block, batch, callback) {
  var self = this;
  var i, j, tx, input, output, key, addresses, address, hash;

  if (this.options.spv)
    return utils.nextTick(callback);

  this._ensureHistory(block, function(err, block) {
    if (err)
      return callback(err);

    if (!block)
      return callback(new Error('Block not found.'));

    for (i = block.txs.length - 1; i >= 0; i--) {
      tx = block.txs[i];
      hash = tx.hash('hex');

      if (self.options.indexTX) {
        batch.del('t/' + hash);
        if (self.options.indexAddress) {
          addresses = tx.getHashes();
          for (j = 0; j < addresses.length; j++) {
            address = addresses[j];
            batch.del('T/' + address + '/' + hash);
          }
        }
      }

      for (j = 0; j < tx.inputs.length; j++) {
        input = tx.inputs[j];
        key = input.prevout.hash + '/' + input.prevout.index;

        if (tx.isCoinbase())
          break;

        assert(input.coin);

        if (self.options.indexAddress) {
          address = input.getHash();
          if (address)
            batch.put('C/' + address + '/' + key, DUMMY);
        }

        batch.put('c/' + key, input.coin.toRaw());

        self.coinCache.set(key, input.coin);
      }

      for (j = 0; j < tx.outputs.length; j++) {
        output = tx.outputs[j];
        key = hash + '/' + j;

        if (output.script.isUnspendable())
          continue;

        if (self.options.indexAddress) {
          address = output.getHash();
          if (address)
            batch.del('C/' + address + '/' + key);
        }

        batch.del('c/' + key);

        self.coinCache.remove(key);
      }
    }

    batch.del('u/' + block.hash('hex'));

    self.emit('remove block', block);

    return callback(null, block);
  });
};

/**
 * Fill a transaction with coins (only unspents).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

ChainDB.prototype.fillCoins = function fillCoins(tx, callback) {
  var self = this;

  if (Array.isArray(tx)) {
    return utils.forEachSerial(tx, function(tx, next) {
      self.fillCoins(tx, next);
    }, function(err) {
      if (err)
        return callback(err);
      return callback(null, tx);
    });
  }

  if (tx.isCoinbase())
    return utils.asyncify(callback)(null, tx);

  utils.forEachSerial(tx.inputs, function(input, next) {
    if (input.coin)
      return next();

    self.getCoin(input.prevout.hash, input.prevout.index, function(err, coin) {
      if (err)
        return callback(err);

      if (coin)
        input.coin = coin;

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, tx);
  });
};

/**
 * Fill a transaction with coins (all historical coins).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

ChainDB.prototype.fillHistory = function fillHistory(tx, callback) {
  var self = this;

  if (Array.isArray(tx)) {
    return utils.forEachSerial(tx, function(tx, next) {
      self.fillHistory(tx, next);
    }, function(err) {
      if (err)
        return callback(err);
      return callback(null, tx);
    });
  }

  if (tx.isCoinbase())
    return utils.asyncify(callback)(null, tx);

  utils.forEachSerial(tx.inputs, function(input, next) {
    if (input.coin)
      return next();

    self.getTX(input.prevout.hash, function(err, tx) {
      if (err)
        return next(err);

      if (tx)
        input.coin = bcoin.coin.fromTX(tx, input.prevout.index);

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, tx);
  });
};

/**
 * Get a coin (unspents only).
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

ChainDB.prototype.getCoin = function getCoin(hash, index, callback) {
  var self = this;
  var key = hash + '/' + index;
  var coin;

  coin = this.coinCache.get(key);
  if (coin)
    return utils.asyncify(callback)(null, coin);

  this.db.fetch('c/' + key, function(data) {
    var coin = bcoin.coin.fromRaw(data);
    coin.hash = hash;
    coin.index = index;
    self.coinCache.set(key, coin);
    return coin;
  }, callback);
};

/**
 * Retrieve a transaction (not filled with coins).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

ChainDB.prototype.getTX = function getTX(hash, callback) {
  var self = this;

  if (!this.options.indexTX)
    return utils.nextTick(callback);

  this.db.fetch('t/' + hash, function(data) {
    return bcoin.tx.fromExtended(data);
  }, function(err, tx) {
    if (err)
      return callback(err);

    if (self.options.paranoid)
      assert(tx.hash('hex') === hash, 'Database is corrupt.');

    return callback(null, tx);
  });
};

/**
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

ChainDB.prototype.hasTX = function hasTX(hash, callback) {
  if (!this.options.indexTX)
    return utils.asyncify(callback)(null, false);

  return this.db.has('t/' + hash, callback);
};

/**
 * Get all coins pertinent to an address.
 * @param {Base58Address|Base58Address[]} addresses
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

ChainDB.prototype.getCoinsByAddress = function getCoinsByAddress(addresses, callback) {
  var self = this;
  var coins = [];

  if (!Array.isArray(addresses))
    addresses = [addresses];

  addresses = utils.uniq(addresses);

  utils.forEachSerial(addresses, function(address, next) {
    address = bcoin.address.getHash(address);
    if (!address)
      return next();
    self.db.lookup({
      gte: 'C/' + address,
      lte: 'C/' + address + '~',
      transform: function(key) {
        key = key.split('/');
        return 'c/' + key[2] + '/' + key[3];
      },
      parse: function(data, key) {
        var coin = bcoin.coin.fromRaw(data);
        var hash = key.split('/');
        coin.hash = hash[1];
        coin.index = +hash[2];
        return coin;
      }
    }, function(err, coin) {
      if (err)
        return next(err);
      coins = coins.concat(coin);
      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, coins);
  });
};

/**
 * Get all transactions pertinent to an address.
 * @param {Base58Address|Base58Address[]} addresses
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

ChainDB.prototype.getTXByAddress = function getTXByAddress(addresses, callback) {
  var self = this;
  var txs = [];
  var have = {};

  if (!Array.isArray(addresses))
    addresses = [addresses];

  addresses = utils.uniq(addresses);

  utils.forEachSerial(addresses, function(address, next) {
    address = bcoin.address.getHash(address);
    if (!address)
      return next();
    self.db.lookup({
      gte: 'T/' + address,
      lte: 'T/' + address + '~',
      transform: function(key) {
        var hash = key.split('/')[2];
        if (addresses.length > 1) {
          if (have[hash])
            return false;
          have[hash] = true;
        }
        return 't/' + hash;
      },
      parse: function(data, key) {
        return bcoin.tx.fromRaw(data);
      }
    }, function(err, tx) {
      if (err)
        return next(err);
      txs = txs.concat(tx);
      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, txs);
  });
};

/**
 * Get a transaction and fill it with coins (historical).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

ChainDB.prototype.getFullTX = function getFullTX(hash, callback) {
  var self = this;

  if (!this.options.indexTX)
    return utils.nextTick(callback);

  return this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback();

    return self.fillHistory(tx, function(err) {
      if (err)
        return callback(err);

      return callback(null, tx);
    });
  });
};

/**
 * Get a block and fill it with coins (historical).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.getFullBlock = function getFullBlock(hash, callback) {
  var self = this;

  return this.getBlock(hash, function(err, block) {
    if (err)
      return callback(err);

    if (!block)
      return callback();

    return self.fillHistoryBlock(block, callback);
  });
};

ChainDB.prototype._ensureBlock = function _ensureBlock(hash, callback) {
  var self = this;

  if (hash instanceof bcoin.block)
    return utils.asyncify(callback)(null, hash);

  return this.getBlock(hash, function(err, block) {
    if (err)
      return callback(err);

    if (!block)
      return callback();

    return self.fillBlock(block, callback);
  });
};

ChainDB.prototype._ensureHistory = function _ensureHistory(hash, callback) {
  if (hash instanceof bcoin.block)
    return utils.asyncify(callback)(null, hash);

  return this.getFullBlock(hash, callback);
};

/**
 * Fill a block with coins (unspent only).
 * @param {Block} block
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.fillBlock = function fillBlock(block, callback) {
  return this.fillCoins(block.txs, function(err) {
    var coins, i, tx, hash, j, input, key;

    if (err)
      return callback(err);

    coins = {};

    for (i = 0; i < block.txs.length; i++) {
      tx = block.txs[i];
      hash = tx.hash('hex');

      for (j = 0; j < tx.inputs.length; j++) {
        input = tx.inputs[j];
        key = input.prevout.hash + '/' + input.prevout.index;
        if (!input.coin && coins[key]) {
          input.coin = coins[key];
          delete coins[key];
        }
      }

      for (j = 0; j < tx.outputs.length; j++)
        coins[hash + '/' + j] = bcoin.coin.fromTX(tx, j);
    }

    return callback(null, block);
  });
};

/**
 * Get coins necessary to be resurrected during a reorg.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Object].
 */

ChainDB.prototype.getUndoCoins = function getUndoCoins(hash, callback) {
  return this.db.fetch('u/' + hash, function(data) {
    var p = new BufferReader(data);
    var coins = [];
    var coin;

    while (p.left()) {
      coin = Parser.parseCoin(p, false);
      coins.push(new bcoin.coin(coin));
    }

    return coins;
  }, callback);
};

/**
 * Fill a block with coins necessary to be resurrected during a reorg.
 * @param {Block} block
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.fillHistoryBlock = function fillHistoryBlock(block, callback) {
  var i, j, k, tx, input;

  return this.getUndoCoins(block.hash('hex'), function(err, coins) {
    if (err)
      return callback(err);

    if (!coins)
      return callback(null, block);

    for (i = 0, k = 0; i < block.txs.length; i++) {
      tx = block.txs[i];

      if (tx.isCoinbase())
        continue;

      for (j = 0; j < tx.inputs.length; j++) {
        input = tx.inputs[j];
        input.coin = coins[k++];
        input.coin.hash = input.prevout.hash;
        input.coin.index = input.prevout.index;
      }
    }

    return callback(null, block);
  });
};

/**
 * Retrieve a block from the database (not filled with coins).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link Block}].
 */

ChainDB.prototype.getBlock = function getBlock(hash, callback) {
  var self = this;
  return this.getBoth(hash, function(err, hash, height) {
    if (err)
      return callback(err);

    if (!hash)
      return callback();

    self.db.fetch('b/' + hash, function(data) {
      var block = bcoin.block.fromRaw(data);
      block.setHeight(height);
      return block;
    }, callback);
  });
};

/**
 * Check whether a transaction is unspent (i.e. not yet _fully_ spent).
 * @see https://bitcointalk.org/index.php?topic=67738.0
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

ChainDB.prototype.isUnspentTX = function isUnspentTX(hash, callback) {
  if (this.options.spv)
    return callback(null, false);

  return this.isSpentTX(hash, function(err, spent) {
    if (err)
      return callback(err);

    return callback(null, !spent);
  });
};

/**
 * Check whether a transaction is _fully_ spent.
 * @see https://bitcointalk.org/index.php?topic=67738.0
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

ChainDB.prototype.isSpentTX = function isSpentTX(hash, callback) {
  var iter;

  if (hash.hash)
    hash = hash.hash('hex');

  iter = this.db.iterator({
    gte: 'c/' + hash,
    lte: 'c/' + hash + '~',
    keys: true,
    values: false,
    fillCache: false,
    keyAsBuffer: false
  });

  iter.next(function(err, key, value) {
    if (err) {
      return iter.end(function() {
        callback(err);
      });
    }

    iter.end(function(err) {
      if (err)
        return callback(err);
      return callback(null, key === undefined);
    });
  });
};

ChainDB.prototype._pruneBlock = function _pruneBlock(block, batch, callback) {
  var futureHeight, key;

  if (this.options.spv)
    return callback();

  if (!this.prune)
    return callback();

  if (block.height <= this.network.block.pruneAfterHeight)
    return callback();

  futureHeight = pad32(block.height + this.keepBlocks);

  batch.put('b/q/' + futureHeight, block.hash());

  key = 'b/q/' + pad32(block.height);

  this.db.fetch(key, function(data) {
    assert(data.length === 32, 'Database corruption.');
    return data.toString('hex');
  }, function(err, hash) {
    if (err)
      return callback(err);

    if (!hash)
      return callback();

    batch.del(key);
    batch.del('b/' + hash);
    batch.del('u/' + hash);

    return callback();
  });
};

/**
 * A null cache. Every method is a NOP.
 * @constructor
 * @param {Number} size
 */

function NullCache(size) {}

NullCache.prototype.set = function set(key, value) {};
NullCache.prototype.remove = function remove(key) {};
NullCache.prototype.get = function get(key) {};
NullCache.prototype.has = function has(key) {};
NullCache.prototype.reset = function reset() {};

/*
 * Expose
 */

module.exports = ChainDB;
