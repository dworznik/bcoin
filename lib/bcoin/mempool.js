/*!
 * mempool.js - mempool for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

/*
 * Database Layout:
 *  (inherits all from txdb)
 */

var bcoin = require('./env');
var EventEmitter = require('events').EventEmitter;
var bn = require('bn.js');
var constants = bcoin.protocol.constants;
var utils = require('./utils');
var assert = utils.assert;
var BufferWriter = require('./writer');
var BufferReader = require('./reader');
var VerifyError = bcoin.errors.VerifyError;
var pad32 = utils.pad32;
var DUMMY = new Buffer([0]);

/**
 * Represents a mempool.
 * @exports Mempool
 * @constructor
 * @param {Object} options
 * @param {String?} options.name - Database name.
 * @param {String?} options.location - Database file location.
 * @param {String?} options.db - Database backend (`"memory"` by default).
 * @param {Boolean?} options.limitFree
 * @param {Number?} options.limitFreeRelay
 * @param {Boolean?} options.relayPriority
 * @param {Boolean?} options.requireStandard
 * @param {Boolean?} options.rejectAbsurdFees
 * @param {Boolean?} options.relay
 * @property {Boolean} loaded
 * @property {Object} db
 * @property {Number} size
 * @property {Number} totalOrphans
 * @property {Locker} locker
 * @property {Number} freeCount
 * @property {Number} lastTime
 * @emits Mempool#open
 * @emits Mempool#error
 * @emits Mempool#tx
 * @emits Mempool#add tx
 * @emits Mempool#remove tx
 */

function Mempool(options) {
  if (!(this instanceof Mempool))
    return new Mempool(options);

  EventEmitter.call(this);

  if (!options)
    options = {};

  this.options = options;
  this.chain = options.chain;

  assert(this.chain, 'Mempool requires a blockchain.');

  this.network = this.chain.network;
  this.loaded = false;

  this.locker = new bcoin.locker(this, this.addTX, 100 << 20);
  this.writeLock = new bcoin.locker(this);

  this.db = null;
  this.size = 0;
  this.waiting = {};
  this.orphans = {};
  this.totalOrphans = 0;
  this.spent = 0;
  this.total = 0;

  this.freeCount = 0;
  this.lastTime = 0;

  this.limitFree = this.options.limitFree !== false;
  this.limitFreeRelay = this.options.limitFreeRelay || 15;
  this.relayPriority = this.options.relayPriority !== false;
  this.requireStandard = this.options.requireStandard != null
    ? this.options.requireStandard
    : this.network.requireStandard;
  this.rejectAbsurdFees = this.options.rejectAbsurdFees !== false;
  this.prematureWitness = !!this.options.prematureWitness;
  this.accurateMemory = !!this.options.accurateMemory;

  this.maxSize = options.maxSize || constants.mempool.MAX_MEMPOOL_SIZE;
  this.minFeeRate = 0;
  this.blockSinceBump = false;
  this.lastFeeUpdate = utils.now();
  this.minReasonableFee = constants.tx.MIN_RELAY;
  this.minRelayFee = constants.tx.MIN_RELAY;

  this._init();
}

utils.inherits(Mempool, EventEmitter);

Mempool.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Purge pending txs in the queue.
 */

Mempool.prototype.purgePending = function purgePending() {
  return this.locker.purgePending();
};

Mempool.prototype._init = function _init() {
  var self = this;
  var unlock = this._lock(utils.nop, []);
  var options = {
    network: this.network,
    name: this.options.name || 'mempool',
    location: this.options.location,
    db: this.options.db || 'memory'
  };

  assert(unlock);

  // Clean the database before loading. The only
  // reason for using an on-disk db for the mempool
  // is not for persistence, but to keep ~300mb of
  // txs out of main memory.
  bcoin.ldb.destroy(options, function(err) {
    if (err) {
      unlock();
      return self.emit('error', err);
    }

    self.db = bcoin.ldb(options);

    self.db.open(function(err) {
      if (err) {
        unlock();
        return self.emit('error', err);
      }
      self.initialMemoryUsage(function(err) {
        if (err) {
          unlock();
          return self.emit('error', err);
        }
        self.chain.open(function(err) {
          if (err) {
            unlock();
            return self.emit('error', err);
          }
          unlock();
          self.loaded = true;
          self.emit('open');
        });
      });
    });
  });
};

/**
 * Tally up total memory usage from database.
 * @param {Function} callback - Returns [Error, Number].
 */

Mempool.prototype.initialMemoryUsage = function initialMemoryUsage(callback) {
  var self = this;
  var i, tx;

  this.getHistory(function(err, txs) {
    if (err)
      return callback(err);

    for (i = 0; i < txs.length; i++) {
      tx = txs[i];
      self.size += self.memUsage(tx);
      self.spent += tx.inputs.length;
      self.total++;
    }

    return callback();
  });
};

/**
 * Open the chain, wait for the database to load.
 * @param {Function} callback
 */

Mempool.prototype.open = function open(callback) {
  if (this.loaded)
    return utils.nextTick(callback);

  return this.once('open', callback);
};

/**
 * Close the chain, wait for the database to close.
 * @method
 * @param {Function} callback
 */

Mempool.prototype.close =
Mempool.prototype.destroy = function destroy(callback) {
  this.db.close(utils.ensure(callback));
};

/**
 * Notify the mempool that a new block has come
 * in (removes all transactions contained in the
 * block from the mempool).
 * @param {Block} block
 * @param {Function} callback
 */

