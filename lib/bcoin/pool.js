/**
 * pool.js - peer management for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * https://github.com/indutny/bcoin
 */

var async = require('async');
var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;

var bcoin = require('../bcoin');
var utils = bcoin.utils;
var assert = utils.assert;
var network = bcoin.protocol.network;
var constants = bcoin.protocol.constants;

/**
 * Pool
 */

function Pool(options) {
  var self = this;
  var Chain;

  if (!(this instanceof Pool))
    return new Pool(options);

  EventEmitter.call(this);

  if (!options)
    options = {};

  this.options = options;

  if (this.options.debug)
    bcoin.debug = this.options.debug;

  if (this.options.network)
    network.set(this.options.network);

  this.options.ignoreAddr = !!this.options.ignoreAddr;
  this.options.fullNode = !!this.options.fullNode;

  if (options.type === 'spv')
    this.options.fullNode = false;
  else if (options.type === 'full')
    this.options.fullNode = true;

  this.options.headers = this.options.headers;
  this.options.multiplePeers = this.options.multiplePeers;
  this.options.relay = this.options.relay == null
    ? (this.options.fullNode ? true : false)
    : this.options.relay;

  this.originalSeeds = (options.seeds || network.seeds).map(utils.parseHost);
  this.setSeeds([]);

  this.destroyed = false;
  this.size = options.size || 32;

  this._createSocket = options.createSocket;

  if (!this.options.fullNode) {
    if (this.options.headers == null)
      this.options.headers = true;
    if (this.options.multiplePeers == null)
      this.options.multiplePeers = true;
  } else {
    if (this.options.headers == null)
      this.options.headers = false;
    if (this.options.multiplePeers == null)
      this.options.multiplePeers = false;
  }

  if (!this.options.headers)
    this.options.multiplePeers = false;

  this.syncing = false;
  this.synced = false;

  this.load = {
    timeout: options.loadTimeout || 30000,
    interval: options.loadInterval || 5000
  };

  this.requestTimeout = options.requestTimeout || 600000;

  this.chain = new bcoin.chain({
    fullNode: this.options.fullNode,
    multiplePeers: this.options.multiplePeers
  });

  this.watchMap = {};

  this.bloom = new bcoin.bloom(
    8 * 1024,
    10,
    (Math.random() * 0xffffffff) | 0
  );

  this.peers = {
    // Peers that are loading blocks themselves
    block: [],
    // Peers that are still connecting
    pending: [],
    // Peers that are loading block ids
    load: null,
    // All peers
    all: [],
    // Misbehaving hosts
    misbehaving: {}
  };

  this.block = {
    bestHeight: 0,
    bestHash: null,
    type: this.options.fullNode ? 'block' : 'filtered',
    invalid: {}
  };

  this.tx = {
    state: {},
    count: 0
  };

  this.request = {
    map: {},
    active: 0,
    queue: []
  };

  this.validate = {
    // 5 days scan delta for obtaining TXs
    delta: 5 * 24 * 3600,

    // Minimum verification depth
    minDepth: options.minValidateDepth || 0,

    // getTX map
    map: {}
  };

  // Currently broadcasted objects
  this.inv = {
    list: [],
    timeout: options.invTimeout || 60000
  };

  // Added and watched wallets
  this.options.wallets = this.options.wallets || [];
  this.wallets = [];

  Pool.global = this;

  this.loading = true;

  this.chain.once('load', function() {
    self.loading = false;
    self.emit('load');
    self._init();
  });
}

inherits(Pool, EventEmitter);

Pool.prototype._init = function _init() {
  var self = this;
  var i;

  if (this.originalSeeds.length > 0) {
    this._addLoader();

    for (i = 0; i < this.size; i++)
      this._addPeer();
  }

  this.chain.on('block', function(block, peer) {
    self.emit('block', block, peer);
  });

  this.chain.on('fork', function(data, peer) {
    utils.debug(
      'Fork at height %d: expected=%s received=%s checkpoint=%s peer=%s',
      data.height,
      utils.revHex(data.expected),
      utils.revHex(data.received),
      data.checkpoint,
      peer ? peer.host : ''
    );

    self.emit('fork', [data.expected, data.received]);

    if (!peer)
      return;

    // If we failed a checkpoint, peer is misbehaving.
    if (data.checkpoint) {
      self.misbehaving(peer, 100);
      return;
    }

    // Only destroy peer here. Wait for higher chain.
    peer.destroy();
  });

  this.chain.on('invalid', function(data, peer) {
    utils.debug(
      'Invalid block at height %d: hash=%s peer=%s',
      data.height,
      utils.revHex(data.hash),
      peer ? peer.host : ''
    );

    self.block.invalid[data.hash] = true;

    if (!peer)
      return;

    self.misbehaving(peer, 100);
  });

  this.options.wallets.forEach(function(w) {
    self.addWallet(w);
  });

  // Chain is full and up-to-date
  if (this.chain.isFull()) {
    this.synced = true;
    this.emit('full');
    utils.debug('Chain is fully synced (height=%d).', this.chain.height());
  }
};

