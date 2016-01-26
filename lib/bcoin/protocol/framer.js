/**
 * framer.js - packet framer for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * https://github.com/indutny/bcoin
 */

var bcoin = require('../../bcoin');
var network = require('./network');
var constants = require('./constants');
var utils = bcoin.utils;
var assert = utils.assert;

/**
 * Framer
 */

function Framer(options) {
  if (!(this instanceof Framer))
    return new Framer(options);

  options = options || {};

  this.options = options;

  this.agent = utils.toArray(options.userAgent || constants.userAgent);
  this.agent = this.agent.slice(0, 0xfc);
}

Framer.prototype.header = function header(cmd, payload) {
  var h = new Array(24);
  var len, i;

  assert(cmd.length < 12);
  assert(payload.length <= 0xffffffff);

  // Magic value
  utils.writeU32(h, network.magic, 0);

  // Command
  len = utils.writeAscii(h, cmd, 4);
  for (i = 4 + len; i < 4 + 12; i++)
    h[i] = 0;

  // Payload length
  utils.writeU32(h, payload.length, 16);

  // Checksum
  utils.copy(utils.checksum(payload), h, 20);

  return h;
};

Framer.prototype.packet = function packet(cmd, payload) {
  var h = this.header(cmd, payload);
  return h.concat(payload);
};

Framer.prototype._addr = function addr(p, off, data, full) {
  var start = off;

  if (!data)
    data = {};

  if (!data.ts)
    data.ts = utils.now() - ((typeof process !== 'undefined' && process.uptime()) | 0);

  if (!data.services)
    data.services = constants.services.network;

  if (!data.ipv4)
    data.ipv4 = [];

  if (!data.port)
    data.port = network.port;

  // timestamp
  if (full)
    off += utils.writeU32(p, data.ts, off);

  // NODE_NETWORK services
  off += utils.writeU64(p, data.services, off);

  // ipv6
  if (data.ipv6) {
    data.ipv6 = utils.ip2array(data.ipv6, 6);
    off += utils.writeU64BE(p, utils.readU64BE(data.ipv6, 0), off);
    off += utils.writeU64BE(p, utils.readU64BE(data.ipv6, 8), off);
  } else {
    data.ipv4 = utils.ip2array(data.ipv4, 4);
    // We don't have an ipv6, convert ipv4 to ipv4-mapped ipv6 address
    off += utils.writeU32BE(p, 0x00000000, off);
    off += utils.writeU32BE(p, 0x00000000, off);
    off += utils.writeU32BE(p, 0x0000ffff, off);
    off += utils.writeU32BE(p, utils.readU32BE(data.ipv4, 0), off);
  }

  // port
  off += utils.writeU16BE(p, data.port, off);

  return off - start;
};

Framer.prototype.version = function version(packet) {
  var p = new Array(86 + this.agent.length);
  var off = 0;
  var i;

  if (!packet)
    packet = {};

  // Version
  off += utils.writeU32(p, constants.version, off);

  // Services
  off += utils.writeU64(p, constants.services.network, off);

  // Timestamp
  off += utils.write64(p, utils.now(), off);

  // Their address (recv)
  off += this._addr(p, off, packet.remote || {});

  // Our address (from)
  off += this._addr(p, off, packet.local || {});

  // Nonce, very dramatic
  off += utils.writeU64(p, utils.nonce(), off);

  // User-agent
  assert.equal(off, 80);
  if (!this.agent) {
    p[off++] = 0;
  } else {
    off += utils.writeIntv(p, this.agent.length, off);
    for (i = 0; i < this.agent.length; i++)
      p[off++] = this.agent[i];
  }

  // Start height
  off += utils.writeU32(p, packet.height || 0, off);

  // Relay
  p[off++] = packet.relay ? 1 : 0;

  return this.packet('version', p);
};

Framer.prototype.verack = function verack() {
  return this.packet('verack', []);
};

Framer.prototype._inv = function _inv(command, items) {
  var res = [];
  var off, i, hash;

  assert(items.length <= 50000);

  off = utils.writeIntv(res, items.length, 0);

  for (i = 0; i < items.length; i++) {
    // Type
    off += utils.writeU32(res, constants.inv[items[i].type], off);

    // Hash
    hash = items[i].hash;
    if (typeof hash === 'string')
      hash = utils.toArray(hash, 'hex');
    assert.equal(hash.length, 32);
    res = res.concat(hash);

    off += hash.length;
  }

  return this.packet(command, res);
};

Framer.prototype.inv = function inv(items) {
  return this._inv('inv', items);
};

Framer.prototype.getData = function getData(items) {
  return this._inv('getdata', items);
};

Framer.prototype.notFound = function notFound(items) {
  return this._inv('notfound', items);
};

Framer.prototype.ping = function ping(data) {
  var p = [];
  utils.writeU64(p, data.nonce, 0);
  return this.packet('ping', p);
};

Framer.prototype.pong = function pong(data) {
  var p = [];
  utils.writeU64(p, data.nonce, 0);
  return this.packet('pong', p);
};

Framer.prototype.filterLoad = function filterLoad(bloom, update) {
  var filter = bloom.toArray();
  var before = [];
  var after = new Array(9);

  utils.writeIntv(before, filter.length, 0);

  // Number of hash functions
  utils.writeU32(after, bloom.n, 0);

  // nTweak
  utils.writeU32(after, bloom.tweak, 4);

  // nFlags
  after[8] = constants.filterFlags[update];

  return this.packet('filterload', before.concat(filter, after));
};