Mempool.prototype.addBlock = function addBlock(block, callback, force) {
  var self = this;
  var txs = [];
  var unlock = this._lock(addBlock, [block, callback], force);
  var entry;

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  utils.forEachSerial(block.txs.slice().reverse(), function(tx, next) {
    var hash = tx.hash('hex');
    var copy;

    if (tx.isCoinbase())
      return next();

    self.getEntry(hash, function(err, entry) {
      if (err)
        return next(err);

      if (!entry)
        return self.removeOrphan(hash, next);

      self.removeUnchecked(entry, false, function(err) {
        if (err)
          return next(err);

        self.emit('confirmed', tx, block);

        return next();
      }, true);
    });
  }, function(err) {
    if (err)
      return callback(err);

    self.blockSinceBump = true;
    self.lastFeeUpdate = utils.now();

    return callback();
  });
};

/**
 * Notify the mempool that a block has been disconnected
 * from the main chain (reinserts transactions into the mempool).
 * @param {Block} block
 * @param {Function} callback
 */

Mempool.prototype.removeBlock = function removeBlock(block, callback, force) {
  var self = this;
  var unlock = this._lock(removeBlock, [block, callback], force);
  var entry;

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  utils.forEachSerial(block.txs, function(tx, next) {
    if (tx.isCoinbase())
      return next();

    self.hasTX(tx.hash('hex'), function(err, result) {
      if (err)
        return next(err);

      if (result)
        return next();

      entry = MempoolEntry.fromTX(tx, block.height);

      self.addUnchecked(entry, function(err) {
        if (err)
          return next(err);

        self.emit('unconfirmed', tx, block);

        return next();
      }, true);
    });
  }, callback);
};

/**
 * Ensure the size of the mempool stays below 300mb.
 * @param {Hash} entryHash - TX that initiated the trim.
 * @param {Function} callback
 */

Mempool.prototype.limitMempoolSize = function limitMempoolSize(entryHash, callback) {
  var self = this;
  var trimmed = false;

  if (this.getSize() <= this.maxSize)
    return callback(null, trimmed);

  this.getRange({
    start: 0,
    end: utils.now() - constants.mempool.MEMPOOL_EXPIRY
  }, function(err, entries) {
    if (err)
      return callback(err);

    utils.forEachSerial(function(entry, next) {
      if (self.getSize() <= self.maxSize)
        return callback(null, trimmed);

      if (!trimmed)
        trimmed = entry.tx.hash('hex') === entryHash;

      self.removeUnchecked(entry, true, next, true);
    }, function(err) {
      if (err)
        return callback(err);

      if (self.getSize() <= self.maxSize)
        return callback(null, trimmed);

      self.getSnapshot(function(err, hashes) {
        if (err)
          return callback(err);

        utils.forEachSerial(hashes, function(hash, next) {
          if (self.getSize() <= self.maxSize)
            return callback(null, trimmed);

          self.getEntry(hash, function(err, entry) {
            if (err)
              return next(err);

            if (!entry)
              return next();

            if (!trimmed)
              trimmed = hash === entryHash;

            self.removeUnchecked(entry, true, next, true);
          });
        }, function(err) {
          if (err)
            return callback(err);

          return callback(null, trimmed);
        });
      });
    });
  });
};

/**
 * Purge orphan transactions from the mempool.
 * @param {Function} callback
 */

Mempool.prototype.limitOrphans = function limitOrphans(callback) {
  var self = this;
  var orphans = Object.keys(this.orphans);
  var i, hash;

  (function next() {
    if (self.totalOrphans <= constants.mempool.MAX_ORPHAN_TX)
      return callback();

    i = bcoin.ec.rand(0, orphans.length);
    hash = orphans[i];
    orphans.splice(i, 1);

    bcoin.debug('Removing orphan %s from mempool.', utils.revHex(hash));

    self.removeOrphan(hash, next);
  })();
};