Pool.prototype._startTimer = function _startTimer() {
  var self = this;

  this._stopTimer();

  function destroy() {
    if (!self.syncing)
      return;

    // Chain is full and up-to-date
    if (self.chain.isFull()) {
      self._stopTimer();
      self._stopInterval();
      self.synced = true;
      self.emit('full');
      utils.debug('Chain is fully synced (height=%d).', self.chain.height());
      return;
    }

    if (self.peers.load) {
      self.peers.load.destroy();
      utils.debug('Timer ran out. Finding new loader peer.');
    }
  }

  this._timer = setTimeout(destroy, this.load.timeout);
};

Pool.prototype._stopTimer = function _stopTimer() {
  if (!this._timer)
    return;

  clearTimeout(this._timer);
  delete this._timer;
};

Pool.prototype._startInterval = function _startInterval() {
  var self = this;

  this._stopInterval();

  function load() {
    if (!self.syncing)
      return;
    utils.debug('Stall recovery: loading again.');
    // self._load();
  }

  this._interval = setInterval(load, this.load.interval);
};

Pool.prototype._stopInterval = function _stopInterval() {
  if (!this._interval)
    return;

  clearInterval(this._interval);
  delete this._interval;
};

Pool.prototype.createConnection = function createConnection(peer, options) {
  var addr, net, socket;

  addr = this.getSeed(options.priority, true);

  assert(addr);
  assert(addr.host);

  peer.host = addr.host;
  peer.port = addr.port;

  if (this._createSocket) {
    socket = this._createSocket(addr.port, addr.host);
  } else {
    net = require('net');
    socket = net.connect(addr.port, addr.host);
  }

  utils.debug(
    'Connecting to %s:%d (priority=%s)',
    addr.host, addr.port, options.priority);

  socket.on('connect', function() {
    utils.debug(
      'Connected to %s:%d (priority=%s)',
      addr.host, addr.port, options.priority);
  });

  return socket;
};

Pool.prototype._addLoader = function _addLoader() {
  var self = this;
  var peer;

  if (this.destroyed)
    return;

  if (this.peers.load != null)
    return;

  peer = this._createPeer(true);

  utils.debug('Added loader peer: %s', peer.host);

  this.peers.load = peer;
  this.peers.all.push(peer);

  peer.once('close', function() {
    self._stopInterval();
    self._stopTimer();
    self._removePeer(peer);
    if (self.destroyed)
      return;
    self._addLoader();
  });

  peer.once('ack', function() {
    peer.updateWatch();
    if (!self.syncing)
      return;
    self._load();
  });

  peer.on('merkleblock', function(block) {
    if (!self.syncing)
      return;
    // If the peer sent us a block that was added
    // to the chain (not orphans), reset the timeout.
    if (self._handleBlock(block, peer)) {
      self._startInterval();
      self._startTimer();
    }
  });

  peer.on('block', function(block) {
    if (!self.syncing)
      return;
    // If the peer sent us a block that was added
    // to the chain (not orphans), reset the timeout.
    if (self._handleBlock(block, peer)) {
      self._startInterval();
      self._startTimer();
    }
  });

  if (self.options.headers) {
    peer.on('blocks', function(hashes) {
      if (!self.syncing)
        return;
      self._handleInv(hashes, peer);
    });

    peer.on('headers', function(headers) {
      if (!self.syncing)
        return;
      self._handleHeaders(headers, peer);
    });
  } else {
    peer.on('blocks', function(hashes) {
      if (!self.syncing)
        return;
      self._handleBlocks(hashes, peer);
    });
  }
};

Pool.prototype.startSync = function startSync() {
  if (this.loading)
    return this.once('load', this.startSync.bind(this));

  this.syncing = true;

  this._startInterval();
  this._startTimer();

  if (!this.peers.load) {
    this._addLoader();
    return;
  }

  if (this.peers.load.ack)
    this._load();
};

Pool.prototype.stopSync = function stopSync() {
  if (!this.syncing)
    return;

  this.syncing = false;

  if (this.loading)
    return;

  this._stopInterval();
  this._stopTimer();
};

Pool.prototype._handleHeaders = function _handleHeaders(headers, peer) {
  var i, header, last, block, blockPeer;

  assert(this.options.headers);

  if (headers.length === 0)
    return;

  utils.debug(
    'Recieved %s headers from %s',
    headers.length,
    peer.host);

  if (headers.length > 2000) {
    this.misbehaving(peer, 100);
    return;
  }

  this.emit('headers', headers, peer);

  for (i = 0; i < headers.length; i++) {
    block = bcoin.block(headers[i], 'header');
    blockPeer = peer;

    // if (this.options.multiplePeers) {
    //   if (this.peers.block.length) {
    //     blockPeer = this.peers.block[i % (this.peers.block.length + 1)];
    //     if (!blockPeer)
    //       blockPeer = this.peers.load;
    //   }
    // }

    if (last && block.prevBlock !== last.hash('hex'))
      break;

    if (!block.verify())
      break;

    if (!this.chain.has(block))
      this._request(blockPeer, this.block.type, block.hash('hex'));

    last = block;
  }

  // Restart the getheaders process
  // Technically `last` is not indexed yet so
  // the locator hashes will not be entirely
  // accurate. However, it shouldn't matter
  // that much since FindForkInGlobalIndex
  // simply tries to find the latest block in
  // the peer's chain.
  if (last && headers.length === 2000)
    peer.loadHeaders(this.chain.locatorHashes(last), null);

  // Reset interval to avoid calling getheaders unnecessarily
  this._startInterval();
};

