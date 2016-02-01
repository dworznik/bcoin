/**
 * tx.js - transaction object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * https://github.com/indutny/bcoin
 */

var bn = require('bn.js');

var bcoin = require('../bcoin');
var utils = bcoin.utils;
var assert = utils.assert;
var constants = bcoin.protocol.constants;

/**
 * TX
 */

function TX(data, block) {
  if (!(this instanceof TX))
    return new TX(data, block);

  if (!data)
    data = {};

  this.type = 'tx';
  this.version = data.version || 1;
  this.inputs = [];
  this.outputs = [];
  this.lock = data.lock || 0;
  this.ts = data.ts || 0;
  this.block = data.block || null;
  this._hash = null;

  this._raw = data._raw || null;
  this._size = data._size || 0;

  this.network = data.network || false;
  this.relayedBy = data.relayedBy || '0.0.0.0';

  this._chain = data.chain;

  if (data.inputs) {
    assert(this.inputs.length === 0);
    data.inputs.forEach(function(input) {
      this.input(input);
    }, this);
  }

  if (data.outputs) {
    assert(this.outputs.length === 0);
    data.outputs.forEach(function(output) {
      this.output(output);
    }, this);
  }

  if (block && block.subtype === 'merkleblock') {
    if (!data.ts && block && block.hasTX(this.hash('hex'))) {
      this.ts = block.ts;
      this.block = block.hash('hex');
    }
  }

  this.unspent = data.unspent || null;
  this.hardFee = data.hardFee || null;
  this.subtractFee = data.subtractFee || null;
  this.changeAddress = data.changeAddress || null;
  this.changeIndex = data.changeIndex != null ? data.changeIndex : -1;

  // ps = Pending Since
  this.ps = this.ts === 0 ? utils.now() : 0;

  // Discourage fee snipping a la bitcoind
  // if (data.lock == null)
  //   this._avoidFeeSnipping();
}

TX.prototype.clone = function clone() {
  return new TX(this);
};

TX.prototype.hash = function hash(enc, force) {
  var h = utils.dsha256(this.render(force));
  return enc === 'hex' ? utils.toHex(h) : h;
};

TX.prototype.render = function render(force) {
  if (!force && this.network && this._raw)
    return this._raw.slice();
  return bcoin.protocol.framer.tx(this);
};

TX.prototype.size = function size() {
  return this._size || this.render().length;
};

TX.prototype.input = function input(i, index) {
  this._input(i, index);
  return this;
};

// tx._input(tx, index)
// tx._input(hash, index)
// tx._input(input)
// tx._input({ hash: hash, index: index })
// tx._input({ tx: tx, index: index })
TX.prototype._input = function _input(obj, index) {
  var options, hash, input, ex, i;

  if (obj instanceof TX)
    options = { tx: obj, index: index };
  else if (typeof obj === 'string' || utils.isBuffer(obj))
    options = { hash: obj, index: index };
  else
    options = obj;

  if (options.tx)
    hash = options.tx.hash('hex');
  else if (options.out)
    hash = options.out.hash;
  else
    hash = options.hash;

  if (typeof hash !== 'string')
    hash = utils.toHex(hash);

  input = bcoin.input({
    tx: this,
    out: {
      tx: options.out ? options.out.tx : options.tx,
      hash: hash,
      index: options.out ? options.out.index : options.index
    },
    script: options.script,
    seq: options.seq
  });

  // Try modifying existing input first
  i = this._inputIndex(input.out.hash, input.out.index);
  if (i !== -1) {
    ex = this.inputs[i];
    input.out.tx = input.out.tx || ex.out.tx;
    input.seq = input.seq || ex.seq;
    input.script = input.script.length ? input.script : ex.script;
    this.inputs[i] = input;
  } else {
    this.inputs.push(input);
    i = this.inputs.length - 1;
  }

  return i;
};

TX.prototype._inputIndex = function _inputIndex(hash, index) {
  var i, ex;

  if (hash instanceof TX)
    hash = hash.hash('hex');

  for (i = 0; i < this.inputs.length; i++) {
    ex = this.inputs[i];
    if (ex.out.hash === hash && ex.out.index === index)
      return i;
  }

  return -1;
};