/**
 * Retrieve a transaction from the mempool.
 * Note that this will not be filled with coins.
 * @param {TX|Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.getTX = function getTX(hash, callback) {
  return this.db.fetch('t/' + hash, function(data) {
    return bcoin.tx.fromRaw(data);
  }, callback);
};

/**
 * Retrieve a transaction from the mempool.
 * Note that this will not be filled with coins.
 * @param {TX|Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.getEntry = function getEntry(hash, callback) {
  return this.db.fetch('t/' + hash, function(data) {
    return MempoolEntry.fromRaw(data);
  }, callback);
};

/**
 * Retrieve a coin from the mempool (unspents only).
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

Mempool.prototype.getCoin = function getCoin(hash, index, callback) {
  return this.db.fetch('c/' + hash + '/' + index, function(data) {
    var coin = bcoin.coin.fromRaw(data);
    coin.hash = hash;
    coin.index = index;
    return coin;
  }, callback);
};

/**
 * Check to see if a coin has been spent. This differs from
 * {@link ChainDB#isSpent} in that it actually maintains a
 * map of spent coins, whereas ChainDB may return `true`
 * for transaction outputs that never existed.
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.isSpent = function isSpent(hash, index, callback) {
  return this.db.fetch('s/' + hash + '/' + index, function(data) {
    assert(data.length === 32, 'Database corruption.');
    return data.toString('hex');
  }, callback);
};

/**
 * Find all coins pertaining to a certain address.
 * @param {Base58Address|Base58Address[]} addresses
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

Mempool.prototype.getCoinsByAddress = function getCoinsByAddress(addresses, callback) {
  return this.chain.db.getCoinsByAddress.call(this, addresses, callback);
};

/**
 * Find all transactions pertaining to a certain address.
 * @param {Base58Address|Base58Address[]} addresses
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Mempool.prototype.getTXByAddress = function getTXByAddress(addresses, callback) {
  return this.chain.db.getTXByAddress.call(this, addresses, callback);
};

/**
 * Fill a transaction with all available transaction outputs
 * in the mempool. This differs from {@link Mempool#fillCoins}
 * in that it will fill with all historical coins and not
 * just unspent coins.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillHistory = function fillHistory(tx, callback) {
  var self = this;

  if (Array.isArray(tx)) {
    return utils.forEachSerial(tx, function(tx, next) {
      self.fillHistory(tx, next);
    }, callback);
  }

  callback = utils.asyncify(callback);

  if (tx.isCoinbase())
    return callback(null, tx);

  utils.forEach(tx.inputs, function(input, next) {
    if (input.coin)
      return next();

    self.getTX(input.prevout.hash, function(err, tx) {
      if (err)
        return next(err);

      if (tx)
        input.coin = bcoin.coin(tx, input.prevout.index);

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, tx);
  });
};

/**
 * Fill a transaction with all available (unspent) coins
 * in the mempool.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillCoins = function fillCoins(tx, callback) {
  var self = this;

  if (Array.isArray(tx)) {
    return utils.forEachSerial(tx, function(tx, next) {
      self.fillCoins(tx, next);
    }, callback);
  }

  callback = utils.asyncify(callback);

  if (tx.isCoinbase())
    return callback(null, tx);

  utils.forEach(tx.inputs, function(input, next) {
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
 * Test the mempool to see if it contains a transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.hasTX = function hasTX(hash, callback) {
  return this.db.has('t/' + hash, callback);
};

/**
 * Find transactions within a range.
 * @param {Object} range
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Mempool.prototype.getRange = function getRange(options, callback) {
  return this.db.lookup({
    gte: 'm/' + pad32(options.start) + '/',
    lte: 'm/' + pad32(options.end) + '/~',
    transform: function(key) {
      return 't/' + key.split('/')[2];
    },
    parse: function(data, key) {
      return MempoolEntry.fromRaw(data);
    },
    limit: options.limit,
    reverse: options.reverse
  }, callback);
};

/**
 * Test the mempool to see if it contains a transaction or an orphan.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.has = function has(hash, callback) {
  var self = this;

  if (this.locker.hasPending(hash))
    return utils.asyncify(callback)(null, true);

  return this.hasTX(hash, function(err, exists) {
    if (err)
      return callback(err);

    if (exists)
      return callback(null, true);

    self.hasOrphan(hash, callback);
  });
};

/**
 * Add a transaction to the mempool. Note that this
 * will lock the mempool until the transaction is
 * fully processed.
 * @param {TX} tx
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.addTX = function addTX(tx, callback, force) {
  var self = this;
  var flags = constants.flags.STANDARD_VERIFY_FLAGS;
  var lockFlags = constants.flags.STANDARD_LOCKTIME_FLAGS;
  var hash = tx.hash('hex');
  var ret = {};
  var now, entry;

  var unlock = this._lock(addTX, [tx, callback], force);
  if (!unlock)
    return;

  if (tx.mutable)
    tx = tx.toTX();

  callback = utils.wrap(callback, unlock);
  callback = utils.asyncify(callback);

  if (tx.ts !== 0) {
    return callback(new VerifyError(tx,
      'alreadyknown',
      'txn-already-known',
      0));
  }

  if (!tx.isSane(ret))
    return callback(new VerifyError(tx, 'invalid', ret.reason, ret.score));

  if (tx.isCoinbase())
    return callback(new VerifyError(tx, 'invalid', 'coinbase', 100));

  if (this.requireStandard) {
    if (!tx.isStandard(flags, ret))
      return callback(new VerifyError(tx, ret.reason, 0));

    if (!this.chain.csvActive && tx.version >= 2) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'premature-version2-tx',
        0));
    }
  }

  if (!this.chain.segwitActive && !this.prematureWitness) {
    if (tx.hasWitness())
      return callback(new VerifyError(tx, 'nonstandard', 'no-witness-yet', 0));
  }

  this.chain.checkFinal(this.chain.tip, tx, lockFlags, function(err, isFinal) {
    if (err)
      return callback(err);

    if (!isFinal)
      return callback(new VerifyError(tx, 'nonstandard', 'non-final', 0));

    self.has(hash, function(err, exists) {
      if (err)
        return callback(err);

      if (exists) {
        return callback(new VerifyError(tx,
          'alreadyknown',
          'txn-already-in-mempool',
          0));
      }

      self.chain.db.isUnspentTX(hash, function(err, exists) {
        if (err)
          return callback(err);

        if (exists) {
          return callback(new VerifyError(tx,
            'alreadyknown',
            'txn-already-known',
            0));
        }

        self.isDoubleSpend(tx, function(err, doubleSpend) {
          if (err)
            return callback(err);

          if (doubleSpend) {
            return callback(new VerifyError(tx,
              'duplicate',
              'bad-txns-inputs-spent',
              0));
          }

          self.fillAllCoins(tx, function(err) {
            if (err)
              return callback(err);

            if (!tx.hasCoins())
              return self.storeOrphan(tx, callback);

            entry = MempoolEntry.fromTX(tx, self.chain.height);

            self.verify(entry, function(err) {
              if (err)
                return callback(err);

              self.addUnchecked(entry, function(err) {
                if (err)
                  return callback(err);

                self.limitMempoolSize(hash, function(err, trimmed) {
                  if (err)
                    return callback(err);

                  if (trimmed) {
                    return callback(new VerifyError(tx,
                      'insufficientfee',
                      'mempool full',
                      0));
                  }

                  return callback();
                });
              }, true);
            });
          });
        });
      });
    });
  });
};

/**
 * Add a transaction to the mempool without performing any
 * validation. Note that this method does not lock the mempool
 * and may lend itself to race conditions if used unwisely.
 * This function will also resolve orphans if possible (the
 * resolved orphans _will_ be validated).
 * @param {TX} tx
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.addUnchecked = function addUnchecked(entry, callback, force) {
  var self = this;

  var unlock = this._lock(addUnchecked, [entry, callback], force);
  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this._addUnchecked(entry, function(err) {
    if (err)
      return callback(err);

    self.spent += entry.tx.inputs.length;
    self.size += self.memUsage(entry.tx);
    self.total++;
    self.emit('tx', entry.tx);
    self.emit('add tx', entry.tx);

    bcoin.debug('Added tx %s to the mempool.', entry.tx.rhash);

    self.resolveOrphans(entry.tx, function(err, resolved) {
      if (err)
        return callback(err);

      utils.forEachSerial(resolved, function(tx, next) {
        var entry = MempoolEntry.fromTX(tx, self.chain.height);
        self.verify(entry, function(err) {
          if (err) {
            if (err.type === 'VerifyError') {
              bcoin.debug('Could not resolve orphan %s: %s.',
                tx.rhash,
                err.message);
              return next();
            }
            self.emit('error', err);
            return next();
          }
          self.addUnchecked(entry, function(err) {
            if (err) {
              self.emit('error', err);
              return next();
            }
            bcoin.debug('Resolved orphan %s in mempool.', entry.tx.rhash);
            next();
          }, true);
        });
      }, callback);
    });
  });
};

/**
 * Remove a transaction from the mempool. Generally
 * only called when a new block is added to the main chain.
 * @param {TX} tx
 * @param {Function} callback
 */