Pool.prototype._handleBlocks = function _handleBlocks(hashes, peer) {
  var i, hash;

  assert(!this.options.headers);

  if (hashes.length === 0)
    return;

  utils.debug(
    'Recieved %s block hashes from %s',
    hashes.length,
    peer.host);

  if (hashes.length > 500) {
    this.misbehaving(peer, 100);
    return;
  }

  this.emit('blocks', hashes);

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];

    if (this.chain.hasOrphan(hash)) {
      // Make sure the peer doesn't send us
      // more than 200 orphans every 3 minutes.
      if (this.orphaning(peer)) {
        utils.debug('Peer is orphaning (%s)', peer.host);
        this.misbehaving(peer, 100);
        return;
      }

      // Resolve orphan chain.
      peer.loadBlocks(
        this.chain.locatorHashes(),
        this.chain.getOrphanRoot(hash)
      );
      continue;
    }

    // Request block if we don't have it or if
    // this is the last hash: this is done as
    // a failsafe because we _need_ to request
    // the hashContinue no matter what.
    if (!this.chain.has(hash) || i === hashes.length - 1) {
      this._request(peer, this.block.type, hash);
      continue;
    }
  }

  // Reset interval to avoid calling getblocks unnecessarily
  this._startInterval();

  // Reset timeout to avoid killing the loader
  this._startTimer();
};

Pool.prototype._handleInv = function _handleInv(hashes, peer) {
  var i, hash;

  // Ignore for now if we're still syncing
  if (!this.chain.isFull())
    return;

  for (i = 0; i < hashes.length; i++) {
    hash = utils.toHex(hashes[i]);
    if (!this.chain.has(hash)) {
      if (this.options.headers)
        this.peers.load.loadHeaders(this.chain.locatorHashes(), hash);
      else
        this._request(peer, this.block.type, hash);
    }
  }
};

Pool.prototype._handleBlock = function _handleBlock(block, peer) {
  var self = this;
  var requested;

  // Fulfill our request.
  requested = this._response(block);

  // Emulate BIP37: emit all the filtered transactions.
  if (this.options.fullNode && this.listeners('watched').length > 0) {
    block.txs.forEach(function(tx) {
      if (self.isWatched(tx))
        self.emit('watched', tx, peer);
    });
  }

  // Ensure the block was not invalid last time.
  // Someone might be sending us bad blocks to DoS us.
  if (this.block.invalid[block.hash('hex')]) {
    utils.debug('Peer is sending an invalid chain (%s)', peer.host);
    this.misbehaving(peer, 100);
    return false;
  }

  // Ensure this is not a continuation
  // of an invalid chain.
  if (this.block.invalid[block.prevBlock]) {
    utils.debug(
      'Peer is sending an invalid continuation chain (%s)',
      peer.host);
    this.misbehaving(peer, 100);
    return false;
  }

  // Ignore if we already have.
  if (this.chain.has(block)) {
    utils.debug('Already have block %s (%s)', block.height, peer.host);
    this.misbehaving(peer, 1);
    return false;
  }

  // Make sure the block is valid.
  if (!block.verify()) {
    utils.debug(
      'Block verification failed for %s (%s)',
      block.rhash, peer.host);
    this.block.invalid[block.hash('hex')] = true;
    this.misbehaving(peer, 100);
    return false;
  }

  // Someone is sending us blocks without
  // us requesting them.
  if (!requested) {
    utils.debug(
      'Recieved unrequested block: %s (%s)',
      block.rhash, peer.host);
  }

  // Resolve orphan chain
  if (!this.options.headers) {
    if (!this.chain.hasBlock(block.prevBlock)) {
      // Special case for genesis block.
      if (block.isGenesis())
        return false;

      // Make sure the peer doesn't send us
      // more than 200 orphans every 3 minutes.
      if (this.orphaning(peer)) {
        utils.debug('Peer is orphaning (%s)', peer.host);
        this.misbehaving(peer, 100);
        return false;
      }

      // NOTE: If we were to emit new orphans here, we
      // would not need to store full blocks as orphans.
      // However, the listener would not be able to see
      // the height until later.
      if (this._addIndex(block, peer))
        this.emit('pool block', block, peer);

      // Resolve orphan chain.
      this.peers.load.loadBlocks(
        this.chain.locatorHashes(),
        this.chain.getOrphanRoot(block)
      );

      utils.debug('Handled orphan %s (%s)', block.rhash, peer.host);

      return false;
    }
  } else {
    if (!this.chain.hasBlock(block.prevBlock)) {
      // Special case for genesis block.
      if (block.isGenesis())
        return false;

      // Increase banscore by 10 if we're using getheaders.
      if (!this.options.multiplePeers) {
        if (this.misbehaving(peer, 10))
          return false;
      }
    }
  }

  // Add to index and emit/save
  if (this._addIndex(block, peer)) {
    this.emit('pool block', block, peer);
    return true;
  }
};