TX.prototype.scriptInput = function scriptInput(index, pub, redeem) {
  var input, s, n, i;

  if (typeof index !== 'number')
    index = this.inputs.indexOf(index);

  // Get the input
  input = this.inputs[index];
  assert(input);

  // We should have previous outputs by now.
  assert(input.out.tx);

  // Already has a script template (at least)
  if (input.script.length)
    return;

  // Get the previous output's subscript
  s = input.out.tx.getSubscript(input.out.index);

  // P2SH
  if (bcoin.script.isScripthash(s)) {
    assert(redeem);
    s = bcoin.script.getSubscript(bcoin.script.decode(redeem));
  } else {
    redeem = null;
  }

  if (bcoin.script.isPubkey(s)) {
    // P2PK
    input.script = [[]];
  } else if (bcoin.script.isPubkeyhash(s)) {
    // P2PKH
    input.script = [[], pub];
  } else if (bcoin.script.isMultisig(s)) {
    // Multisig
    // Technically we should create m signature slots,
    // but we create n signature slots so we can order
    // the signatures properly.
    input.script = [[]];

    // Grab `n` value (number of keys).
    n = s[s.length - 2];

    // Fill script with `n` signature slots.
    for (i = 0; i < n; i++)
      input.script[i + 1] = [];
  } else {
    // Likely a non-standard scripthash multisig
    // input. Determine n value by counting keys.
    // Also, only allow nonstandard types for
    // scripthash.
    if (redeem) {
      input.script = [[]];
      // Fill script with `n` signature slots.
      for (i = 0; i < s.length; i++) {
        if (bcoin.script.isKey(s[i]))
          input.script.push([]);
      }
    }
  }

  // P2SH requires the redeem script after signatures
  if (redeem) {
    input.script.push(redeem);
    // The fee can be calculated more accurately
    // now that the redeem script is available.
    this._recalculateFee();
  }
};

TX.prototype.signature = function signature(index, key, type) {
  var input, s, hash, signature;

  if (typeof index !== 'number')
    index = this.inputs.indexOf(index);

  if (type == null)
    type = 'all';

  if (typeof type === 'string')
    type = constants.hashType[type];

  // Get the input
  input = this.inputs[index];
  assert(input);

  // We should have previous outputs by now.
  assert(input.out.tx);

  // Get the previous output's subscript
  s = input.out.tx.getSubscript(input.out.index);

  // We need to grab the redeem script when
  // signing p2sh transactions.
  if (bcoin.script.isScripthash(s)) {
    s = bcoin.script.decode(input.script[input.script.length - 1]);
    s = bcoin.script.getSubscript(s);
  }

  // Get the hash of the current tx, minus the other
  // inputs, plus the sighash type.
  hash = this.signatureHash(index, s, type);

  // Sign the transaction with our one input
  signature = bcoin.script.sign(hash, key, type);

  // Something is broken if this doesn't work:
  assert(bcoin.script.checksig(hash, signature, key));

  return signature;
};

// Sign the now-built scriptSigs
TX.prototype.signInput = function signInput(index, key, type) {
  var input, s, hash, signature;
  var len, m, n, keys, pub, pkh, ki, signatures, i;

  if (typeof index !== 'number')
    index = this.inputs.indexOf(index);

  // Get the input
  input = this.inputs[index];
  assert(input);

  // We should have previous outputs by now.
  assert(input.out.tx);

  // Create our signature.
  signature = this.signature(index, key, type);

  // Get the previous output's subscript
  s = input.out.tx.getSubscript(input.out.index);

  // Script length, needed for multisig
  len = input.script.length;

  // We need to grab the redeem script when
  // signing p2sh transactions.
  if (bcoin.script.isScripthash(s)) {
    s = bcoin.script.decode(input.script[input.script.length - 1]);
    s = bcoin.script.getSubscript(s);
    // Decrement `len` to avoid the redeem script
    len--;
  }

  // Get pubkey and pubkey hash.
  pub = key.getPublic(true, 'array');
  pkh = bcoin.wallet.key2hash(pub);

  // Add signatures.
  if (bcoin.script.isPubkey(s)) {
    // P2PK

    // Something is wrong. Abort.
    if (!Array.isArray(input.script[0]))
      return false;

    // Already signed.
    if (input.script[0].length)
      return true;

    // Make sure the pubkey is ours.
    if (!utils.isEqual(pub, s[0]))
      return false;

    input.script[0] = signature;

    return true;
  }

  if (bcoin.script.isPubkeyhash(s)) {
    // P2PKH

    // Something is wrong. Abort.
    if (!Array.isArray(input.script[0]))
      return false;

    // Already signed.
    if (input.script[0].length)
      return true;

    // Make sure the pubkey hash is ours.
    if (!utils.isEqual(pkh, s[2]))
      return false;

    input.script[0] = signature;

    return true;
  }

  if (bcoin.script.isMultisig(s)) {
    // Multisig

    // Grab the redeem script's keys to figure
    // out where our key should go.
    keys = s.slice(1, -2);

    // Grab `m` value (number of sigs required).
    m = s[0];

    // Grab `n` value (number of keys).
    n = s[s.length - 2];
  } else {
    // Only allow non-standard signing for
    // scripthash.
    if (len !== input.script.length - 1)
      return false;

    keys = [];

    for (i = 0; i < s.length; i++) {
      if (bcoin.script.isKey(s[i]))
        keys.push(s[i]);
    }

    n = keys.length;
    m = n;
  }

  // Something is very wrong here. Abort.
  if (len - 1 > n)
    return false;

  // Count the number of current signatures.
  signatures = 0;
  for (i = 1; i < len; i++) {
    if (bcoin.script.isSignature(input.script[i]))
      signatures++;
  }

  // Signatures are already finalized.
  if (signatures === m && len - 1 === m)
    return true;

  // This can happen in a case where another
  // implementation adds signatures willy-nilly
  // or by `m`. Add some signature slots for
  // us to use.
  while (len - 1 < n) {
    input.script.splice(len, 0, []);
    len++;
  }

  // Find the key index so we can place
  // the signature in the same index.
  for (ki = 0; ki < keys.length; ki++) {
    if (utils.isEqual(pub, keys[ki]))
      break;
  }

  // Our public key is not in the prev_out
  // script. We tried to sign a transaction
  // that is not redeemable by us.
  if (ki === keys.length)
    return false;

  // Offset key index by one to turn it into
  // "sig index". Accounts for OP_0 byte at
  // the start.
  ki++;

  // Add our signature to the correct slot
  // and increment the total number of
  // signatures.
  if (ki < len && signatures < m) {
    if (bcoin.script.isDummy(input.script[ki])) {
      input.script[ki] = signature;
      signatures++;
    }
  }

  // All signatures added. Finalize.
  if (signatures >= m) {
    // Remove empty slots left over.
    for (i = len - 1; i >= 1; i--) {
      if (bcoin.script.isDummy(input.script[i])) {
        input.script.splice(i, 1);
        len--;
      }
    }

    // Remove signatures which are not required.
    // This should never happen except when dealing
    // with implementations that potentially handle
    // signature slots differently.
    while (signatures > m) {
      input.script.splice(len - 1, 1);
      signatures--;
      len--;
    }

    // Sanity checks.
    assert.equal(signatures, m);
    assert.equal(len - 1, m);
  }

  return signatures === m;
};