Mempool.prototype.removeUnchecked = function removeUnchecked(entry, limit, callback, force) {
  var self = this;
  var rate;

  var unlock = this._lock(removeUnchecked, [entry, limit, callback], force);
  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this.fillAllHistory(entry.tx, function(err, tx) {
    if (err)
      return callback(err);

    self.removeOrphan(entry.tx, function(err) {
      if (err)
        return callback(err);

      self._removeUnchecked(entry, limit, function(err) {
        if (err)
          return callback(err);

        self.spent -= entry.tx.inputs.length;
        self.size -= self.memUsage(entry.tx);
        self.total--;

        if (limit) {
          rate = entry.fees.muln(1000).divn(entry.size).toNumber();
          rate += self.minReasonableFee;
          if (rate > self.minFeeRate) {
            self.minFeeRate = rate;
            self.blockSinceBump = false;
          }
        }

        self.emit('remove tx', entry.tx);

        return callback();
      });
    });
  });
};

/**
 * Calculate and update the minimum rolling fee rate.
 * @returns {Number} Rate.
 */

Mempool.prototype.getMinRate = function getMinRate() {
  var now, halflife, size;

  if (!this.blockSinceBump || this.minFeeRate === 0)
    return this.minFeeRate;

  now = utils.now();

  if (now > this.lastFeeUpdate + 10) {
    halflife = constants.mempool.FEE_HALFLIFE;
    size = this.getSize();

    if (size < this.maxSize / 4)
      halflife >>>= 2;
    else if (size < this.maxSize / 2)
      halflife >>>= 1;

    this.minFeeRate /= Math.pow(2.0, (now - this.lastFeeUpdate) / halflife | 0);
    this.minFeeRate |= 0;
    this.lastFeeUpdate = now;

    if (this.minFeeRate < this.minReasonableFee / 2) {
      this.minFeeRate = 0;
      return 0;
    }
  }

  if (this.minFeeRate > this.minReasonableFee)
    return this.minFeeRate;

  return this.minReasonableFee;
};

/**
 * Verify a transaction with mempool standards.
 * @param {TX} tx
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.verify = function verify(entry, callback) {
  var self = this;
  var height = this.chain.height + 1;
  var lockFlags = constants.flags.STANDARD_LOCKTIME_FLAGS;
  var flags = constants.flags.STANDARD_VERIFY_FLAGS;
  var mandatory = constants.flags.MANDATORY_VERIFY_FLAGS;
  var tx = entry.tx;
  var ret = {};
  var fee, modFee, now, size, rejectFee, minRelayFee, minRate;

  if (this.chain.segwitActive)
    mandatory |= constants.flags.VERIFY_WITNESS;

  this.checkLocks(tx, lockFlags, function(err, result) {
    if (err)
      return callback(err);

    if (!result) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'non-BIP68-final',
        0));
    }

    if (self.requireStandard && !tx.hasStandardInputs(flags)) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'bad-txns-nonstandard-inputs',
        0));
    }

    if (tx.getSigopsCost(flags) > constants.tx.MAX_SIGOPS_COST) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'bad-txns-too-many-sigops',
        0));
    }

    fee = tx.getFee();
    modFee = entry.fees;
    size = entry.size;
    minRate = self.getMinRate();

    if (minRate > self.minRelayFee)
      self.network.updateMinRelay(minRate);

    rejectFee = tx.getMinFee(size, minRate);
    minRelayFee = tx.getMinFee(size, self.minRelayFee);

    if (rejectFee.cmpn(0) > 0 && modFee.cmp(rejectFee) < 0) {
      return callback(new VerifyError(tx,
        'insufficientfee',
        'mempool min fee not met',
        0));
    }

    if (self.relayPriority && modFee.cmp(minRelayFee) < 0) {
      if (!entry.isFree(height)) {
        return callback(new VerifyError(tx,
          'insufficientfee',
          'insufficient priority',
          0));
      }
    }

    // Continuously rate-limit free (really, very-low-fee)
    // transactions. This mitigates 'penny-flooding'. i.e.
    // sending thousands of free transactions just to be
    // annoying or make others' transactions take longer
    // to confirm.
    if (self.limitFree && modFee.cmp(minRelayFee) < 0) {
      now = utils.now();

      if (!self.lastTime)
        self.lastTime = now;

      // Use an exponentially decaying ~10-minute window:
      self.freeCount *= Math.pow(1 - 1 / 600, now - self.lastTime);
      self.lastTime = now;

      // The limitFreeRelay unit is thousand-bytes-per-minute
      // At default rate it would take over a month to fill 1GB
      if (self.freeCount > self.limitFreeRelay * 10 * 1000) {
        return callback(new VerifyError(tx,
          'insufficientfee',
          'rate limited free transaction',
          0));
      }

      self.freeCount += size;
    }

    if (self.rejectAbsurdFees && fee.cmp(minRelayFee.muln(10000)) > 0)
      return callback(new VerifyError(tx, 'highfee', 'absurdly-high-fee', 0));

    if (!tx.checkInputs(height, ret))
      return callback(new VerifyError(tx, 'invalid', ret.reason, ret.score));

    self.countAncestors(tx, function(err, count) {
      if (err)
        return callback(err);

      if (count > constants.mempool.ANCESTOR_LIMIT) {
        return callback(new VerifyError(tx,
          'nonstandard',
          'too-long-mempool-chain',
          0));
      }

      // Do this in the worker pool.
      tx.verifyAsync(null, true, flags, function(err, result) {
        if (err)
          return callback(err);

        if (!result) {
          return tx.verifyAsync(null, true, mandatory, function(err, result) {
            if (err)
              return callback(err);

            if (result) {
              return callback(new VerifyError(tx,
                'nonstandard',
                'non-mandatory-script-verify-flag',
                0));
            }

            return callback(new VerifyError(tx,
              'nonstandard',
              'mandatory-script-verify-flag',
              0));
          });
        }

        return callback();
      });
    });
  });
};

/**
 * Count the highest number of
 * ancestors a transaction may have.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, Number].
 */

