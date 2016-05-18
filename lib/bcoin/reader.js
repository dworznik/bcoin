/*!
 * reader.js - buffer reader for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

var utils = require('./utils');
var assert = utils.assert;

/**
 * An object that allows reading of buffers in a sane manner.
 * @exports BufferReader
 * @constructor
 * @param {Buffer} data
 * @param {Boolean?} zeroCopy - Do not reallocate buffers when
 * slicing. Note that this can lead to memory leaks if not used
 * carefully.
 */

function BufferReader(data, zeroCopy) {
  if (data instanceof BufferReader)
    return data;

  if (!(this instanceof BufferReader))
    return new BufferReader(data, zeroCopy);

  this.data = data;
  this.offset = 0;
  this.zeroCopy = zeroCopy;
  this.stack = [];
}

/**
 * Mark the current starting position.
 */

BufferReader.prototype.start = function start() {
  this.stack.push(this.offset);
};

/**
 * Stop reading. Pop the start position off the stack
 * and calculate the size of the data read. This will
 * destroy the BufferReader if no positions are left
 * on the stack.
 * @returns {Number} Size.
 * @throws on empty stack.
 */

BufferReader.prototype.end = function end() {
  var start, end;

  assert(this.stack.length > 0);

  start = this.stack.pop();
  end = this.offset;

  if (this.stack.length === 0)
    this.destroy();

  return end - start;
};

/**
 * Stop reading. Pop the start position off the stack
 * and return the data read. This will
 * destroy the BufferReader if no positions are left
 * on the stack.
 * @returns {Buffer} Data read.
 * @throws on empty stack.
 */

BufferReader.prototype.endData = function endData() {
  var ret, start, end, size, data;

  assert(this.stack.length > 0);

  start = this.stack.pop();
  end = this.offset;
  size = end - start;
  data = this.data;

  if (this.stack.length === 0)
    this.destroy();

  if (size === data.length)
    return data;

  if (this.zeroCopy)
    return data.slice(start, end);

  ret = new Buffer(size);
  data.copy(ret, 0, start, end);

  return ret;
};

/**
 * Destroy the reader. Remove references to the data.
 */

BufferReader.prototype.destroy = function destroy() {
  delete this.offset;
  delete this.stack;
  delete this.data;
};

/**
 * Read uint8.
 * @returns {Number}
 */

BufferReader.prototype.readU8 = function readU8() {
  var ret;
  assert(this.offset + 1 <= this.data.length);
  ret = utils.readU8(this.data, this.offset);
  this.offset += 1;
  return ret;
};

/**
 * Read uint16le.
 * @returns {Number}
 */

BufferReader.prototype.readU16 = function readU16() {
  var ret;
  assert(this.offset + 2 <= this.data.length);
  ret = utils.readU16(this.data, this.offset);
  this.offset += 2;
  return ret;
};

/**
 * Read uint16be.
 * @returns {Number}
 */

BufferReader.prototype.readU16BE = function readU16BE() {
  var ret;
  assert(this.offset + 2 <= this.data.length);
  ret = utils.readU16BE(this.data, this.offset);
  this.offset += 2;
  return ret;
};

/**
 * Read uint32le.
 * @returns {Number}
 */

BufferReader.prototype.readU32 = function readU32() {
  var ret;
  assert(this.offset + 4 <= this.data.length);
  ret = utils.readU32(this.data, this.offset);
  this.offset += 4;
  return ret;
};

/**
 * Read uint32be.
 * @returns {Number}
 */

BufferReader.prototype.readU32BE = function readU32BE() {
  var ret;
  assert(this.offset + 4 <= this.data.length);
  ret = utils.readU32BE(this.data, this.offset);
  this.offset += 4;
  return ret;
};

/**
 * Read uint64le.
 * @returns {BN}
 */

BufferReader.prototype.readU64 = function readU64() {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.readU64(this.data, this.offset);
  this.offset += 8;
  return ret;
};

/**
 * Read uint64be.
 * @returns {BN}
 */