Framer.prototype.filterClear = function filterClear() {
  return this.packet('filterclear', []);
};

Framer.prototype.getHeaders = function getHeaders(hashes, stop) {
  return this._getBlocks('getheaders', hashes, stop);
};

Framer.prototype.getBlocks = function getBlocks(hashes, stop) {
  return this._getBlocks('getblocks', hashes, stop);
};

Framer.prototype._getBlocks = function _getBlocks(cmd, hashes, stop) {
  var p = [];
  var off, i, hash, len;

  // getheaders can have a null hash
  if (cmd === 'getheaders' && !hashes)
    hashes = [];

  utils.writeU32(p, constants.version, 0);
  off = 4 + utils.writeIntv(p, hashes.length, 4);
  p.length = off + 32 * (hashes.length + 1);

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];

    if (typeof hash === 'string')
      hash = utils.toArray(hash, 'hex');

    len = utils.copy(hash, p, off);

    for (; len < 32; len++)
      p[off + len] = 0;

    off += len;
  }

  if (stop) {
    stop = utils.toArray(stop, 'hex');
    len = utils.copy(stop, p, off);
  } else {
    len = 0;
  }

  for (; len < 32; len++)
    p[off + len] = 0;

  assert.equal(off + len, p.length);

  return this.packet(cmd, p);
};

Framer.tx = function tx(tx) {
  var p = [];
  var off, i, input, s, output, value, j;

  off = utils.write32(p, tx.version, 0);
  off += utils.writeIntv(p, tx.inputs.length, off);

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];

    off += utils.copy(utils.toArray(input.out.hash, 'hex'), p, off, true);
    off += utils.writeU32(p, input.out.index, off);

    s = bcoin.script.encode(input.script);
    off += utils.writeIntv(p, s.length, off);
    off += utils.copy(s, p, off, true);

    off += utils.writeU32(p, input.seq, off);
  }

  off += utils.writeIntv(p, tx.outputs.length, off);
  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];

    off += utils.write64(p, output.value, off);
    assert(output.value.byteLength() <= 8);

    s = bcoin.script.encode(output.script);
    off += utils.writeIntv(p, s.length, off);
    off += utils.copy(s, p, off, true);
  }
  off += utils.writeU32(p, tx.lock, off);

  return p;
};

Framer.prototype.tx = function tx(tx) {
  return this.packet('tx', Framer.tx(tx));
};

Framer.block = function _block(block, type) {
  var p = [];
  var off = 0;
  var i;

  if (!type)
    type = block.subtype;

  // version
  off += utils.write32(p, block.version, off);

  // prev_block
  off += utils.copy(utils.toArray(block.prevBlock, 'hex'), p, off, true);

  // merkle_root
  off += utils.copy(utils.toArray(block.merkleRoot, 'hex'), p, off, true);

  // timestamp
  off += utils.writeU32(p, block.ts, off);

  // bits
  off += utils.writeU32(p, block.bits, off);

  // nonce
  off += utils.writeU32(p, block.nonce, off);

  assert.equal(off, 80);

  if (type === 'merkleblock') {
    // txn_count
    off += utils.writeU32(p, block.totalTX, off);
    // hash count
    off += utils.writeIntv(p, block.hashes.length, off);
    // hashes
    for (i = 0; i < block.hashes.length; i++)
      off += utils.copy(utils.toArray(block.hashes[i], 'hex'), p, off, true);
    // flag count
    off += utils.writeIntv(p, block.flags.length, off);
    // flags
    for (i = 0; i < block.flags.length; i++)
      p[off++] = block.flags[i];
  } else if (type === 'header') {
    // txn_count
    off += utils.writeIntv(p, block.txs.length, off);
  } else {
    // txn_count
    off += utils.writeIntv(p, block.txs.length, off);
    // txs
    for (i = 0; i < block.txs.length; i++)
      off += utils.copy(block.txs[i].render(), p, off, true);
  }

  return p;
};

Framer.prototype.block = function _block(block) {
  return this.packet('block', Framer.block(block, 'block'));
};

Framer.prototype.merkleBlock = function merkleBlock(block) {
  return this.packet('merkleblock', Framer.block(block, 'merkleblock'));
};

Framer.prototype.reject = function reject(details) {
  var p = [];
  var off = 0;

  var message = details.message || '';
  var ccode = constants.reject[details.ccode] || constants.reject.malformed;
  var reason = details.reason || '';
  var data = details.data || [];

  off += utils.writeIntv(p, message.length, off);
  off += utils.writeAscii(p, message, off);

  off += utils.writeU8(p, ccode, off);

  off += utils.writeIntv(p, reason.length, off);
  off += utils.writeAscii(p, reason, off);

  off += utils.copy(data, p, off, true);

  return this.packet('reject', p);
};

Framer.prototype.addr = function addr(peers) {
  var p = [];
  var off = 0;
  var i, peer;

  off += utils.writeIntv(p, peers.length, off);

  for (i = 0; i < peers.length; i++) {
    peer = peers[i];

    off += this._addr(p, off, {
      ts: peer.ts,
      services: peer.services,
      ipv6: peer.ipv6,
      ipv4: peer.ipv4,
      port: peer.port
    }, true);
  }

  return this.packet('addr', p);
};

Framer.prototype.mempool = function mempool() {
  return this.packet('mempool', []);
};

/**
 * Expose
 */

module.exports = Framer;