Pool.prototype._addIndex = function _addIndex(block, peer) {
  var added = this.chain.add(block, peer);

  if (added === 0)
    return false;

  this.emit('chain-progress', this.chain.fillPercent(), peer);

  return true;
};

Pool.prototype.isFull = function isFull() {
  return this.chain.isFull();
};

Pool.prototype._load = function _load() {
  var self = this;
  var next;

  if (!this.syncing)
    return;

  if (!this.peers.load) {
    this._addLoader();
    return;
  }

  if (this.options.headers)
    this.peers.load.loadHeaders(this.chain.locatorHashes(), null);
  else
    this.peers.load.loadBlocks(this.chain.locatorHashes(), null);
};

Pool.prototype.loadMempool = function loadMempool() {
  this.peers.block.forEach(function(peer) {
    peer.loadMempool();
  });
};

Pool.prototype._createPeer = function _createPeer(priority) {
  var self = this;

  var peer = new bcoin.peer(this, this.createConnection, {
    startHeight: this.options.startHeight,
    relay: this.options.relay,
    priority: priority
  });

  peer._retry = 0;

  peer.on('error', function(err) {
    self.emit('error', err, peer);
  });

  peer.on('reject', function(payload) {
    var data = utils.revHex(utils.toHex(payload.data));

    utils.debug(
      'Reject: msg=%s ccode=%s reason=%s data=%s',
      payload.message,
      payload.ccode,
      payload.reason,
      data);

    self.emit('reject', payload, peer);
  });

  peer.on('notfound', function(items) {
    items.forEach(function(item) {
      var req = self.request.map[utils.toHex(item.hash)];
      if (req && req.peer === peer)
        item.finish();
    });
  });

  peer.on('tx', function(tx) {
    var state = self.tx.state[tx.hash('hex')];

    self._response(tx);
    self._addTX(tx, 1);

    if (state !== 1 || tx.block)
      self.emit('tx', tx, peer);

    if (!self.options.fullNode && tx.block)
      self.emit('watched', tx, peer);
  });

  peer.on('addr', function(data) {
    if(self.options.ignoreAddr) {
      utils.debug('Ignoring addr');
    } else {
      if (self.seeds.length > 1000)
        self.setSeeds(self.seeds.slice(-500));

    self.addSeed(data);

      self.addSeed(data);
    }
    self.emit('addr', data, peer);
  });

  peer.on('txs', function(txs) {
    self.emit('txs', txs, peer);
    txs.forEach(function(hash) {
      hash = utils.toHex(hash);
      if (self._addTX(hash, 0))
        self._request(peer, 'tx', hash);
    });
  });

  peer.on('version', function(version) {
    if (version.height > self.block.bestHeight)
      self.block.bestHeight = version.height;
    self.emit('version', version, peer);
    utils.debug(
      'Received version from %s: version=%d height=%d agent=%s',
      peer.host, version.v, version.height, version.agent);
  });

  return peer;
};

Pool.prototype._addPeer = function _addPeer() {
  var self = this;
  var peer;

  if (this.destroyed)
    return;

  if (this.peers.block.length + this.peers.pending.length >= this.size)
    return;

  if (!this.getSeed()) {
    setTimeout(this._addPeer.bind(this), 5000);
    return;
  }

  peer = this._createPeer(false);

  this.peers.pending.push(peer);
  this.peers.all.push(peer);

  peer.once('close', function() {
    self._removePeer(peer);
    if (self.destroyed)
      return;
    self._addPeer();
  });

  peer.once('ack', function() {
    var i;

    if (self.destroyed)
      return;

    i = self.peers.pending.indexOf(peer);
    if (i !== -1) {
      self.peers.pending.splice(i, 1);
      self.peers.block.push(peer);
    }

    peer.updateWatch();

    self.inv.list.forEach(function(entry) {
      var result = peer.broadcast(entry.msg);
      if (!result)
        return;

      result[0].once('request', function() {
        entry.e.emit('ack', peer);
      });

      result[0].once('reject', function(payload) {
        entry.e.emit('reject', payload, peer);
      });
    });
  });

  peer.on('merkleblock', function(block) {
    self._handleBlock(block, peer);
  });

  peer.on('block', function(block) {
    self._handleBlock(block, peer);
  });

  peer.on('blocks', function(hashes) {
    self._handleInv(hashes, peer);
  });

  utils.nextTick(function() {
    self.emit('peer', peer);
  });
};