TX.prototype.scriptSig = function scriptSig(index, key, pub, redeem, type) {
  var input;

  if (typeof index !== 'number')
    index = this.inputs.indexOf(index);

  // Get the input
  input = this.inputs[index];
  assert(input);

  // Build script for input
  this.scriptInput(index, pub, redeem);

  // Sign input
  this.signInput(index, key, type);

  return input.script;
};

TX.prototype.output = function output(obj, value) {
  var options, output;

  if (obj instanceof bcoin.wallet)
    obj = obj.getAddress();

  if (typeof obj === 'string') {
    options = {
      address: obj,
      value: value
    };
  } else {
    options = obj;
  }

  output = bcoin.output({
    tx: this,
    value: options.value,
    script: options.script
  });

  this.outputs.push(output);

  this.scriptOutput(this.outputs.length - 1, options);

  return this;
};

TX.prototype.out = TX.prototype.output;

TX.prototype.scriptOutput = function scriptOutput(index, options) {
  var output, script, keys, m, n, hash, flags;

  if (typeof index !== 'number')
    index = this.outputs.indexOf(index);

  output = this.outputs[index];
  assert(output);

  if (!options)
    options = output;

  script = output.script;

  if (options instanceof bcoin.output) {
    options = Object.keys(options).reduce(function(out, key) {
      out[key] = options[key];
      return out;
    }, {});
  }

  if (options.addr) {
    options.address = options.addr;
    delete options.addr;
  }

  if (Array.isArray(options.address)) {
    options.keys = options.address.map(function(address) {
      return bcoin.wallet.addr2hash(address, 'pubkeyhash');
    });
    delete options.address;
  }

  if (options.minSignatures) {
    options.m = options.minSignatures;
    delete options.minSignatures;
  }

  if (options.color) {
    options.flags = options.color;
    delete options.color;
  }

  if (Array.isArray(options.keys)) {
    // Bare Multisig Transaction
    // https://github.com/bitcoin/bips/blob/master/bip-0010.mediawiki
    // https://github.com/bitcoin/bips/blob/master/bip-0011.mediawiki
    // https://github.com/bitcoin/bips/blob/master/bip-0019.mediawiki
    // m [key1] [key2] ... n checkmultisig
    keys = options.keys.map(utils.toBuffer);

    m = options.m || keys.length;
    n = options.n || keys.length;

    if (!(m >= 1 && m <= n))
      return;

    if (!(n >= 1 && n <= (options.scripthash ? 15 : 3)))
      return;

    script = bcoin.script.createMultisig(keys, m, n);
  } else if (bcoin.wallet.validateAddress(options.address, 'scripthash')) {
    // P2SH Transaction
    // https://github.com/bitcoin/bips/blob/master/bip-0016.mediawiki
    // hash160 [20-byte-redeemscript-hash] equal
    script = [
      'hash160',
      bcoin.wallet.addr2hash(options.address, 'scripthash'),
      'equal'
    ];
  } else if (options.address) {
    // P2PKH Transaction
    // dup hash160 [pubkey-hash] equalverify checksig
    script = [
      'dup',
      'hash160',
      bcoin.wallet.addr2hash(options.address, 'pubkeyhash'),
      'equalverify',
      'checksig'
    ];
  } else if (options.key) {
    // P2PK Transaction
    // [pubkey] checksig
    script = [
      utils.toBuffer(options.key),
      'checksig'
    ];
  } else if (options.flags) {
    // Nulldata Transaction
    // return [data]
    flags = options.flags;
    if (typeof flags === 'string')
      flags = utils.ascii2array(flags);
    assert(utils.isBuffer(flags));
    assert(flags.length <= constants.script.maxOpReturn);
    script = [
      'return',
      flags
    ];
  }

  // P2SH Transaction
  // hash160 [hash] eq
  if (options.scripthash) {
    if (options.lock != null) {
      script = [
        bcoin.script.array(options.lock),
        'checklocktimeverify',
        'drop',
        'codeseparator'
      ].concat(script);
    }
    hash = utils.ripesha(bcoin.script.encode(script));
    script = [
      'hash160',
      hash,
      'equal'
    ];
  }

  output.script = script;
};