BufferReader.prototype.readU64BE = function readU64BE() {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.readU64BE(this.data, this.offset);
  this.offset += 8;
  return ret;
};

/**
 * Read uint64le as a js number.
 * @returns {Number}
 * @throws on num > MAX_SAFE_INTEGER
 */

BufferReader.prototype.readU64N = function readU64N(force53) {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.readU64N(this.data, this.offset, force53);
  this.offset += 8;
  return ret;
};

/**
 * Read uint64be as a js number.
 * @returns {Number}
 * @throws on num > MAX_SAFE_INTEGER
 */

BufferReader.prototype.readU64NBE = function readU64NBE(force53) {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.readU64NBE(this.data, this.offset, force53);
  this.offset += 8;
  return ret;
};

/**
 * Read first least significant 53 bits of
 * a uint64le as a js number. Maintain the sign.
 * @returns {Number}
 */

BufferReader.prototype.readU53 = function readU53() {
  return this.readU64N(true);
};

/**
 * Read first least significant 53 bits of
 * a uint64be as a js number. Maintain the sign.
 * @returns {Number}
 */

BufferReader.prototype.readU53BE = function readU53BE() {
  return this.readU64NBE(true);
};

/**
 * Read int8.
 * @returns {Number}
 */

BufferReader.prototype.read8 = function read8() {
  var ret;
  assert(this.offset + 1 <= this.data.length);
  ret = utils.read8(this.data, this.offset);
  this.offset += 1;
  return ret;
};

/**
 * Read int16le.
 * @returns {Number}
 */

BufferReader.prototype.read16 = function read16() {
  var ret;
  assert(this.offset + 2 <= this.data.length);
  ret = utils.read16(this.data, this.offset);
  this.offset += 2;
  return ret;
};

/**
 * Read int16be.
 * @returns {Number}
 */

BufferReader.prototype.read16BE = function read16BE() {
  var ret;
  assert(this.offset + 2 <= this.data.length);
  ret = utils.read16BE(this.data, this.offset);
  this.offset += 2;
  return ret;
};

/**
 * Read int32le.
 * @returns {Number}
 */

BufferReader.prototype.read32 = function read32() {
  var ret;
  assert(this.offset + 4 <= this.data.length);
  ret = utils.read32(this.data, this.offset);
  this.offset += 4;
  return ret;
};

/**
 * Read int32be.
 * @returns {Number}
 */

BufferReader.prototype.read32BE = function read32BE() {
  var ret;
  assert(this.offset + 4 <= this.data.length);
  ret = utils.read32BE(this.data, this.offset);
  this.offset += 4;
  return ret;
};

/**
 * Read int64le.
 * @returns {BN}
 */

BufferReader.prototype.read64 = function read64() {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.read64(this.data, this.offset);
  this.offset += 8;
  return ret;
};

/**
 * Read int64be.
 * @returns {BN}
 */

BufferReader.prototype.read64BE = function read64BE() {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.read64BE(this.data, this.offset);
  this.offset += 8;
  return ret;
};

/**
 * Read int64le as a js number.
 * @returns {Number}
 * @throws on num > MAX_SAFE_INTEGER
 */

BufferReader.prototype.read64N = function read64N(force53) {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.read64N(this.data, this.offset, force53);
  this.offset += 8;
  return ret;
};

/**
 * Read int64be as a js number.
 * @returns {Number}
 * @throws on num > MAX_SAFE_INTEGER
 */

BufferReader.prototype.read64NBE = function read64NBE(force53) {
  var ret;
  assert(this.offset + 8 <= this.data.length);
  ret = utils.read64NBE(this.data, this.offset, force53);
  this.offset += 8;
  return ret;
};

/**
 * Read first least significant 53 bits of
 * a int64le as a js number. Maintain the sign.
 * @returns {Number}
 */

BufferReader.prototype.read53 = function read53() {
  return this.read64N(true);
};

/**
 * Read first least significant 53 bits of
 * a int64be as a js number. Maintain the sign.
 * @returns {Number}
 */

BufferReader.prototype.read53BE = function read53BE() {
  return this.read64NBE(true);
};