Mempool.prototype.countAncestors = function countAncestors(tx, callback) {
  var self = this;
  var max = 0;

  utils.forEachSerial(tx.inputs, function(input, next, i) {
    var count = 0;
    self.getTX(input.prevout.hash, function(err, tx) {
      if (err)
        return next(err);

      if (!tx)
        return next();

      count += 1;

      self.countAncestors(tx, function(err, prev) {
        if (err)
          return next(err);

        count += prev;

        if (count > max)
          max = count;

        next();
      });
    });
  }, function(err) {
    if (err)
      return callback(err);

    return callback(null, max);
  });
};

/**
 * Store an orphaned transaction.
 * @param {TX} tx
 * @param {Function} callback
 */

Mempool.prototype.storeOrphan = function storeOrphan(tx, callback, force) {
  var self = this;
  var prevout = {};
  var i, hash, batch, input, prev;

  if (tx.getSize() > 5000) {
    bcoin.debug('Ignoring large orphan: %s', tx.rhash);
    return callback();
  }

  hash = tx.hash('hex');

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    if (!input.coin)
      prevout[input.prevout.hash] = true;
  }

  prevout = Object.keys(prevout);

  assert(prevout.length > 0);

  for (i = 0; i < prevout.length; i++) {
    prev = prevout[i];
    if (!this.waiting[prev])
      this.waiting[prev] = [];
    this.waiting[prev].push(hash);
  }

  this.orphans[hash] = tx.toExtended(true);
  this.totalOrphans++;

  bcoin.debug('Added orphan %s to mempool.', tx.rhash);

  if (this.totalOrphans > constants.mempool.MAX_ORPHAN_TX)
    return this.limitOrphans(callback);

  return callback();
};

/**
 * Return the full balance of all unspents in the mempool
 * (not very useful in practice, only used for testing).
 */

Mempool.prototype.getBalance = function getBalance(callback) {
  var total = new bn(0);
  var i;

  return this.db.iterate({
    gte: 'c',
    lte: 'c~',
    values: true,
    parse: function(data, key) {
      return bcoin.coin.fromRaw(data);
    }
  }, function(err, coins) {
    if (err)
      return callback(err);

    for (i = 0; i < coins.length; i++)
      total.iadd(coins[i].value);

    return callback(null, {
      confirmed: new bn(0),
      unconfirmed: total,
      total: total
    });
  });
};

/**
 * Retrieve _all_ transactions from the mempool.
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Mempool.prototype.getHistory = function getHistory(callback) {
  return this.db.iterate({
    gte: 't',
    lte: 't~',
    values: true,
    parse: function(data, key) {
      return bcoin.tx.fromRaw(data);
    }
  }, callback);
};

/**
 * Get hashes of all orphans a transaction hash potentially resolves.
 * @param {Hash} hash - Resolving transaction.
 * @param {Function} callback - Return [Error, {@link Hash}[]].
 */

Mempool.prototype.getWaiting = function getWaiting(hash, callback) {
  return callback(null, this.waiting[hash] || []);
};