TX.prototype.getSubscript = function getSubscript(index) {
  var script = this.outputs[index].script;
  return bcoin.script.getSubscript(script);
};

TX.prototype.signatureHash = function signatureHash(index, s, type) {
  var copy = this.clone();
  var i, msg, hash;

  if (!Array.isArray(s)) {
    type = s;
    s = this.inputs[index].out.tx.getSubscript(this.inputs[index].out.index);
    if (bcoin.script.isScripthash(s)) {
      s = this.inputs[index].script[this.inputs[index.script.length - 1]];
      s = bcoin.script.getSubscript(bcoin.script.decode(s));
    }
  }

  if (typeof index !== 'number')
    index = this.inputs.indexOf(index);

  if (typeof type === 'string')
    type = constants.hashType[type];

  assert(index >= 0 && index < copy.inputs.length)
  assert(Array.isArray(s));

  // Disable this for now. We allow null hash types
  // because bitcoind allows empty signatures. On
  // another note, we allow all weird sighash types
  // if strictenc is not enabled.
  // assert(utils.isFinite(type));

  // Remove code separators.
  // s = script.getSubscript(s);

  // Remove all signatures.
  for (i = 0; i < copy.inputs.length; i++)
    copy.inputs[i].script = [];

  // Set our input to previous output's script
  copy.inputs[index].script = s;

  if ((type & 0x1f) === constants.hashType.none) {
    // Drop all outputs. We don't want to sign them.
    copy.outputs = [];

    // Allow input sequence updates for other inputs.
    for (i = 0; i < copy.inputs.length; i++) {
      if (i !== index)
        copy.inputs[i].seq = 0;
    }
  } else if ((type & 0x1f) === constants.hashType.single) {
    // Bitcoind used to return 1 as an error code:
    // it ended up being treated like a hash.
    if (index >= copy.outputs.length)
      return constants.oneHash.slice();

    // Drop all the outputs after the input index.
    copy.outputs.length = index + 1;

    // Null outputs that are not the at current input index.
    for (i = 0; i < copy.outputs.length; i++) {
      if (i !== index) {
        copy.outputs[i].script = [];
        copy.outputs[i].value = new bn('ffffffffffffffff', 'hex');
      }
    }

    // Allow input sequence updates for other inputs.
    for (i = 0; i < copy.inputs.length; i++) {
      if (i !== index)
        copy.inputs[i].seq = 0;
    }
  }

  // Only sign our input. Allows anyone to add inputs.
  if (type & constants.hashType.anyonecanpay) {
    copy.inputs[0] = copy.inputs[index];
    copy.inputs.length = 1;
  }

  msg = copy.render(true);

  utils.writeU32(msg, type, msg.length);

  hash = utils.dsha256(msg);

  return hash;
};

TX.prototype.tbsHash = function tbsHash(enc, force) {
  var copy = this.clone();
  var i;

  if (this.isCoinbase())
    return this.hash(enc);

  if (!this._tbsHash || force) {
    for (i = 0; i < copy.inputs.length; i++)
      copy.inputs[i].script = [];

    this._tbsHash = utils.dsha256(copy.render(true));
  }

  return enc === 'hex'
    ? utils.toHex(this._tbsHash)
    : this._tbsHash.slice();
};

