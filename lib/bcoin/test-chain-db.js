var bcoin = require('../bcoin');
var network = bcoin.protocol.network;
var utils = bcoin.utils;
var assert = utils.assert;
/**
 * TestChainDB
 */

function TestChainDB(chain, options) {
  if (!(this instanceof TestChainDB)) {
    return new TestChainDB(chain);
  }

  if (!options) {
    options = {};
  }

  this.options = options;
  this.chain = chain;

  this._queue = [];
  this._cache = {};
  this._bufferPool = {
    used: {}
  };
  this.tip = -1;
  this.size = 0;
  this.fd = null;

  // Need to cache up to the retarget interval
  // if we're going to be checking the damn
  // target all the time.
  if (network.powAllowMinDifficultyBlocks) {
    this._cacheWindow = network.powDiffInterval + 1;
  } else {
    this._cacheWindow = network.block.majorityWindow + 1;
  }

  this._init();
}

TestChainDB.prototype._init = function _init() {};



TestChainDB.prototype.getSize = function getSize() {
  try {
    return fs.statSync(this.file).size;
  } catch ( e ) {
    return 0;
  }
};

TestChainDB.prototype.count = function count() {
  return this._cache ? Object.keys(this._cache).length : 0;
};

TestChainDB.prototype.cache = function cache(entry) {
  if (entry.height > this.tip) {
    this.tip = entry.height;
    delete this._cache[entry.height - this._cacheWindow]
    ;
    this._cache[entry.height] = entry;
    assert(Object.keys(this._cache).length <= this._cacheWindow);
  }
};

TestChainDB.prototype.get = function get(height) {
  console.log('Getting block: ' + height);
  return this.getSync(height);
};

TestChainDB.prototype.getSync = function getSync(height) {
  var data;
  var entry;

  if (this._cache[height]) {
    return this._cache[height];
  }

  if (this._queue[height]) {
    return this._queue[height];
  }

  if (height < 0 || height == null) {
    return;
  }

  console.log('Block not found in cache');
};

TestChainDB.prototype.getAsync = function getAsync(height, callback) {
  var self = this;

  callback = utils.asyncify(callback);

  if (this._cache[height]) {
    return callback(null, this._cache[height]);
  }

  if (this._queue[height]) {
    return callback(null, this._queue[height]);
  }

  if (height < 0 || height == null) {
    return callback();
  }

  console.log('Block not found in cache');
  return callback();
};

TestChainDB.prototype.save = function save(entry) {
  return this.saveAsync(entry);
};

TestChainDB.prototype.saveSync = function saveSync(entry) {
  // Cache the past 1001 blocks in memory
  // (necessary for isSuperMajority)
  this.cache(entry);
  console.log('Entry saved');
  return true;
};

TestChainDB.prototype.saveAsync = function saveAsync(entry, callback) {
  var self = this;
  var raw;
  var offset;

  callback = utils.asyncify(callback);

  // Cache the past 1001 blocks in memory
  // (necessary for isSuperMajority)
  this.cache(entry);

  // Something is already writing. Cancel it
  // and synchronously write the data after
  // it cancels.
  if (this._queue[entry.height]) {
    this._queue[entry.height] = entry;
    return callback();
  }

  console.log('Entry saved');
  return callback(null, true);
};

TestChainDB.prototype.remove = function remove(height) {
  assert(height >= 0);

  // Potential race condition here. Not sure how
  // to handle this.
  if (this._queue[height]) {
    utils.debug('Warning: write job in progress.');
    delete this._queue[height]
    ;
  }
  console.log('Entry removed');
  delete this._cache[height]
  ;
  return true;
};

TestChainDB.prototype.has = function has(height) {
  if (this._queue[height] || this._cache[height]) {
    return true;
  }
  return false;
};

module.exports = TestChainDB;