Pool.prototype._addTX = function(hash, state) {
  if (utils.isBuffer(hash))
    hash = utils.toHex(hash);
  else if (hash.hash)
    hash = hash.hash('hex');

  if (this.tx.count >= 5000) {
    this.tx.state = {};
    this.tx.count = 0;
  }

  if (this.tx.state[hash] == null) {
    this.tx.state[hash] = state;
    this.tx.count++;
    return true;
  }

  if (this.tx.state[hash] < state) {
    this.tx.state[hash] = state;
    return true;
  }

  return false;
};

Pool.prototype.bestPeer = function bestPeer() {
  return this.peers.block.reduce(function(best, peer) {
    if (!peer.version || !peer.socket)
      return;

    if (!best || peer.version.height > best.version.height)
      return peer;

    return best;
  }, null);
};

Pool.prototype._removePeer = function _removePeer(peer) {
  var i = this.peers.pending.indexOf(peer);
  if (i !== -1)
    this.peers.pending.splice(i, 1);

  i = this.peers.block.indexOf(peer);
  if (i !== -1)
    this.peers.block.splice(i, 1);

  i = this.peers.all.indexOf(peer);
  if (i !== -1)
    this.peers.all.splice(i, 1);

  if (this.peers.load === peer) {
    utils.debug('Removed loader peer (%s).', peer.host);
    this.peers.load = null;
  }
};

Pool.prototype.watch = function watch(id) {
  var hid, i;

  if (id instanceof bcoin.wallet) {
    this.watchWallet(id);
    return;
  }

  if (id) {
    hid = utils.toHex(id);
    if (this.watchMap[hid])
      this.watchMap[hid]++;
    else
      this.watchMap[hid] = 1;

    if (this.bloom.test(id, 'hex'))
      return;

    this.bloom.add(id, 'hex');
  }

  if (this.peers.load)
    this.peers.load.updateWatch();

  for (i = 0; i < this.peers.block.length; i++)
    this.peers.block[i].updateWatch();
};

Pool.prototype.unwatch = function unwatch(id) {
  var i;

  id = utils.toHex(id);

  if (!this.bloom.test(id, 'hex'))
    return;

  if (!this.watchMap[id] || --this.watchMap[id] !== 0)
    return;

  delete this.watchMap[id];

  // Reset bloom filter
  this.bloom.reset();
  Object.keys(this.watchMap).forEach(function(id) {
    this.bloom.add(id, 'hex');
  }, this);

  // Resend it to peers
  if (this.peers.load)
    this.peers.load.updateWatch();

  for (i = 0; i < this.peers.block.length; i++)
    this.peers.block[i].updateWatch();
};

// See "Filter matching algorithm":
// https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki
Pool.prototype.isWatched = function(tx, bloom) {
  var i, input, output, prev;

  if (!bloom)
    bloom = this.bloom;

  function testScript(script) {
    return script.some(function(chunk) {
      if (!Array.isArray(chunk) || chunk.length === 0)
        return false;
      return bloom.test(chunk);
    });
  }

  // 1. Test the tx hash
  if (bloom.test(tx.hash()))
    return true;

  // 2. Test data elements in output scripts
  //    (may need to update filter on match)
  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    // Test the output script
    if (testScript(output.script))
      return true;
  }

  // 3. Test prev_out structure
  // 4. Test data elements in input scripts
  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    prev = input.out.hash;

    if (typeof prev === 'string')
      prev = utils.toArray(prev, 'hex');

    // Test the prev_out tx hash
    if (bloom.test(prev))
      return true;

    // Test the prev_out script
    if (input.out.tx) {
      prev = input.out.tx.outputs[input.out.index];
      if (testScript(prev.script))
        return true;
    }

    // Test the input script
    if (testScript(input.script))
      return true;
  }

  // 5. No match
  return false;
};

Pool.prototype.addWallet = function addWallet(w, defaultTs) {
  var self = this;
  var e;

  if (this.loading)
    return this.once('load', this.addWallet.bind(this, w, defaultTs));

  if (this.wallets.indexOf(w) !== -1)
    return false;

  this.watchWallet(w);
  this.wallets.push(w);

  e = new EventEmitter();

  function search(ts) {
    // Relay pending TXs
    // NOTE: It is important to do it after search, because search could
    // add TS to pending TXs, thus making them confirmed
    w.pending().forEach(function(tx) {
      self.sendTX(tx);
    });

    if (self.options.fullNode)
      return;

    // Search for last week by default
    if (!ts)
      ts = defaultTs || (utils.now() - 7 * 24 * 3600);

    // self.search(false, ts, e);
    self.searchWallet(ts);
  }

  if (w.loaded)
    search(w.lastTs);
  else
    w.once('load', function() { search(w.lastTs) });

  return e;
};