TX.prototype.verify = function verify(index, force, flags) {
  // Valid if included in block
  if (!force && this.ts !== 0)
    return true;

  if (this.inputs.length === 0)
    return false;

  return this.inputs.every(function(input, i) {
    var output;

    if (index != null && index !== i)
      return true;

    if (!input.out.tx)
      return false;

    // Somethis is very wrong if this is
    // not the case.
    assert.equal(input.out.tx.hash('hex'), input.out.hash);

    // Grab the previous output.
    output = input.out.tx.outputs[input.out.index];

    // Transaction is referencing an output
    // that does not exist.
    if (!output)
      return false;

    // Transaction cannot reference itself.
    if (input.out.hash === this.hash('hex'))
      return false;

    return bcoin.script.verify(input.script, output.script, this, i, flags);
  }, this);
};

TX.prototype.isCoinbase = function isCoinbase() {
  return this.inputs.length === 1 && +this.inputs[0].out.hash === 0;
};

TX.prototype.maxSize = function maxSize() {
  var copy = this.clone();
  var i, j, input, total, size, s, m, n;

  // Create copy with 0-script inputs
  for (i = 0; i < copy.inputs.length; i++)
    copy.inputs[i].script = [];

  total = copy.render().length;

  // Add size for signatures and public keys
  for (i = 0; i < copy.inputs.length; i++) {
    input = copy.inputs[i];
    size = 0;

    // Get the previous output's subscript
    s = input.out.tx.getSubscript(input.out.index);

    // If we have access to the redeem script,
    // we can use it to calculate size much easier.
    if (this.inputs[i].script.length && bcoin.script.isScripthash(s)) {
      s = this.inputs[i].script[this.inputs[i].script.length - 1];
      // Need to add the redeem script size
      // here since it will be ignored by
      // the isMultisig clause.
      // OP_PUSHDATA2 [redeem]
      size += 3 + s.length;
      s = bcoin.script.getSubscript(bcoin.script.decode(s));
    }

    if (bcoin.script.isPubkey(s)) {
      // P2PK
      // OP_PUSHDATA0 [signature]
      size += 1 + 73;
    } else if (bcoin.script.isPubkeyhash(s)) {
      // P2PKH
      // OP_PUSHDATA0 [signature]
      size += 1 + 73;
      // OP_PUSHDATA0 [key]
      size += 1 + 65;
    } else if (bcoin.script.isMultisig(s)) {
      // Bare Multisig
      // Get the previous m value:
      m = s[0];
      // OP_0
      size += 1;
      // OP_PUSHDATA0 [signature] ...
      size += (1 + 73) * m;
    } else if (bcoin.script.isScripthash(s)) {
      // P2SH Multisig
      // This technically won't work well for other
      // kinds of P2SH. It will also over-estimate
      // the fee by a lot (at least 10000 satoshis
      // since we don't have access to the m and n
      // values), which will be recalculated later.
      // If fee turns out to be smaller later, we
      // simply add more of the fee to the change
      // output.
      // m value
      m = 15;
      // n value
      n = 15;
      // OP_0
      size += 1;
      // OP_PUSHDATA0 [signature] ...
      size += (1 + 73) * m;
      // OP_PUSHDATA2 [redeem]
      size += 3;
      // m value
      size += 1;
      // OP_PUSHDATA0 [key] ...
      size += (1 + 65) * n;
      // n value
      size += 1;
      // OP_CHECKMULTISIG
      size += 1;
    } else {
      // OP_PUSHDATA0 [signature]
      for (j = 0; j < s.length; j++) {
        if (bcoin.script.isKey(s[j]))
          size += 1 + 73;
      }
    }

    // Byte for varint size of input script
    if (size < 0xfd)
      size += 0;
    else if (size <= 0xffff)
      size += 2;
    else if (size <= 0xffffffff)
      size += 4;
    else
      size += 8;

    total += size;
  }

  return total;
};