/**
 * Read N bytes (will do a fast slice if zero copy).
 * @param {Number} size
 * @returns {Buffer}
 */

BufferReader.prototype.readBytes = function readBytes(size) {
  var ret;

  assert(size >= 0);
  assert(this.offset + size <= this.data.length);

  if (this.zeroCopy) {
    ret = this.data.slice(this.offset, this.offset + size);
  } else {
    ret = new Buffer(size);
    this.data.copy(ret, 0, this.offset, this.offset + size);
  }

  this.offset += size;

  return ret;
};

/**
 * Read a string.
 * @param {String} enc - Any buffer-supported encoding.
 * @param {Number} size
 * @returns {String}
 */

BufferReader.prototype.readString = function readString(enc, size) {
  var ret;
  assert(size >= 0);
  assert(this.offset + size <= this.data.length);
  ret = this.data.toString(enc, this.offset, this.offset + size);
  this.offset += size;
  return ret;
};

/**
 * Read a 32-byte hash.
 * @param {String} enc - `"hex"` or `null`.
 * @returns {Hash|Buffer}
 */

BufferReader.prototype.readHash = function readHash(enc) {
  if (enc)
    return this.readString(enc, 32);
  return this.readBytes(32);
};

/**
 * Read string of a varint length.
 * @param {String} enc - Any buffer-supported encoding.
 * @returns {String}
 */

BufferReader.prototype.readVarString = function readVarString(enc) {
  return this.readString(enc, this.readVarint());
};

/**
 * Read a varint number of bytes (will do a fast slice if zero copy).
 * @returns {Buffer}
 */

BufferReader.prototype.readVarBytes = function readVarBytes() {
  return this.readBytes(this.readVarint());
};

/**
 * Read a null-terminated string.
 * @param {String} enc - Any buffer-supported encoding.
 * @returns {String}
 */

BufferReader.prototype.readNullString = function readNullString(enc) {
  var i, ret;
  assert(this.offset + 1 <= this.data.length);
  for (i = this.offset; i < this.data.length; i++) {
    if (this.data[i] === 0)
      break;
  }
  assert(i !== this.data.length);
  ret = this.readString(enc, i - this.offset);
  this.offset = i + 1;
  return ret;
};

/**
 * Read a varint.
 * @param {Boolean?} big - Whether to read as a big number.
 * @returns {Number}
 */

BufferReader.prototype.readVarint = function readVarint(big) {
  var result;
  assert(this.offset + 1 <= this.data.length);
  result = utils.readVarint(this.data, this.offset, big);
  assert(result.off <= this.data.length);
  assert(result.r >= 0);
  this.offset = result.off;
  return result.r;
};

/**
 * Calculate number of bytes left to read.
 * @returns {Number}
 */

BufferReader.prototype.left = function left() {
  assert(this.offset <= this.data.length);
  return this.data.length - this.offset;
};

/**
 * Get total size of passed-in Buffer.
 * @returns {Buffer}
 */

BufferReader.prototype.getSize = function getSize() {
  return this.data.length;
};

/**
 * Seek to a position to read from by offset.
 * @param {Number} off - Offset (positive or negative).
 */

BufferReader.prototype.seek = function seek(off) {
  assert(this.offset + off >= 0);
  assert(this.offset + off <= this.data.length);
  this.offset += off;
  return off;
};

/**
 * Create a checksum from the last start position.
 * @returns {Number} Checksum.
 */

BufferReader.prototype.createChecksum = function createChecksum() {
  var start = this.stack[this.stack.length - 1] || 0;
  var data = this.data.slice(start, this.offset);
  return utils.readU32(utils.checksum(data), 0);
};

/**
 * Verify a 4-byte checksum against a calculated checksum.
 * @returns {Number} checksum
 * @throws on bad checksum
 */

BufferReader.prototype.verifyChecksum = function verifyChecksum() {
  var chk = this.createChecksum();
  var checksum = this.readU32();
  assert(chk === checksum, 'Checksum mismatch.');
  return checksum;
};

module.exports = BufferReader;