Pool.prototype.removeWallet = function removeWallet(w) {
  var i = this.wallets.indexOf(w);
  assert(!this.loading);
  if (i == -1)
    return;
  this.wallets.splice(i, 1);
  this.unwatchWallet(w);
};

Pool.prototype.watchWallet = function watchWallet(w) {
  if (w.type === 'scripthash') {
    // For the redeem script hash in outputs:
    this.watch(w.getScriptHash());
    // For the redeem script in inputs:
    this.watch(w.getScript());
  }

  // For the pubkey hash in outputs:
  this.watch(w.getKeyHash());
  // For the pubkey in inputs:
  this.watch(w.getPublicKey());
};

Pool.prototype.unwatchWallet = function unwatchWallet(w) {
  if (w.type === 'scripthash') {
    // For the redeem script hash in p2sh outputs:
    this.unwatch(w.getScriptHash());
    // For the redeem script in p2sh inputs:
    this.unwatch(w.getScript());
  }

  // For the pubkey hash in p2pk/multisig outputs:
  this.unwatch(w.getKeyHash());
  // For the pubkey in p2pkh inputs:
  this.unwatch(w.getPublicKey());
};

Pool.prototype.searchWallet = function(w) {
  var self = this;
  var ts;

  assert(!this.loading);

  if (this.options.fullNode)
    return;

  if (!w) {
    ts = this.wallets.reduce(function(ts, w) {
      if (w.lastTs < ts)
        return w.lastTs;
      return ts;
    }, Infinity);
    assert(ts !== Infinity);
  } else if (typeof w === 'number') {
    ts = w;
  } else {
    if (!w.loaded) {
      w.once('load', function() {
        self.searchWallet(w);
      });
      return;
    }
    ts = w.lastTs;
    if (!ts)
      ts = utils.now() - 7 * 24 * 3600;
  }

  utils.nextTick(function() {
    utils.debug('Wallet time: %s', new Date(ts * 1000));
    utils.debug(
      'Reverted chain to height=%d (%s)',
      self.chain.height(),
      new Date(self.chain.getTip().ts * 1000)
    );
  });

  this.chain.resetTime(ts);
};

Pool.prototype.search = function search(id, range, e) {
  var self = this;
  var hashes, pending, listener, timeout, done, total, cb;

  assert(!this.loading);

  if (this.options.fullNode)
    return;

  if (typeof e === 'function') {
    cb = e;
    e = null;
  }

  e = e || new EventEmitter();

  // Optional id argument
  if ((id !== null
      && typeof id === 'object'
      && !utils.isBuffer(id))
      || typeof id === 'number') {
    range = id;
    id = null;
  }

  if (typeof id === 'string')
    id = utils.toArray(id, 'hex');

  if (typeof range === 'number')
    range = { start: range, end: null };
  else if (range)
    range = { start: range.start, end: range.end };
  else
    range = { start: 0, end: 0 };

  // Last 5 days by default, this covers 1000 blocks that we have in the
  // chain by default
  if (!range.end)
    range.end = utils.now();

  if (!range.start)
    range.start = utils.now() - 432000;

  if (cb) {
    e.once('end', function(empty) {
      if (empty)
        return cb(new Error('Not found.'), false);
      return cb(null, true);
    });
  }

  if (id)
    this.watch(id);

  done = function(empty) {
    e.emit('end', empty);
    clearInterval(timeout);
    self.removeListener('block', listener);
    if (id)
      self.unwatch(id);
  };

  this.on('block', listener = function(block) {
    if (block.ts >= range.end)
      done();
  });

  // Estimated number of blocks in time range
  total = (range.end - range.start) / network.powTargetSpacing | 0;

  if (total === 0)
    total = 1;

  // 500 blocks every 3 seconds
  total = (total / 500 | 0) * 3;

  // Add half the total time and convert to ms
  total = (total + Math.ceil(total / 2)) * 1000;

  timeout = setTimeout(done.bind(null, true), total);
  if (range.start < this.chain.getTip().ts) {

    this.chain.resetTime(range.start);
    this.stopSync();
    this.startSync();
  }

  return e;
};

Pool.prototype._request = function _request(peer, type, hash, options, cb) {
  var self = this;
  var item;

  if (typeof options === 'function') {
    cb = options;
    options = {};
  }

  if (this.destroyed)
    return;

  if (!options)
    options = {};

  if (utils.isBuffer(hash))
    hash = utils.toHex(hash);

  if (this.request.map[hash]) {
    if (cb)
      this.request.map[hash].cb.push(cb);
    return;
  }

  // Block should be not in chain, or be requested
  // Do not use with headers-first
  if (!options.force && (type === 'block' || type === 'filtered')) {
    if (this.chain.has(hash))
      return;
  }

  item = new LoadRequest(this, peer, type, hash, cb);

  if (peer._queue.length === 0) {
    utils.nextTick(function() {
      utils.debug(
        'Requesting %d/%d items from %s with getdata',
        peer._queue.length,
        self.request.active,
        peer.host);

      peer.getData(peer._queue);
      peer._queue.length = 0;
    });
  }

  peer._queue.push({
    type: type,
    hash: hash
  });
};