/**
 * Retrieve an orphan transaction.
 * @param {Hash} orphanHash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.getOrphan = function getOrphan(orphanHash, callback) {
  var self = this;
  var orphan = this.orphans[orphanHash];

  if (!orphan)
    return callback();

  try {
    orphan = bcoin.tx.fromExtended(orphan, true);
  } catch (e) {
    return callback(e);
  }

  return callback(null, orphan);
};

/**
 * @param {Hash} orphanHash
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.hasOrphan = function hasOrphan(orphanHash, callback) {
  return callback(null, this.orphans[orphanHash] != null);
};

/**
 * Potentially resolve any transactions
 * that redeem the passed-in transaction.
 * Deletes all orphan entries and
 * returns orphan hashes.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

Mempool.prototype.resolveOrphans = function resolveOrphans(tx, callback, force) {
  var self = this;
  var hash = tx.hash('hex');
  var resolved = [];

  this.getWaiting(hash, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(orphanHash, next, i) {
      self.getOrphan(orphanHash, function(err, orphan) {
        if (err)
          return next(err);

        if (!orphan)
          return next();

        orphan.fillCoins(tx);

        if (orphan.hasCoins()) {
          self.totalOrphans--;
          delete self.orphans[orphanHash];
          resolved.push(orphan);
          return next();
        }

        self.orphans[orphanHash] = orphan.toExtended(true);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      delete self.waiting[hash];

      return callback(null, resolved);
    });
  });
};

/**
 * Remove a transaction from the mempool.
 * @param {TX|Hash} tx
 * @param {Function} callback
 */

Mempool.prototype.removeOrphan = function removeOrphan(tx, callback) {
  var self = this;
  var i, prevout, hash;

  function getOrphan(tx, callback) {
    if (typeof tx === 'string')
      return self.getOrphan(tx, callback);
    return callback(null, tx);
  }

  return getOrphan(tx, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback();

    hash = tx.hash('hex');
    prevout = tx.getPrevout();

    utils.forEachSerial(prevout, function(prev, next) {
      self.getWaiting(prev, function(err, hashes) {
        if (err)
          return next(err);

        if (hashes.length === 0)
          return next();

        i = hashes.indexOf(hash);
        if (i !== -1)
          hashes.splice(i, 1);

        if (hashes.length === 0) {
          delete self.waiting[prev];
          return next();
        }

        self.waiting[prev] = hashes;

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      delete self.orphans[hash];
      self.totalOrphans--;

      callback();
    });
  });
};

/**
 * Fill transaction with all unspent _and spent_
 * coins. Similar to {@link Mempool#fillHistory}
 * except that it will also fill with coins
 * from the blockchain as well.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillAllHistory = function fillAllHistory(tx, callback) {
  var self = this;

  this.fillHistory(tx, function(err) {
    if (err)
      return callback(err);

    if (tx.hasCoins())
      return callback(null, tx);

    self.chain.db.fillCoins(tx, callback);
  });
};

/**
 * Fill transaction with all unspent
 * coins. Similar to {@link Mempool#fillCoins}
 * except that it will also fill with coins
 * from the blockchain as well.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillAllCoins = function fillAllCoins(tx, callback) {
  var self = this;
  var doubleSpend = false;

  this.fillCoins(tx, function(err) {
    if (err)
      return callback(err);

    if (tx.hasCoins())
      return callback(null, tx);

    utils.forEach(tx.inputs, function(input, next) {
      var hash = input.prevout.hash;
      var index = input.prevout.index;

      self.isSpent(hash, index, function(err, spent) {
        if (err)
          return callback(err);

        if (spent) {
          doubleSpend = true;
          return next();
        }

        self.chain.db.getCoin(hash, index, function(err, coin) {
          if (err)
            return next(err);

          if (!coin)
            return next();

          input.coin = coin;

          next();
        });
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, tx, doubleSpend);
    });
  });
};

/**
 * Get a snapshot of all transaction hashes in the mempool. Used
 * for generating INV packets in response to MEMPOOL packets.
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

Mempool.prototype.getSnapshot = function getSnapshot(callback) {
  return this.db.iterate({
    gte: 't',
    lte: 't~',
    transform: function(key) {
      return key.split('/')[1];
    }
  }, callback);
};

/**
 * Check sequence locks on a transaction against the current tip.
 * @param {TX} tx
 * @param {LockFlags} flags
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.checkLocks = function checkLocks(tx, flags, callback) {
  return this.chain.checkLocks(this.chain.tip, tx, flags, callback);
};

/**
 * Test all of a transactions outpoints to see if they are doublespends.
 * Note that this will only test against the mempool spents, not the
 * blockchain's. The blockchain spents are not checked against because
 * the blockchain does not maintain a spent list. The transaction will
 * be seen as an orphan rather than a double spend.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.isDoubleSpend = function isDoubleSpend(tx, callback) {
  var self = this;
  utils.everySerial(tx.inputs, function(input, next) {
    self.isSpent(input.prevout.hash, input.prevout.index, function(err, spent) {
      if (err)
        return next(err);
      return next(null, !spent);
    });
  }, function(err, result) {
    if (err)
      return callback(err);
    return callback(null, !result);
  });
};

/**
 * Calculate bitcoinj-style confidence.
 * @see https://github.com/bitcoinj/bitcoinj/blob/master/core/src/main/java/org/bitcoinj/core/TransactionConfidence.java
 * @param {TX|Hash} hash
 * @param {Function} callback - Returns [Error, Number].
 */

Mempool.prototype.getConfidence = function getConfidence(hash, callback) {
  var self = this;

  callback = utils.asyncify(callback);

  function getTX(callback) {
    if (hash instanceof bcoin.tx)
      return callback(null, hash, hash.hash('hex'));

    return this.getTX(hash, function(err, tx) {
      if (err)
        return callback(err);
      return callback(null, tx, hash);
    });
  }

  function isDoubleSpend(tx, callback) {
    if (tx)
      return self.isDoubleSpend(tx, callback);
    return callback(null, false);
  }

  return getTX(function(err, tx, hash) {
    if (err)
      return callback(err);

    return self.hasTX(hash, function(err, result) {
      if (err)
        return callback(err);

      if (result)
        return callback(null, constants.confidence.PENDING);

      return isDoubleSpend(tx, function(err, result) {
        if (err)
          return callback(err);

        if (result)
          return callback(null, constants.confidence.INCONFLICT);

        if (tx && tx.block) {
          return self.chain.db.isMainChain(tx.block, function(err, result) {
            if (err)
              return callback(err);

            if (result)
              return callback(null, constants.confidence.BUILDING);

            return callback(null, constants.confidence.DEAD);
          });
        }

        return self.chain.db.isUnspentTX(hash, function(err, existing) {
          if (err)
            return callback(err);

          if (existing)
            return callback(null, constants.confidence.BUILDING);

          return callback(null, constants.confidence.UNKNOWN);
        });
      });
    });
  });
};

/**
 * Add a transaction to the mempool database.
 * @private
 * @param {TX} tx
 * @param {Function} callback
 */

Mempool.prototype._addUnchecked = function _addUnchecked(entry, callback) {
  var self = this;
  var tx = entry.tx;
  var hash = tx.hash('hex');
  var i, addresses, address, input, output, key, coin, batch;

  batch = this.db.batch();

  batch.put('t/' + hash, tx.toExtended());
  batch.put('m/' + pad32(entry.ts) + '/' + hash, DUMMY);

  if (this.options.indexAddress) {
    addresses = tx.getHashes();
    for (i = 0; i < addresses.length; i++)
      batch.put('T/' + addresses[i] + '/' + hash, DUMMY);
  }

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    key = input.prevout.hash + '/' + input.prevout.index;

    if (tx.isCoinbase())
      break;

    assert(input.coin);

    batch.del('c/' + key);
    batch.put('s/' + key, tx.hash());

    if (this.options.indexAddress) {
      address = input.getHash();
      if (address)
        batch.del('C/' + address + '/' + key);
    }
  }

  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    key = hash + '/' + i;

    if (output.script.isUnspendable())
      continue;

    coin = bcoin.coin(tx, i).toRaw();

    batch.put('c/' + key, coin);

    if (this.options.indexAddress) {
      address = output.getHash();
      if (address)
        batch.put('C/' + address + '/' + key, DUMMY);
    }
  }

  return batch.write(callback);
};