TX.prototype.getUnspent = function getUnspent(unspent, address, fee) {
  var tx = this.clone();
  var cost = tx.funds('out');
  var totalkb = 1;
  var total = cost.addn(constants.tx.fee);
  var inputs = [];
  var lastAdded = 0;
  var size, newkb, change;

  if (fee) {
    total = cost.add(fee);
    this.hardFee = fee;
  }

  function addInput(unspent) {
    // Add new inputs until TX will have enough
    // funds to cover both minimum post cost
    // and fee.
    var index = tx._input(unspent);
    inputs.push(tx.inputs[index]);
    lastAdded++;
    return tx.funds('in').cmp(total) < 0;
  }

  // Transfer `total` funds maximum.
  unspent.every(addInput);

  if (!fee) {
    // Add dummy output (for `change`) to
    // calculate maximum TX size.
    tx.output({
      address: address,
      value: new bn(0)
    });

    // if (this.subtractFee) {
    //   var f = new bn((Math.ceil(tx.maxSize() / 1024) - 1) * constants.tx.fee);
    //   for (var j = 0; j < this.outputs.length; j++) {
    //     if (this.outputs[j].value.cmp(f.addn(constants.tx.dust)) >= 0) {
    //       this.outputs[j].value = this.outputs[j].value.sub(f);
    //       break;
    //     }
    //   }
    //   total = tx.funds('out');
    // }

    // Change fee value if it is more than 1024
    // bytes (10000 satoshi for every 1024 bytes).
    do {
      // Calculate max possible size after signing.
      size = tx.maxSize();

      newkb = Math.ceil(size / 1024) - totalkb;
      total.iaddn(newkb * constants.tx.fee);
      totalkb += newkb;

      // Failed to get enough funds, add more inputs.
      if (tx.funds('in').cmp(total) < 0)
        unspent.slice(lastAdded).every(addInput);
    } while (tx.funds('in').cmp(total) < 0 && lastAdded < unspent.length);
  }

  if (tx.funds('in').cmp(total) < 0) {
    // Still failing to get enough funds.
    inputs = null;
  } else {
    // How much money is left after filling outputs.
    change = tx.funds('in').sub(total);
  }

  // Return necessary inputs and change.
  return {
    inputs: inputs,
    change: change,
    cost: cost,
    fee: total.sub(cost),
    total: total,
    kb: totalkb
  };
};

TX.prototype.fillUnspent = function fillUnspent(unspent, address, fee) {
  var result;

  if (unspent)
    this.unspent = unspent;

  if (address)
    this.changeAddress = address;

  if (fee)
    this.hardFee = fee;

  assert(this.changeAddress);

  result = this.getUnspent(this.unspent, this.changeAddress, this.hardFee);

  if (!result.inputs)
    return result;

  result.inputs.forEach(function(input) {
    this.input(input);
  }, this);

  if (result.change.cmpn(constants.tx.dust) < 0) {
    // Do nothing. Change is added to fee.
    assert.equal(
      this.getFee().toNumber(),
      result.fee.add(result.change).toNumber()
    );
    this.changeIndex = -1;
  } else {
    this.output({
      address: this.changeAddress,
      value: result.change
    });

    this.changeIndex = this.outputs.length - 1;
  }

  return result;
};

TX.prototype._recalculateFee = function recalculateFee() {
  var output = this.outputs[this.changeIndex];
  var size, real, fee;

  if (this.hardFee)
    return;

  if (!output) {
    this.output({
      address: this.changeAddress,
      value: new bn(0)
    });
    output = this.outputs[this.outputs.length - 1];
  }

  size = this.maxSize();
  real = Math.ceil(size / 1024) * constants.tx.fee;
  fee = this.getFee().toNumber();

  // if (this.hardFee)
  //   real = this.hardFee;

  if (real === fee) {
    if (this.changeIndex === -1)
      this.outputs.pop();
    return;
  }

  if (real > fee) {
    if (output.value.cmpn(real - fee) < 0) {
      this.outputs.pop();
      this.changeIndex = -1;
      return;
    }
    output.value.isubn(real - fee);
  } else {
    output.value.iaddn(fee - real);
  }

  if (output.value.cmpn(constants.tx.dust) < 0) {
    this.outputs.pop();
    this.changeIndex = -1;
    return;
  }

  this.changeIndex = this.outputs.indexOf(output);
};

TX.prototype.getFee = function getFee() {
  if (this.funds('in').cmp(this.funds('out')) < 0)
    return new bn(0);

  return this.funds('in').sub(this.funds('out'));
};

TX.prototype.funds = function funds(side) {
  var acc = new bn(0);
  var inputs;

  if (side === 'in') {
    inputs = this.inputs.filter(function(input) {
      return input.out.tx;
    });

    if (inputs.length === 0)
      return acc;

    inputs.reduce(function(acc, input) {
      return acc.iadd(input.out.tx.outputs[input.out.index].value);
    }, acc);

    return acc;
  }

  // Output
  if (this.outputs.length === 0)
    return acc;

  this.outputs.reduce(function(acc, output) {
    return acc.iadd(output.value);
  }, acc);

  return acc;
};

TX.prototype._avoidFeeSnipping = function _avoidFeeSnipping() {
  if (!this.chain)
    return;

  this.lock = this.chain.height();

  if ((Math.random() * 10 | 0) === 0)
    this.lock = Math.max(0, this.lock - (Math.random() * 100 | 0));
};

TX.prototype.setLockTime = function setLockTime(lock) {
  var i, input;

  this.lock = lock;

  for (i = 0; i < this.inputs.length; i++) {
    input = this.inputs[i];
    if (input.seq === 0xffffffff)
      input.seq = 0;
  }
};

TX.prototype.increaseFee = function increaseFee(fee) {
  var i, input;

  this.hardFee = fee || this.getFee().add(new bn(10000));
  this.fillUnspent();

  for (i = 0; i < this.inputs.length; i++) {
    input = this.inputs[i];
    input.seq = 0xffffffff - 1;
  }
};