Pool.prototype._response = function _response(hash) {
  var hash;

  if (utils.isBuffer(hash))
    hash = utils.toHex(hash);
  else if (hash.hash)
    hash = hash.hash('hex');

  item = this.request.map[hash];
  if (!item)
    return false;

  item.finish();

  item.cb.forEach(function(cb) {
    cb();
  });

  return true;
};

Pool.prototype.getBlock = function getBlock(hash, cb) {
  if (!this.peers.load)
    return setTimeout(this.getBlock.bind(this, hash, cb), 1000);

  this._request(this.peers.load, 'block', hash, { force: true }, function(block) {
    cb(null, block);
  });
};

Pool.prototype.sendBlock = function sendBlock(block) {
  return this.broadcast(block);
};

Pool.prototype.getTX = function getTX(hash, range, cb) {
  var self = this;
  var cbs, tx, finished, req, delta;

  if (!this.peers.load)
    return setTimeout(this.getBlock.bind(this, hash, cb), 1000);

  if (this.options.fullNode)
    return cb(new Error('Cannot get tx with full node'));

  hash = utils.toHex(hash);

  if (typeof range === 'function') {
    cb = range;
    range = null;
  }

  // Do not perform duplicate searches
  if (this.validate.map[hash])
    return this.validate.map[hash].push(cb);

  cbs = [cb];
  this.validate.map[hash] = cbs;

  // Add request without queueing it to get notification at the time of load
  tx = null;
  finished = false;
  req = this._request(this.peers.load, 'tx', hash, { noQueue: true }, function(t) {
    finished = true;
    tx = t;
  });

  // Do incremental search until the TX is found
  delta = this.validate.delta;

  // Start from the existing range if given
  if (range)
    range = { start: range.start, end: range.end };
  else
    range = { start: utils.now() - delta, end: 0 };

  function doSearch() {
    var e = self.search(hash, range);
    e.on('end', function(empty) {
      if (finished) {
        delete self.validate.map[hash];
        cbs.forEach(function(cb) {
          cb(null, tx, range);
        });
        return;
      }

      // Tried everything, but still no matches
      if (empty)
        return cb(new Error('Not found.'));

      // Not found yet, continue scanning
      range.end = range.start;
      range.start -= delta;
      if (range.start < 0)
        range.start = 0;

      doSearch();
    });
  }

  doSearch();
};

Pool.prototype.sendTX = function sendTX(tx) {
  // This is to avoid getting banned by
  // bitcoind nodes. Possibly check
  // sigops. Call isStandard and/or
  // isStandardInputs as well.
  if (tx.isFull()) {
    if (!tx.verify(null, true)) {
      utils.debug(
        'Could not relay TX (%s). It does not verify.',
        tx.rhash);
      return;
    }
  }
  return this.broadcast(tx);
};

Pool.prototype.broadcast = function broadcast(msg) {
  var self = this;
  var e = new EventEmitter();

  var entry = {
    msg: msg,
    e: e,
    timer: setTimeout(function() {
      var i = self.inv.list.indexOf(entry);
      if (i !== -1)
        self.inv.list.splice(i, 1);
    }, this.inv.timeout)
  };

  this.inv.list.push(entry);

  this.peers.block.forEach(function(peer) {
    var result = peer.broadcast(msg);
    if (!result) return;
    result[0].once('request', function() {
      e.emit('ack', peer);
    });
  });

  return e;
};

Pool.prototype.destroy = function destroy() {
  if (this.destroyed)
    return;

  this.destroyed = true;

  if (this.peers.load)
    this.peers.load.destroy();

  this.request.queue.slice().forEach(function(item) {
    item.finish();
  });

  this.inv.list.forEach(function(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
  });

  this.peers.pending.slice().forEach(function(peer) {
    peer.destroy();
  });

  this.peers.block.slice().forEach(function(peer) {
    peer.destroy();
  });
};

Pool.prototype.getPeer = function getPeer(addr) {
  var i, peer;

  if (!addr)
    return;

  addr = utils.parseHost(addr);

  for (i = 0; i < this.peers.all.length; i++) {
    peer = this.peers.all[i];
    if (peer.host === addr.host)
      return peer;
  }
};