/**
 * Remove a transaction from the database. Note
 * that this _may_ not disconnect the inputs.
 * @private
 * @param {Hash} hash
 * @param {Function} callback
 */

Mempool.prototype._removeUnchecked = function _removeUnchecked(hash, limit, callback) {
  var self = this;
  var batch, i, addresses, output, tx;

  if (hash.tx)
    hash = hash.tx.hash('hex');

  this.getEntry(hash, function(err, entry) {
    if (err)
      return callback(err);

    if (!entry)
      return callback();

    tx = entry.tx;
    batch = self.db.batch();

    batch.del('t/' + hash);
    batch.del('m/' + pad32(entry.ts) + '/' + hash);

    if (self.options.indexAddress) {
      addresses = tx.getHashes();
      for (i = 0; i < addresses.length; i++)
        batch.del('T/' + addresses[i] + '/' + hash);
    }

    utils.forEachSerial(tx.inputs, function(input, next) {
      var key = input.prevout.hash + '/' + input.prevout.index;
      var address;

      if (tx.isCoinbase())
        return next();

      if (!input.coin)
        return next();

      batch.del('s/' + key);

      self.hasTX(input.prevout.hash, function(err, result) {
        if (err)
          return next(err);

        if (result) {
          batch.put('c/' + key, input.coin.toRaw());
          if (self.options.indexAddress) {
            address = input.getHash();
            if (address)
              batch.put('C/' + address + '/' + key, DUMMY);
          }
        } else {
          batch.del('c/' + key);
          if (self.options.indexAddress) {
            address = input.getHash();
            if (address)
              batch.del('C/' + address + '/' + key);
          }
        }

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      utils.forEachSerial(tx.outputs, function(output, next, i) {
        key = hash + '/' + i;

        if (output.script.isUnspendable())
          return next();

        batch.del('c/' + key);

        if (self.options.indexAddress) {
          address = output.getHash();
          if (address)
            batch.del('C/' + address + '/' + key);
        }

        if (!limit)
          return next();

        self.isSpent(hash, i, function(err, spender) {
          if (err)
            return next(err);

          if (!spender)
            return next();

          self._removeUnchecked(spender, limit, next);
        });
      }, function(err) {
        if (err)
          return callback(err);

        return batch.write(callback);
      });
    });
  });
};

/**
 * Calculate the memory usage of a transaction.
 * @param {TX} tx
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.memUsage = function memUsage(tx) {
  if (this.accurateMemory)
    return this.memUsageAccurate(tx);
  return this.memUsageBitcoind(tx);
};

/**
 * Calculate the memory usage of a transaction
 * accurately (the amount bcoin is actually using).
 * @param {TX} tx
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.memUsageAccurate = function memUsageAccurate(tx) {
  return 0
    + (tx.getSize() + 4 + 32 + 4 + 4 + 4) // extended
    + (2 + 64) // t
    + (2 + 10 + 1 + 64) // m
    + (tx.inputs.length * (2 + 64 + 1 + 2 + 32)) // s
    + (tx.outputs.length * (2 + 64 + 1 + 2 + 80)); // c
};

/**
 * Calculate the memory usage of a transaction based on
 * bitcoind's memory estimation algorithm. This will
 * _not_ be accurate to bcoin's actual memory usage,
 * but it helps accurately replicate the bitcoind
 * mempool.
 * @see DynamicMemoryUsage()
 * @param {TX} tx
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.memUsageBitcoind = function memUsageBitcoind(tx) {
  var mem = 0;
  var i, input;

  mem += mallocUsage(tx.inputs.length)
  mem += mallocUsage(tx.outputs.length);

  for (i = 0; i < tx.inputs.length; i++)
    mem += mallocUsage(tx.inputs[i].script.getSize());

  for (i = 0; i < tx.outputs.length; i++)
    mem += mallocUsage(tx.outputs[i].script.getSize());

  mem += mallocUsage(tx.inputs.length);

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    mem += mallocUsage(input.witness.items.length);
    for (j = 0; j < input.witness.items.length; j++)
      mem += mallocUsage(input.witness[j].items.length);
  }

  return mem;
};

/**
 * Calculate the memory usage of the entire mempool.
 * @see DynamicMemoryUsage()
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.getSize = function getSize() {
  if (this.accurateMemory)
    return this.size;

  return mallocUsage(162 + 15 * ptrSize) * this.total // entries
    + mallocUsage(this.spent) // mapNextTx
    + mallocUsage(this.total) // mapDeltas
    + mallocUsage(this.total) // mapLinks
    + this.size;
};

/**
 * Represents a mempool entry.
 * @exports MempoolEntry
 * @constructor
 * @param {Object} options
 * @param {TX} options.tx - Transaction in mempool.
 * @param {Number} options.height - Entry height.
 * @param {BN} options.priority - Entry priority.
 * @param {Number} options.ts - Entry time.
 * @param {BN} options.chainValue - Value of on-chain coins.
 * @param {Number} options.count - Number of descendants (includes tx).
 * @param {Number} options.size - TX and descendant modified size.
 * @param {BN} options.fees - TX and descendant delta-applied fees.
 * @property {TX} tx
 * @property {Number} height
 * @property {BN} priority
 * @property {Number} ts
 * @property {BN} chainValue
 * @property {Number} count
 * @property {Number} size
 * @property {BN} fees
 */

function MempoolEntry(options) {
  if (!(this instanceof MempoolEntry))
    return new MempoolEntry(options);

  this.tx = options.tx;
  this.height = options.height;
  this.priority = options.priority;
  this.ts = options.ts;

  this.chainValue = options.chainValue;
  this.count = options.count;
  this.size = options.size;
  this.fees = options.fees;
}

/**
 * Create a mempool entry from a TX.
 * @param {TX} tx
 * @param {Number} height - Entry height.
 * @returns {MempoolEntry}
 */

MempoolEntry.fromTX = function fromTX(tx, height) {
  var data = tx.getPriority(height);

  return new MempoolEntry({
    tx: tx,
    height: height,
    priority: data.priority,
    chainValue: data.value,
    ts: utils.now(),
    count: 1,
    size: tx.getVirtualSize(),
    fees: tx.getFee()
  });
};

/**
 * Serialize a mempool entry. Note that this
 * can still be parsed as a regular tx since
 * the mempool entry data comes after the
 * serialized transaction.
 * @param {TX} tx
 * @param {Number} height - Entry height.
 * @returns {MempoolEntry}
 */

MempoolEntry.prototype.toRaw = function toRaw() {
  var p = new BufferWriter();
  bcoin.protocol.framer.tx(this.tx, p);
  p.writeU32(this.height);
  p.writeVarint(this.priority);
  p.writeVarint(this.chainValue);
  p.writeU32(this.ts);
  p.writeU32(this.count);
  p.writeU32(this.size);
  p.writeVarint(this.fees);
  return p.render();
};

/**
 * Create a mempool entry from serialized data.
 * @param {Buffer|BufferReader} data
 * @returns {MempoolEntry}
 */

MempoolEntry.fromRaw = function fromRaw(data) {
  var p = new BufferReader(data);
  return new MempoolEntry({
    tx: bcoin.tx.fromRaw(p),
    height: p.readU32(),
    priority: p.readVarint(true),
    chainValue: p.readVarint(true),
    ts: p.readU32(),
    count: p.readU32(),
    size: p.readU32(),
    fees: p.readVarint(true)
  });
};

/**
 * Calculate priority, taking into account
 * the entry height delta, modified size,
 * and chain value.
 * @param {Number} height
 * @returns {BN} Priority.
 */

MempoolEntry.prototype.getPriority = function getPriority(height) {
  var heightDelta = Math.max(0, height - this.height);
  var modSize = this.tx.getModifiedSize(this.size);
  var deltaPriority = new bn(heightDelta).mul(this.chainValue).divn(modSize);
  var result = this.priority.add(deltaPriority);
  if (result.cmpn(0) < 0)
    result = new bn(0);
  return result;
};

/**
 * Test whether the entry is free with
 * the current priority (calculated by
 * current height).
 * @param {Number} height
 * @returns {Boolean}
 */

MempoolEntry.prototype.isFree = function isFree(height) {
  var priority = this.getPriority(height);
  return priority.cmp(constants.tx.FREE_THRESHOLD) > 0;
};

/*
 * Helpers
 */

/**
 * "Guessed" pointer size based on ISA. This
 * assumes 64 bit for arm since the arm
 * version number is not exposed by node.js.
 * @const {Number}
 */

var ptrSize = (process.platform == null
  || process.platform === 'x64'
  || process.platform === 'ia64'
  || process.platform === 'arm') ? 8 : 4;

/**
 * Calculate malloc usage based on pointer size.
 * If you're scratching your head as to why this
 * function is here, it is only here to accurately
 * replicate bitcoind's memory usage algorithm.
 * (I know javascript doesn't have malloc or
 * pointers).
 * @param {Number} alloc - Size of Buffer object.
 * @returns {Number} Allocated size.
 */

function mallocUsage(alloc) {
  if (alloc === 0)
    return 0;
  if (ptrSize === 8)
    return ((alloc + 31) >>> 4) << 4;
  return ((alloc + 15) >>> 3) << 3;
}

Mempool.MempoolEntry = MempoolEntry;

module.exports = Mempool;