TX.prototype.isFull = function isFull() {
  if (this.inputs.length === 0)
    return false;
  return this.inputs.every(function(input) {
    return !!input.out.tx;
  });
};

TX.prototype.fill = function fill(txs) {
  var inputs;

  if (txs instanceof bcoin.txPool)
    txs = txs._all;
  else if (txs instanceof bcoin.wallet)
    txs = txs.tx._all;

  if (Array.isArray(txs)) {
    txs = txs.reduce(function(out, tx) {
      out[tx.hash('hex')] = tx;
      return out;
    }, {});
  }

  inputs = this.inputs.filter(function(input) {
    if (!input.out.tx && txs[input.out.hash])
      input.out.tx = txs[input.out.hash];
    return !!input.out.tx;
  }, this);

  return inputs.length === this.inputs.length;
};

// Used for verifyContext/ContextualBlockCheck and miner isFinalTx call.
// BIP113 will require that time-locked transactions have nLockTime set to
// less than the median time of the previous block they're contained in.
TX.prototype.isFinalBlock = function isFinalBlock(block, prev, useMedian) {
  var height = prev.height + 1;
  var ts = useMedian ? prev.getMedianTime() : block.ts;
  return this.isFinal(height, ts);
};

// Used in AcceptToMemoryPool
TX.prototype.isFinalMempool = function isFinalMempool(useMedian) {
  var height, ts;

  if (!this.chain)
    return true;

  height = this.chain.height() + 1;
  ts = useMedian
    ? this.chain.getTip().getMedianTime()
    : utils.now();

  return this.isFinal(height, ts);
};

// Used in the original bitcoind code for AcceptBlock
TX.prototype.isFinalLegacy = function isFinalLegacy(block) {
  var ts, height;

  if (!this.chain)
    return true;

  ts = block ? block.ts : utils.now();
  height = this.chain.height();

  return this.isFinal(height, ts);
};

TX.prototype.isFinal = function isFinal(height, ts) {
  var threshold = constants.locktimeThreshold;
  var i;

  if (!this.chain)
    return true;

  if (this.lock === 0)
    return true;

  if (this.lock < (this.lock < threshold ? height : ts))
    return true;

  for (i = 0; i < this.inputs.length; i++) {
    if (this.inputs[i].seq !== 0xffffffff)
      return false;
  }

  return true;
};

TX.prototype.getSigops = function getSigops(scripthash, accurate) {
  var n = 0;
  this.inputs.forEach(function(input) {
    n += bcoin.script.getSigops(input.script, accurate);
    if (scripthash && !this.isCoinbase())
      n += bcoin.script.getScripthashSigops(input.script);
  }, this);
  this.outputs.forEach(function(output) {
    n += bcoin.script.getSigops(output.script, accurate);
  }, this);
  return n;
};

TX.prototype.isStandard = function isStandard() {
  var i, input, output, type;
  var nulldata = 0;

  if (this.version > constants.tx.version || this.version < 1)
    return false;

  if (this.size() > constants.tx.maxSize)
    return false;

  for (i = 0; i < this.inputs.length; i++) {
    input = this.inputs[i];

    if (script.size(input.script) > 1650)
      return false;

    if (!bcoin.script.isPushOnly(input.script))
      return false;
  }

  for (i = 0; i < this.outputs.length; i++) {
    output = this.outputs[i];
    type = bcoin.script.getType(output.script);

    if (!bcoin.script.isStandard(output.script))
      return false;

    if (!type)
      return false;

    if (type === 'nulldata') {
      nulldata++;
      continue;
    }

    if (type === 'multisig' && !constants.tx.bareMultisig)
      return false;

    if (output.value.cmpn(constants.tx.dust) < 0)
      return false;
  }

  if (nulldata > 1)
    return false;

  return true;
};

TX.prototype.isStandardInputs = function isStandardInputs(flags) {
  var i, input, prev, args, stack, res, s, targs;

  if (this.isCoinbase())
    return true;

  for (i = 0; i < this.inputs.length; i++) {
    input = this.inputs[i];

    if (!input.out.tx)
      return false;

    prev = input.out.tx.outputs[input.out.index];

    if (!prev)
      return false;

    args = bcoin.script.getArgs(prev.script);

    if (args < 0)
      return false;

    stack = [];

    res = bcoin.script.execute(input.script, stack, this, i, flags);

    if (!res)
      return false;

    if (bcoin.script.isScripthash(prev.script)) {
      if (stack.length === 0)
        return false;

      s = stack[stack.length - 1];

      if (!Array.isArray(s))
        return false;

      s = bcoin.script.getSubscript(bcoin.script.decode(s));

      if (bcoin.script.getType(s) !== 'unknown') {
        targs = bcoin.script.getArgs(s);
        if (targs < 0)
          return false;
        args += targs;
      } else {
        return script.getSigops(s, true) <= constants.script.maxScripthashSigops;
      }
    }

    if (stack.length !== args)
      return false;
  }

  return true;
};