Pool.prototype.getSeed = function getSeed(priority, connecting) {
  var i, addr;
  var original = this.originalSeeds;
  var seeds = this.seeds;
  var all = original.concat(seeds);

  // Hang back if we don't have a loader peer yet.
  if (!connecting && !priority && !this.peers.load)
    return;

  // Randomize the non-original peers.
  seeds = seeds.slice().sort(function() {
    return Math.random() > 0.50 ? 1 : -1;
  });

  // Try to avoid connecting to a peer twice.
  // Try the original peers first.
  for (i = 0; i < original.length; i++) {
    addr = original[i];
    assert(addr.host);
    if (this.getPeer(addr))
      continue;
    if (this.isMisbehaving(addr.host))
      continue;
    return addr;
  }

  // If we are a priority socket, try to find a
  // peer this time with looser requirements.
  if (priority) {
    for (i = 0; i < original.length; i++) {
      addr = original[i];
      assert(addr.host);
      if (this.peers.load && this.getPeer(addr) === this.peers.load)
        continue;
      if (this.isMisbehaving(addr.host))
        continue;
      return addr;
    }
  }

  // Try the rest of the peers second.
  for (i = 0; i < seeds.length; i++) {
    addr = seeds[i];
    assert(addr.host);
    if (this.getPeer(addr))
      continue;
    if (this.isMisbehaving(addr.host))
      continue;
    return addr;
  }

  // If we are a priority socket, try to find a
  // peer this time with looser requirements.
  if (priority) {
    for (i = 0; i < seeds.length; i++) {
      addr = seeds[i];
      assert(addr.host);
      if (this.peers.load && this.getPeer(addr) === this.peers.load)
        continue;
      if (this.isMisbehaving(addr.host))
        continue;
      return addr;
    }
  }

  // If we have no block peers, always return
  // an address.
  if (!priority) {
    if (all.length === 1 || connecting)
      return all[Math.random() * (all.length - 1) | 0];
  }

  // This should never happen: priority sockets
  // should _always_ get an address.
  if (priority) {
    utils.debug(
      'We had to connect to a random peer. Something is not right.');

    return seeds[Math.random() * (seeds.length - 1) | 0] || original[0];
  }
};

Pool.prototype.setSeeds = function setSeeds(seeds) {
  this.seeds = [];
  this.hosts = {};

  // Remove all seeds from misbehaving aside
  // from original seeds that may be in it.
  // this.peers.misbehaving = this.originalSeeds.reduce(function(out, addr) {
  //   if (this.peers.misbehaving[addr.host])
  //     out[addr.host] = this.peers.misbehaving[addr.host];
  //   return out;
  // }, {}, this);

  seeds.forEach(function(seed) {
    this.addSeed(seed);
  }, this);
};

Pool.prototype.addSeed = function addSeed(seed) {
  seed = utils.parseHost(seed);

  if (this.hosts[seed.host] != null)
    return false;

  this.seeds.push({
    host: seed.host,
    port: seed.port
  });

  this.hosts[seed.host] = this.seeds.length - 1;

  return true;
};

Pool.prototype.removeSeed = function removeSeed(seed) {
  seed = utils.parseHost(seed);

  if (this.hosts[seed.host] == null)
    return false;

  this.seeds.splice(this.hosts[seed.host], 1);

  delete this.hosts[seed.host];

  return true;
};

Pool.prototype.orphaning = function orphaning(peer) {
  if (!peer._orphanTime)
    peer._orphanTime = utils.now();

  if (!peer._orphans)
    peer._orphans = 0;

  if (utils.now() > peer._orphanTime + 3 * 60) {
    peer._orphans = 0;
    peer._orphanTime = utils.now();
  }

  peer._orphans += 1;

  if (peer._orphans > 200)
    return true;

  return false;
};

Pool.prototype.misbehaving = function misbehaving(peer, dos) {
  if (!peer._banscore)
    peer._banscore = 0;

  peer._banscore += dos;

  if (peer._banscore >= constants.banScore) {
    this.peers.misbehaving[peer.host] = utils.now();
    utils.debug('Ban threshold exceeded for %s', peer.host);
    peer.destroy();
    return true;
  }

  return false;
};

Pool.prototype.isMisbehaving = function isMisbehaving(host) {
  var peer, time;

  if (host.host)
    host = host.host;

  time = this.peers.misbehaving[host];

  if (time) {
    if (utils.now() > time + constants.banTime) {
      delete this.peers.misbehaving[host];
      peer = this.getPeer(host);
      if (peer)
        peer._banscore = 0;
      return false;
    }
    return true;
  }

  return false;
};

/**
 * LoadRequest
 */

function LoadRequest(pool, peer, type, hash, cb) {
  this.pool = pool;
  this.peer = peer;
  this.type = type;
  this.hash = hash;
  this.cb = [];

  if (cb)
    this.cb.push(cb);

  this._finish = this.finish.bind(this);

  this.timeout = setTimeout(this._finish, this.pool.requestTimeout);
  this.peer.on('close', this._finish);

  this.pool.request.active++;

  assert(!this.pool.request.map[this.hash]);
  this.pool.request.map[this.hash] = this;
}
LoadRequest.prototype.finish = function finish() {

  var index;

  if (this.pool.request.map[this.hash]) {
    delete this.pool.request.map[this.hash];
    this.pool.request.active--;
  }

  index = this.peer._queue.indexOf(this);
  if (index !== -1)
    this.peer._queue.splice(index, 1);

  this.peer.removeListener('close', this._finish);

  if (this.timeout != null) {
    clearTimeout(this.timeout);
    delete this.timeout;
  }
};

/**
 * Expose
 */

module.exports = Pool;
