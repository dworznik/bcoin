/*!
 * output.js - output object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

var bcoin = require('./env');
var bn = require('bn.js');
var utils = require('./utils');
var assert = utils.assert;
var BufferWriter = require('./writer');
var Framer = bcoin.protocol.framer;

/**
 * Represents a transaction output.
 * @exports Output
 * @constructor
 * @param {NakedOutput} options
 * @param {Boolean?} mutable
 * @property {BN} value - Value in satoshis.
 * @property {Script} script
 * @property {String} type - Script type.
 * @property {String?} address - Input address.
 * @property {Boolean} mutable
 */

function Output(options, mutable) {
  var value;

  if (!(this instanceof Output))
    return new Output(options);

  assert(options, 'Output data is required.');

  value = options.value;

  if (typeof value === 'number') {
    assert(value % 1 === 0, 'Output value cannot be a float.');
    value = new bn(value);
  }

  if (!value)
    value = new bn(0);

  this.mutable = !!mutable;
  this.value = value;
  this.script = bcoin.script(options.script, this.mutable);

  assert(bn.isBN(this.value));
  assert(!this.mutable || !this.value.isNeg());
}

/**
 * Get the script type.
 * @returns {String} type
 */

Output.prototype.getType = function getType() {
  var type;

  if (this._type)
    return this._type;

  type = this.script.getType();

  if (!this.mutable)
    this._type = type;

  return type;
};

/**
 * Get the address.
 * @returns {Address} address
 */

Output.prototype.getAddress = function getAddress() {
  var address;

  if (this._address)
    return this._address;

  address = this.script.getAddress();

  if (!this.mutable)
    this._address = address;

  return address;
};

/**
 * Get the address hash.
 * @returns {Hash} hash
 */

Output.prototype.getHash = function getHash() {
  var address = this.getAddress();
  if (!address)
    return;
  return address.getHash('hex');
};

/**
 * Test the output against an address, an
 * array of addresses, or a map of addresses.
 * @param {String|String[]|Object} addressMap
 * @returns {Boolean} Whether the output matched.
 */

Output.prototype.test = function test(addressMap) {
  var hash = this.getHash();

  if (!hash)
    return false;

  if (typeof addressMap === 'string')
    return hash === addressMap;

  if (Array.isArray(addressMap))
    return addressMap.indexOf(hash) !== -1;

  if (addressMap[hash] != null)
    return true;

  return false;
};

/**
 * Convert the input to a more user-friendly object.
 * @returns {Object}
 */

Output.prototype.inspect = function inspect() {
  return {
    type: this.getType(),
    value: utils.btc(this.value),
    script: this.script,
    address: this.getAddress()
  };
};

/**
 * Convert the output to an object suitable
 * for JSON serialization.
 * @returns {Object}
 */

Output.prototype.toJSON = function toJSON() {
  return {
    value: utils.btc(this.value),
    script: this.script.toRaw('hex')
  };
};

/**
 * Calculate the dust threshold for this
 * output, based on serialize size and rate.
 * @param {Number?} rate
 * @returns {BN}
 */

Output.prototype.getDustThreshold = function getDustThreshold(rate) {
  var size;

  if (rate == null)
    rate = constants.tx.MIN_RELAY;

  if (this.script.isUnspendable())
    return new bn(0);

  size = Framer.output(this, new BufferWriter()).written;
  size += 148;

  return bcoin.tx.getMinFee(size, rate).muln(3);
};

/**
 * Test whether the output should be considered dust.
 * @param {Number?} rate
 * @returns {Boolean}
 */

Output.prototype.isDust = function isDust(rate) {
  return this.value.cmp(this.getDustThreshold(rate)) < 0;
};

/**
 * Handle a deserialized JSON output object.
 * @returns {NakedOutput} A "naked" output (a
 * plain javascript object which is suitable
 * for passing to the Output constructor).
 */

Output.parseJSON = function parseJSON(json) {
  return {
    value: utils.satoshi(json.value),
    script: bcoin.script.parseRaw(json.script, 'hex')
  };
};

/**
 * Instantiate an Output from a jsonified output object.
 * @param {Object} json - The jsonified output object.
 * @returns {Output}
 */

Output.fromJSON = function fromJSON(json) {
  return new Output(Output.parseJSON(json));
};

/**
 * Serialize the output.
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Buffer|String}
 */

Output.prototype.toRaw = function toRaw(enc) {
  var data = Framer.output(this);

  if (enc === 'hex')
    data = data.toString('hex');

  return data;
};

/**
 * Parse a serialized output.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {NakedOutput} A "naked" output object.
 */

Output.parseRaw = function parseRaw(data, enc) {
  if (enc === 'hex')
    data = new Buffer(data, 'hex');

  data = bcoin.protocol.parser.parseOutput(data);

  return data;
};

/**
 * Instantiate an output from a serialized Buffer.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Output}
 */

Output.fromRaw = function fromRaw(data, enc) {
  return new Output(Output.parseRaw(data, enc));
};

/**
 * Test an object to see if it is an Output.
 * @param {Object} obj
 * @returns {Boolean}
 */

Output.isOutput = function isOutput(obj) {
  return obj
    && obj.value
    && obj.script
    && typeof obj.getAddress === 'function';
};

module.exports = Output;