TX.prototype.getPriority = function getPriority() {
  var size, value, i, input, output, age;

  size = this.maxSize();
  value = new bn(0);

  for (i = 0; i < this.inputs.length; i++) {
    input = this.inputs[i];

    if (!input.out.tx)
      return constants.tx.freeThreshold.clone();

    output = input.out.tx.outputs[input.out.index];
    age = input.out.tx.getConfirmations();

    if (age === -1)
      age = 0;

    if (age !== 0)
      age += 1;

    value.iadd(output.value.muln(age));
  }

  return priority.divn(size);
};

TX.prototype.isFree = function isFree() {
  var size = this.maxSize();
  var priority;

  if (size >= constants.tx.maxFreeSize)
    return false;

  priority = this.getPriority();

  return priority.cmp(constants.tx.freeThreshold) > 0;
};

TX.prototype.getHeight = function getHeight() {
  if (!this.chain)
    return -1;
  return this.block ? this.chain.getHeight(this.block) : -1;
};

TX.prototype.getConfirmations = function getConfirmations() {
  var top, height;

  if (!this.chain)
    return 0;

  top = this.chain.height();
  height = this.getHeight();

  if (height === -1)
    return 0;

  return top - height + 1;
};

TX.prototype.getValue = function getValue() {
  return this.funds('out');
};

TX.prototype.__defineGetter__('chain', function() {
  return this._chain || bcoin.chain.global;
});

TX.prototype.__defineGetter__('rblock', function() {
  return this.block
    ? utils.revHex(this.block)
    : null;
});

TX.prototype.__defineGetter__('rhash', function() {
  return utils.revHex(this.hash('hex'));
});

TX.prototype.__defineGetter__('fee', function() {
  return this.getFee();
});

TX.prototype.__defineGetter__('value', function() {
  return this.getValue();
});

TX.prototype.__defineGetter__('height', function() {
  return this.getHeight();
});

TX.prototype.__defineGetter__('confirmations', function() {
  return this.getConfirmations();
});

TX.prototype.__defineGetter__('priority', function() {
  return this.getPriority();
});

TX.prototype.inspect = function inspect() {
  var copy = bcoin.tx(this);
  copy.__proto__ = null;
  if (this.block)
    copy.block = this.block;
  delete copy._raw;
  delete copy._chain;
  delete copy.unspent;
  copy.hash = this.hash('hex');
  copy.rhash = this.rhash;
  copy.rblock = this.rblock;
  copy.value = utils.btc(this.getValue());
  copy.fee = utils.btc(this.getFee());
  copy.height = this.getHeight();
  copy.confirmations = this.getConfirmations();
  // copy.priority = this.getPriority().toString(10);
  copy.date = new Date((copy.ts || 0) * 1000).toISOString();
  if (copy.hardFee)
    copy.hardFee = utils.btc(copy.hardFee);
  return copy;
};

TX.prototype.toJSON = function toJSON() {
  // Compact representation
  return {
    v: 1,
    type: 'tx',
    ts: this.ts,
    ps: this.ps,
    block: this.block,
    network: this.network,
    relayedBy: this.relayedBy,
    changeAddress: this.changeAddress,
    changeIndex: this.changeIndex,
    hardFee: this.hardFee ? utils.btc(this.hardFee) : null,
    tx: utils.toHex(this.render())
  };
};

TX.fromJSON = function fromJSON(json) {
  var raw, data, tx;

  assert.equal(json.v, 1);
  assert.equal(json.type, 'tx');

  raw = utils.toArray(json.tx, 'hex');
  data = new bcoin.protocol.parser().parseTX(raw);

  data.network = json.network;
  data.relayedBy = json.relayedBy;

  data.changeAddress = json.changeAddress;
  data.changeIndex = json.changeIndex;

  if (json.hardFee)
    data.hardFee = utils.satoshi(json.hardFee);

  data._raw = raw;
  data._size = raw.length;

  tx = new TX(data);
  tx.ts = json.ts;
  tx.block = json.block || null;
  tx.ps = json.ps;

  return tx;
};

TX.prototype.toRaw = function toRaw(enc) {
  var raw = this.render();

  if (enc === 'hex')
    return utils.toHex(raw);

  return raw;
};

TX.fromRaw = function fromRaw(raw, enc) {
  if (enc === 'hex')
    raw = utils.toArray(raw, 'hex');
  return new bcoin.tx(new bcoin.protocol.parser().parseTX(raw));
};

/**
 * Expose
 */

module.exports = TX;
