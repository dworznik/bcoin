/**
 * script.js - script interpreter for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * https://github.com/indutny/bcoin
 */

var bcoin = require('../bcoin');
var bn = require('bn.js');
var constants = bcoin.protocol.constants;
var utils = bcoin.utils;
var assert = bcoin.utils.assert;
var script = exports;

/**
 * Script
 */

script.decode = function decode(s) {
  if (!s)
    return [];

  var opcodes = [];
  var i = 0;
  var b, opcode, len;

  while (i < s.length) {
    b = s[i++];

    // Next `b` bytes should be pushed to stack
    if (b >= 0x01 && b <= 0x4b) {
      opcodes.push(s.slice(i, i + b));
      i += b;
      utils.hidden(opcodes[opcodes.length - 1], 'pushdata', {
        opcode: null,
        len: b
      });
      continue;
    }

    // OP_0, OP_FALSE
    // Special case: this is an empty array
    // because it can be seen as an empty pushdata.
    if (b === 0x00) {
      opcodes.push([]);
      continue;
    }

    // OP_1, OP_TRUE, OP_2-OP_16
    // Special case: these get to be number
    // literals. Note: 1negate is not included.
    if (b >= 0x51 && b <= 0x60) {
      opcodes.push(b - 0x50);
      continue;
    }

    opcode = constants.opcodesByVal[b];

    if (i >= s.length) {
      opcodes.push(opcode || b);
      continue;
    }

    if (opcode === 'pushdata1') {
      len = s[i];
      i += 1;
      opcodes.push(s.slice(i, i + len));
      i += len;
      utils.hidden(opcodes[opcodes.length - 1], 'pushdata', {
        opcode: opcode,
        len: len
      });
    } else if (opcode === 'pushdata2') {
      len = utils.readU16(s, i);
      i += 2;
      opcodes.push(s.slice(i, i + len));
      i += len;
      utils.hidden(opcodes[opcodes.length - 1], 'pushdata', {
        opcode: opcode,
        len: len
      });
    } else if (opcode === 'pushdata4') {
      len = utils.readU32(s, i);
      i += 4;
      opcodes.push(s.slice(i, i + len));
      i += len;
      utils.hidden(opcodes[opcodes.length - 1], 'pushdata', {
        opcode: opcode,
        len: len
      });
    } else {
      opcodes.push(opcode || b);
    }
  }

  utils.hidden(opcodes, '_raw', s);

  return opcodes;
};

script.encode = function encode(s) {
  if (!s)
    return [];

  var opcodes = constants.opcodes;
  var res = [];
  var i = 0;
  var instr;

  for (i = 0; i < s.length; i++) {
    instr = s[i];

    // Push value to stack
    if (Array.isArray(instr)) {
      // Check for nonstandard pushdatas that
      // may have been decoded from before.
      if (instr.pushdata) {
        if (instr.pushdata.opcode === null) {
          res = res.concat(instr.pushdata.len, instr);
        } else if (instr.pushdata.opcode === 'pushdata1') {
          res = res.concat(opcodes.pushdata1, instr.pushdata.len, instr);
        } else if (instr.pushdata.opcode === 'pushdata2') {
          res.push(opcodes.pushdata2);
          utils.writeU16(res, instr.pushdata.len, res.length);
          res = res.concat(instr);
        } else if (instr.pushdata.opcode === 'pushdata4') {
          res.push(opcodes.pushdata4);
          utils.writeU32(res, instr.pushdata.len, res.length);
          res = res.concat(instr);
        }
        continue;
      }
      if (instr.length === 0) {
        res.push(opcodes['0']);
      } else if (1 <= instr.length && instr.length <= 0x4b) {
        res = res.concat(instr.length, instr);
      } else if (instr.length <= 0xff) {
        res = res.concat(opcodes.pushdata1, instr.length, instr);
      } else if (instr.length <= 0xffff) {
        res.push(opcodes.pushdata2);
        utils.writeU16(res, instr.length, res.length);
        res = res.concat(instr);
      } else {
        res.push(opcodes.pushdata4);
        utils.writeU32(res, instr.length, res.length);
        res = res.concat(instr);
      }
      continue;
    }

    res.push(opcodes[instr] || instr);
  }

  return res;
};

script.normalize = function normalize(s) {
  var i, op;

  // Remove OP_ prefixes and lowercase
  for (i = 0; i < s.length; i++) {
    op = s[i];
    if (typeof op === 'string') {
      op = op.toLowerCase();
      if (op.indexOf('op_') === 0)
        op = op.slice(3);
    }
    s[i] = op;
  }

  // Convert OP_0 to array, convert OP_1-OP_16
  // to number literals, convert -1 to OP_1NEGATE.
  // Convert hex strings to arrays.
  for (i = 0; i < s.length; i++) {
    op = s[i];

    if (op === '-1' || op === -1)
      op = '1negate';
    else if (op === '0' || op === 0 || op === 'false')
      op = [];
    else if (op === 'true')
      op = 1;
    else if (+op >= 1 && +op <= 16)
      op = +op;

    if (typeof op === 'string' && constants.opcodes[op] == null) {
      if (op[0] === '[')
        op = op.slice(1, -1);
      op = utils.toArray(op, 'hex');
    }

    s[i] = op;
  }

  return s;
};

script.verify = function verify(input, output, tx, i, flags) {
  var copy, res, redeem;
  var stack = [];

  if (!flags)
    flags = {};

  if (flags.sigpushonly !== false) {
    if (!script.isPushOnly(input))
      return false;
  }

  // Execute the input script
  script.execute(input, stack, tx, i, flags);

  // Copy the stack for P2SH
  if (flags.verifyp2sh !== false)
    copy = stack.slice();

  // Execute the previous output script
  res = script.execute(output, stack, tx, i, flags);

  // Verify the script did not fail as well as the stack values
  if (!res || stack.length === 0 || !script.bool(stack.pop()))
    return false;

  // If the script is P2SH, execute the real output script
  if (flags.verifyp2sh !== false && script.isScripthash(output)) {
    // P2SH can only have push ops in the scriptSig
    if (!script.isPushOnly(input))
      return false;

    // Reset the stack
    stack = copy;

    // Stack should not be empty at this point
    if (stack.length === 0)
      return false;

    // Grab the real redeem script
    redeem = stack.pop();

    if (!Array.isArray(redeem))
      return false;

    redeem = script.decode(redeem);

    // Execute the redeem script
    res = script.execute(redeem, stack, tx, i, flags);

    // Verify the script did not fail as well as the stack values
    if (!res || stack.length === 0 || !script.bool(stack.pop()))
      return false;
  }

  // Ensure there is nothing left on the stack
  if (flags.cleanstack !== false) {
    if (stack.length !== 0)
      return false;
  }

  return true;
};

script.getSubscript = function getSubscript(s, lastSep) {
  var i, res;

  if (!s)
    return [];

  if (lastSep == null)
    lastSep = -1;

  assert(lastSep <= 0 || s[lastSep] === 'codeseparator');

  res = [];
  for (i = lastSep + 1; i < s.length; i++) {
    if (s[i] !== 'codeseparator')
      res.push(s[i]);
  }

  return res;
};

script.checksig = function checksig(msg, sig, key) {
  var k;

  if (key.getPublic)
    key = key.getPublic();

  if (!utils.isBuffer(sig))
    return false;

  if (sig.length === 0)
    return false;

  sig = sig.slice(0, -1);

  try {
    k = bcoin.ecdsa.keyPair({ pub: key });
  } catch (e) {
    return false;
  }

  // Points at Infinity make verify() throw.
  // This specifically throws on wallet-test.js
  // where [1] is concatted to the pubkey.
  if (k.getPublic().isInfinity())
    return false;

  // Use a try catch in case there are
  // any uncaught errors for bad inputs in verify().
  try {
    return bcoin.ecdsa.verify(msg, sig, key);
  } catch (e) {
    return false;
  }
};

script.sign = function sign(msg, key, type) {
  var half = bcoin.ecdsa.n.ushrn(1);
  var sig = bcoin.ecdsa.sign(msg, key.priv);

  // Elliptic shouldn't be generating
  // negative S values.
  assert(sig.s.cmpn(0) > 0);

  // If S value is bigger than half of the
  // order of the curve, it's too damn big.
  // Subtract from the `n` order to make
  // it smaller.
  if (sig.s.cmp(half) > 0)
    sig.s = bcoin.ecdsa.n.sub(sig.s);

  // Convert to DER array
  sig = sig.toDER();

  // Add the sighash type as a single byte
  // to the signature.
  sig = sig.concat(type);

  return sig;
};

script._next = function _next(to, s, pc) {
  var depth = 0;
  var o;

  while (s[pc]) {
    o = s[pc];

    if (o === 'if' || o === 'notif')
      depth++;
    else if (o === 'else')
      depth--;
    else if (o === 'endif')
      depth--;

    if (depth < 0)
      break;

    if (depth === 0 && o === to)
      return pc;

    if (o === 'else')
      depth++;

    pc++;
  }

  return -1;
};

script.execute = function execute(data, stack, tx, index, flags, recurse) {
  var s = data.slice();

  if (!flags)
    flags = {};

  if (s.length > constants.script.maxOps)
    return false;

  var lastSep = -1;
  var pc = 0;
  var o, val;
  var if_, else_, endif;
  var v1, v2, v3, v4;
  var n, n1, n2, n3;
  var res;
  var key, sig, type, subscript, hash;
  var keys, i, j, m;
  var succ;
  var lock, threshold;
  var evalScript;

  stack.alt = stack.alt || [];

  for (pc = 0; pc < s.length; pc++) {
    o = s[pc];

    if (Array.isArray(o)) {
      if (o.length > constants.script.maxPush)
        return false;
      if (!script.checkPush(o, flags))
        return false;
      stack.push(o);
      continue;
    }

    if (o >= 1 && o <= 16) {
      stack.push([o]);
      continue;
    }

    switch (o) {
      case 'nop':
      case 'nop3':
      case 'nop4':
      case 'nop5':
      case 'nop6':
      case 'nop7':
      case 'nop8':
      case 'nop9':
      case 'nop10': {
        if (flags.discourage_nops !== false)
          return false;
        break;
      }
      case '1negate': {
        stack.push([-1]);
        break;
      }
      case 'if':
      case 'notif': {
        if (stack.length < 1)
          return false;
        val = script.bool(stack.pop());
        if (o === 'notif')
          val = !val;
        if_ = pc;
        else_ = script._next('else', s, pc);
        endif = script._next('endif', s, pc);
        // Splice out the statement blocks we don't need
        if (val) {
          if (endif === -1)
            return false;
          if (else_ === -1) {
            s.splice(endif, 1);
            s.splice(if_, 1);
          } else {
            s.splice(else_, (endif - else_) + 1);
            s.splice(if_, 1);
          }
        } else {
          if (endif === -1)
            return false;
          if (else_ === -1) {
            s.splice(if_, (endif - if_) + 1);
          } else {
            s.splice(endif, 1);
            s.splice(if_, (else_ - if_) + 1);
          }
        }
        // Subtract one since we removed the if/notif opcode
        pc--;
        break;
      }
      case 'else': {
        return false;
      }
      case 'endif': {
        return false;
      }
      case 'verify': {
        if (stack.length === 0)
          return false;
        if (!script.bool(stack.pop()))
          return false;
        break;
      }
      case 'return': {
        return false;
      }
      case 'toaltstack': {
        if (stack.length === 0)
          return false;
        stack.alt.push(stack.pop());
        break;
      }
      case 'fromaltstack': {
        if (stack.alt.length === 0)
          return false;
        stack.push(stack.alt.pop());
        break;
      }
      case 'ifdup': {
        if (stack.length === 0)
          return false;
        if (script.bool(stack[stack.length - 1]))
          stack.push(script.array(stack[stack.length - 1]));
        break;
      }
      case 'depth': {
        stack.push(script.array(stack.length));
        break;
      }
      case 'drop': {
        if (stack.length === 0)
          return false;
        stack.pop();
        break;
      }
      case 'dup': {
        if (stack.length === 0)
          return false;
        stack.push(stack[stack.length - 1]);
        break;
      }
      case 'nip': {
        if (stack.length < 2)
          return false;
        stack.splice(stack.length - 2, 1);
        break;
      }
      case 'over': {
        if (stack.length < 2)
          return false;
        stack.push(stack[stack.length - 2]);
        break;
      }
      case 'pick':
      case 'roll': {
        if (stack.length < 2)
          return false;
        val = stack.pop();
        if (val.length > 6)
          return false;
        n = script.num(val, true);
        if (n < 0 || n >= stack.length)
          return false;
        val = stack[-n - 1];
        if (o === 'roll')
          stack.splice(stack.length - n - 1, 1);
        stack.push(val);
        break;
      }
      case 'rot': {
        if (stack.length < 3)
          return false;
        v3 = stack[stack.length - 3];
        v2 = stack[stack.length - 2];
        v1 = stack[stack.length - 1];
        stack[stack.length - 3] = v2;
        stack[stack.length - 2] = v3;
        v2 = stack[stack.length - 2];
        stack[stack.length - 2] = v1;
        stack[stack.length - 1] = v2;
        break;
      }
      case 'swap': {
        if (stack.length < 2)
          return false;
        v1 = stack[stack.length - 2];
        v2 = stack[stack.length - 1];
        stack[stack.length - 2] = v2;
        stack[stack.length - 1] = v1;
        break;
      }
      case 'tuck': {
        if (stack.length < 2)
          return false;
        stack.splice(stack.length - 2, 0, stack[stack.length - 1]);
        break;
      }
      case '2drop': {
        if (stack.length < 2)
          return false;
        stack.pop();
        stack.pop();
        break;
      }
      case '2dup': {
        if (stack.length < 2)
          return false;
        v1 = stack[stack.length - 2];
        v2 = stack[stack.length - 1];
        stack.push(v1);
        stack.push(v2);
        break;
      }
      case '3dup': {
        if (stack.length < 3)
          return false;
        v1 = stack[stack.length - 3];
        v2 = stack[stack.length - 2];
        v3 = stack[stack.length - 1];
        stack.push(v1);
        stack.push(v2);
        stack.push(v3);
        break;
      }
      case '2over': {
        if (stack.length < 4)
          return false;
        v1 = stack[stack.length - 4];
        v2 = stack[stack.length - 3];
        stack.push(v1);
        stack.push(v2);
        break;
      }
      case '2rot': {
        if (stack.length < 6)
          return false;
        v1 = stack[stack.length - 6];
        v2 = stack[stack.length - 5];
        stack.splice(stack.length - 6, 2);
        stack.push(v1);
        stack.push(v2);
        break;
      }
      case '2swap': {
        if (stack.length < 4)
          return false;
        v4 = stack[stack.length - 4];
        v3 = stack[stack.length - 3];
        v2 = stack[stack.length - 2];
        v1 = stack[stack.length - 1];
        stack[stack.length - 4] = v2;
        stack[stack.length - 2] = v4;
        stack[stack.length - 3] = v1;
        stack[stack.length - 1] = v3;
        break;
      }
      case 'size': {
        if (stack.length < 1)
          return false;
        stack.push(script.array(stack[stack.length - 1].length || 0));
        break;
      }
      case '1add':
      case '1sub':
      case 'negate':
      case 'abs':
      case 'not':
      case '0notequal': {
        if (stack.length < 1)
          return false;
        n = script.num(stack.pop());
        switch (o) {
          case '1add':
            n.iadd(1);
            break;
          case '1sub':
            n.isub(1);
            break;
          case 'negate':
            n = n.neg();
            break;
          case 'abs':
            if (n.cmpn(0) < 0)
              n = n.neg();
            break;
          case 'not':
            n = n.cmpn(0) === 0;
            break;
          case '0notequal':
            n = n.cmpn(0) !== 0;
            break;
          default:
            return false;
        }
        if (typeof n === 'boolean')
          n = script.num(+n);
        stack.push(script.array(n));
        break;
      }
      case 'add':
      case 'sub':
      case 'booland':
      case 'boolor':
      case 'numequal':
      case 'numequalverify':
      case 'numnotequal':
      case 'lessthan':
      case 'greaterthan':
      case 'lessthanorequal':
      case 'greaterthanorequal':
      case 'min':
      case 'max': {
        switch (o) {
          case 'add':
          case 'sub':
          case 'booland':
          case 'boolor':
          case 'numequal':
          case 'numequalverify':
          case 'numnotequal':
          case 'lessthan':
          case 'greaterthan':
          case 'lessthanorequal':
          case 'greaterthanorequal':
          case 'min':
          case 'max':
            if (stack.length < 2)
              return false;
            n2 = script.num(stack.pop());
            n1 = script.num(stack.pop());
            n = script.num(0);
            switch (o) {
              case 'add':
                n = n1.add(n2);
                break;
              case 'sub':
                n = n1.sub(n2);
                break;
              case 'booland':
                n = n1.cmpn(0) !== 0 && n2.cmpn(0) !== 0;
                break;
              case 'boolor':
                n = n1.cmpn(0) !== 0 || n2.cmpn(0) !== 0;
                break;
              case 'numequal':
                n = n1.cmp(n2) === 0;
                break;
              case 'numequalverify':
                n = n1.cmp(n2) === 0;
                break;
              case 'numnotequal':
                n = n1.cmp(n2) !== 0;
                break;
              case 'lessthan':
                n = n1.cmp(n2) < 0;
                break;
              case 'greaterthan':
                n = n1.cmp(n2) > 0;
                break;
              case 'lessthanorequal':
                n = n1.cmp(n2) <= 0;
                break;
              case 'greaterthanorequal':
                n = n1.cmp(n2) >= 0;
                break;
              case 'min':
                n = n1.cmp(n2) < 0 ? n1 : n2;
                break;
              case 'max':
                n = n1.cmp(n2) > 0 ? n1 : n2;
                break;
              default:
                return false;
            }
            if (typeof n === 'boolean')
              n = script.num(+n);
            res = script.bool(n);
            if (o === 'numequalverify') {
              if (!res)
                return false;
            } else {
              stack.push(script.array(n));
            }
            break;
          case 'within':
            if (stack.length < 3)
              return false;
            n3 = script.num(stack.pop());
            n2 = script.num(stack.pop());
            n1 = script.num(stack.pop());
            val = n2.cmp(n1) <= 0 && n1.cmp(n3) < 0;
            stack.push(val.cmpn(0) !== 0 ? [ 1 ] : []);
            break;
        }

        break;
      }
      case 'codeseparator': {
        lastSep = pc;
        break;
      }
      case 'ripemd160': {
        if (stack.length === 0)
          return false;
        stack.push(utils.ripemd160(stack.pop()));
        break;
      }
      case 'sha1': {
        if (stack.length === 0)
          return false;
        stack.push(utils.sha1(stack.pop()));
        break;
      }
      case 'sha256': {
        if (stack.length === 0)
          return false;
        stack.push(utils.sha256(stack.pop()));
        break;
      }
      case 'hash256': {
        if (stack.length === 0)
          return false;
        stack.push(utils.dsha256(stack.pop()));
        break;
      }
      case 'hash160': {
        if (stack.length === 0)
          return false;
        stack.push(utils.ripesha(stack.pop()));
        break;
      }
      case 'equalverify':
      case 'equal': {
        if (stack.length < 2)
          return false;
        res = utils.isEqual(stack.pop(), stack.pop());
        if (o === 'equalverify') {
          if (!res)
            return false;
        } else {
          stack.push(res ? [ 1 ] : []);
        }
        break;
      }
      case 'checksigverify':
      case 'checksig': {
        if (!tx || stack.length < 2)
          return false;

        key = stack.pop();
        sig = stack.pop();

        if (!script.isValidKey(key, flags))
          return false;

        if (!script.isValidSignature(sig, flags))
          return false;

        type = sig[sig.length - 1];

        subscript = script.getSubscript(data, lastSep);
        script.removeData(subscript, sig);

        hash = tx.signatureHash(index, subscript, type);

        res = script.checksig(hash, sig, key);
        if (o === 'checksigverify') {
          if (!res)
            return false;
        } else {
          stack.push(res ? [ 1 ] : []);
        }

        break;
      }
      case 'checkmultisigverify':
      case 'checkmultisig': {
        if (!tx || stack.length < 3)
          return false;

        n = script.num(stack.pop(), true);

        if (!(n >= 1 && n <= 15))
          return false;

        if (stack.length < n + 1)
          return false;

        keys = [];
        for (i = 0; i < n; i++) {
          key = stack.pop();

          if (!script.isValidKey(key, flags))
            return false;

          keys.push(key);
        }

        m = script.num(stack.pop(), true);

        if (!(m >= 1 && m <= n))
          return false;

        if (stack.length < m + 1)
          return false;

        subscript = script.getSubscript(data, lastSep);

        for (i = 0; i < m; i++) {
          sig = stack[stack.length - 1 - i];
          script.removeData(subscript, sig);
        }

        succ = 0;
        for (i = 0, j = 0; i < m; i++) {
          sig = stack.pop();

          if (!script.isValidSignature(sig, flags))
            return false;

          type = sig[sig.length - 1];

          hash = tx.signatureHash(index, subscript, type);

          res = false;
          for (; !res && j < n; j++)
            res = script.checksig(hash, sig, keys[j]);

          if (res)
            succ++;
        }

        if (stack.length < 1)
          return false;

        val = stack.pop();

        if (flags.verifynulldummy !== false) {
          if (!script.isDummy(val))
            return false;
        }

        res = succ >= m;
        if (o === 'checkmultisigverify') {
          if (!res)
            return false;
        } else {
          stack.push(res ? [ 1 ] : []);
        }

        break;
      }
      case 'checklocktimeverify': {
        // OP_CHECKLOCKTIMEVERIFY = OP_NOP2
        if (flags.checklocktimeverify === false) {
          if (flags.discourage_nops !== false)
            return false;
          break;
        }

        if (!tx || stack.length === 0)
          return false;

        lock = stack[stack.length - 1];

        if (!Array.isArray(lock))
          return false;

        if (lock.length > 6)
          return false;

        lock = script.num(lock, true);

        if (lock < 0)
          return false;

        threshold = constants.locktimeThreshold;
        if (!(
          (tx.lock < threshold && lock < threshold)
          || (tx.lock >= threshold && lock >= threshold)
        )) {
          return false;
        }

        if (lock > tx.lock)
          return false;

        if (!tx.inputs[index] || tx.inputs[index].seq === 0xffffffff)
          return false;

        break;
      }
      case 'nop1': {
        // OP_EVAL = OP_NOP1
        if (flags['eval'] !== true) {
          if (flags.discourage_nops !== false)
            return false;
          break;
        }

        recurse = recurse || 0;

        if (recurse++ > 2)
          return false;

        evalScript = stack.pop();

        if (!Array.isArray(evalScript))
          return false;

        evalScript = script.decode(evalScript);

        res = evalScript.some(function(op) {
          return op === 'codeseparator';
        });

        if (res)
          return false;

        res = script.execute(evalScript, stack, tx, index, flags, recurse);
        if (!res)
          return false;

        break;
      }
      default: {
        // Unknown operation
        utils.debug('Unknown opcode "%s" at offset %d', o, pc);
        return false;
      }
    }
  }

  if (stack.length + stack.alt.length > constants.script.maxStack)
    return false;

  return true;
};

script.bool = function bool(value) {
  var i;

  // Should never happen:
  // if (typeof value === 'boolean')
  //   return value;

  // Should never happen:
  // if (utils.isFinite(value))
  //   return value !== 0;

  if (value instanceof bn)
    return value.cmpn(0) !== 0;

  assert(utils.isBuffer(value));

  for (i = 0; i < value.length; i++) {
    if (value[i] !== 0) {
      // Cannot be negative zero
      if (i === value.length - 1 && value[i] === 0x80)
        return false;
      return true;
    }
  }

  return false;
};

script.num = function num(value, useNum, minimaldata) {
  if (utils.isFinite(value))
    return useNum ? value : new bn(value, 'le');

  // Should never happen:
  // if (value instanceof bn)
  //   return useNum ? value.toNumber() : value;

  assert(utils.isBuffer(value));

  if (minimaldata && value.length > 0) {
    // If the low bits on the last byte are unset,
    // fail if The value's second to last byte does
    // not have the high bit set. A number can't
    // justify having the last byte's low bits unset
    // unless they ran out of space for the sign bit
    // in the second to last bit. We also fail on [0]
    // to avoid negative zero (also avoids positive
    // zero).
    if (!(value[value.length - 1] & 0x7f)) {
      if (value.length === 1 || !(value[value.length - 2] & 0x80)) {
        // We should technically fail here by
        // throwing and catching, but return zero for now.
        return useNum ? 0 : new bn(0, 'le');
      }
    }
  }

  // Optimize by avoiding big numbers
  if (useNum && value.length <= 1)
    return value.length === 0 ? 0 : value[0];

  // If we are signed, do (~num + 1) to get
  // the positive counterpart and set bn's
  // negative flag.
  if (value[value.length - 1] & 0x80) {
    if (utils.isNegZero(value, 'le')) {
      value = new bn(0, 'le');
    } else {
      value = new bn(value, 'le').notn(64).addn(1).neg();
    }
  } else {
    value = new bn(value, 'le');
  }

  if (useNum) {
    try {
      return value.toNumber();
    } catch (e) {
      return 0;
    }
  }

  return value;
};

script.array = function(value) {
  if (Array.isArray(value))
    return value.slice();

  if (utils.isFinite(value))
    value = new bn(value, 'le');

  assert(value instanceof bn);

  // Convert the number to the
  // negative byte representation.
  if (value.isNeg()) {
    if (value.cmpn(0) === 0)
      value = new bn(0);
    else
      value = value.neg().notn(64).addn(1);
  }

  if (value.cmpn(0) === 0)
    return [];

  return value.toArray('le');
};

script.removeData = function removeData(s, data) {
  for (var i = s.length - 1; i >= 0; i--) {
    if (utils.isEqual(s[i], data))
      s.splice(i, 1);
  }
};

script.checkPush = function checkPush(op, value, flags) {
  if (!flags)
    flags = {};

  if (flags.minimaldata === false)
    return true;

  if (!op.pushdata)
    return true;

  op = op.pushdata.opcode || op.pushdata.len;

  if (value.length === 1 && value[0] === 0)
    return op === '0';

  if (value.length === 1 && value[0] >= 1 && value[0] <= 16)
    return +op >= 1 && +op <= 16;

  if (value.length === 1 && value[0] === -1)
    return op === '1negate';

  if (value.length <= 75)
    return op === value.length;

  if (value.length <= 255)
    return op === 'pushdata1';

  if (value.length <= 65535)
    return op === 'pushdata2';

  return true;
};

script.createMultisig = function createMultisig(keys, m, n) {
  if (keys.length !== n)
    throw new Error(n + ' keys are required to generate multisig script');

  assert(m >= 1 && m <= n);
  assert(n >= 1 && n <= 15);

  return [m].concat(
    utils.sortKeys(keys),
    [n, 'checkmultisig']
  );
};

script.createScripthash = function createScripthash(s) {
  assert(Array.isArray(s));
  return [
    'hash160',
    utils.ripesha(script.encode(s)),
    'equal'
  ];
};

script.getRedeem = function getRedeem(s) {
  if (!Array.isArray(s[s.length - 1]))
    return;

  return bcoin.script.decode(s[s.length - 1]);
};

script.getType = function getType(s) {
  return (script.isPubkey(s) && 'pubkey')
    || (script.isPubkeyhash(s) && 'pubkeyhash')
    || (script.isMultisig(s) && 'multisig')
    || (script.isScripthash(s) && 'scripthash')
    || (script.isNulldata(s) && 'nulldata')
    || 'unknown';
};

script.isStandard = function isStandard(s) {
  var m, n;

  if (script.isMultisig(s)) {
    m = s[0];
    n = s[s.length - 2];

    if (n < 1 || n > 3)
      return false;

    if (m < 1 || m > n)
      return false;
  } else if (script.isNulldata(s)) {
    if (script.size(s) > constants.script.maxOpReturnBytes)
      return false;
  }

  return type != null;
};

script.size = function size(s) {
  if (s._raw)
    return s._raw.length;
  return script.encode(s).length;
};

script.isEncoded = function isEncoded(s) {
  var i, b;

  if (!Array.isArray(data))
    return false;

  for (i = 0; i < data.length; i++) {
    b = data[i];

    if (typeof b !== 'number')
      return false;

    if (constants.opcodesByVal[b] == null) {
      if (b >= 0x01 && b <= 0x4b)
        continue;
      return false;
    }
  }

  return true;
};

script._lockTime = function _lockTime(s) {
  var i;

  if (s.length < 2)
    return;

  for (i = 0; i < s.length; i++) {
    if (Array.isArray(s[i]) && s[i + 1] === 'checklocktimeverify')
      return s[i];
  }
};

script.isLockTime = function isLockTime(s) {
  return script._lockTime(s) != null;
};

script.getLockTime = function getLockTime(s) {
  var lockTime = script._lockTime(s);

  if (!lockTime)
    return 0;

  return script.num(lockTime, true);
};

script.getInputData = function getData(s, prev) {
  var output, type;

  if (prev) {
    output = script.getOutputData(prev);
    output.side = 'input';

    // We could call _getInputData, but
    // we really only need the signatures.
    if (output.type === 'pubkey') {
      output.signatures = [s[0]];
    } else if (output.type === 'pubkeyhash') {
      output.signatures = [s[0]];
      output.keys = [s[1]];
    } else if (output.type === 'multisig') {
      output.signatures = s.slice(1);
    } else if (output.type === 'scripthash') {
      // Scripthash is the only case where
      // we get more data from the input
      // than the output.
      output = script._getInputData(s, output.type);
    } else {
      output.signatures = script.getUnknownData(s).signatures;
    }

    return output;
  }

  if (script.isPubkeyInput(s))
    type = 'pubkey';
  else if (script.isPubkeyhashInput(s))
    type = 'pubkeyhash';
  else if (script.isMultisigInput(s))
    type = 'multisig';
  else if (script.isScripthashInput(s))
    type = 'scripthash';
  else
    type = 'unknown';

  return script._getInputData(s, type);
};

script._getInputData = function _getInputData(s, type) {
  var sig, key, hash, raw, redeem, lock, hash, address, input, output;

  assert(typeof type === 'string');

  if (type === 'pubkey') {
    sig = s[0];
    return {
      type: 'pubkey',
      side: 'input',
      signatures: [sig],
      none: true
    };
  }

  if (type === 'pubkeyhash') {
    sig = s[0];
    key = s[1];
    hash = bcoin.wallet.key2hash(key);
    address = bcoin.wallet.hash2addr(hash, 'pubkeyhash');
    return {
      type: 'pubkeyhash',
      side: 'input',
      signatures: [sig],
      keys: [key],
      hashes: [hash],
      addresses: [address]
    };
  }

  if (type === 'multisig') {
    sig = s.slice(1);
    return {
      type: 'multisig',
      side: 'input',
      signatures: sig,
      m: sig.length,
      none: true
    };
  }

  if (type === 'scripthash') {
    raw = s[s.length - 1];
    redeem = script.decode(raw);
    lock = script.getLockTime(redeem);
    hash = bcoin.wallet.key2hash(raw);
    address = bcoin.wallet.hash2addr(hash, 'scripthash');
    output = script.getOutputData(script.getSubscript(redeem));
    input = script._getInputData(s.slice(0, -1), output.type);
    delete input.none;
    return utils.merge(input, output, {
      type: 'scripthash',
      side: 'input',
      subtype: output.type,
      redeem: redeem,
      scripthash: hash,
      scriptaddress: address,
      lock: lock
    });
  }

  return script.getUnknownData(s);
};

script.getOutputData = function getOutputData(s) {
  var key, hash, address;

  if (script.isPubkey(s)) {
    key = s[0];
    hash = bcoin.wallet.key2hash(key);
    address = bcoin.wallet.hash2addr(hash, 'pubkey');
    return {
      type: 'pubkey',
      side: 'output',
      keys: [key],
      hashes: [hash],
      addresses: [address]
    };
  }

  if (script.isPubkeyhash(s)) {
    hash = s[2];
    return {
      type: 'pubkeyhash',
      side: 'output',
      hashes: [hash],
      addresses: [bcoin.wallet.hash2addr(hash, 'pubkeyhash')]
    };
  }

  if (script.isMultisig(s)) {
    key = s.slice(1, -2);
    hash = key.map(function(key) {
      return bcoin.wallet.key2hash(key);
    });
    address = hash.map(function(hash) {
      return bcoin.wallet.hash2addr(hash, 'multisig');
    });
    return {
      type: 'multisig',
      side: 'output',
      keys: key,
      hashes: hash,
      addresses: address,
      m: s[0],
      n: s[s.length - 2]
    };
  }

  if (script.isScripthash(s)) {
    hash = s[1];
    return {
      type: 'scripthash',
      side: 'output',
      scripthash: hash,
      scriptaddress: bcoin.wallet.hash2addr(hash, 'scripthash')
    };
  }

  if (script.isNulldata(s)) {
    return {
      type: 'nulldata',
      side: 'output',
      nulldata: s[1],
      text: utils.array2utf8(s[1])
    };
  }

  return script.getUnknownData(s);
};

script.getUnknownData = function getUnknownData(s) {
  var sig = [];
  var key = [];
  var hash, address, i;

  for (i = 0; i < s.length; i++) {
    if (script.isSignatureEncoding(s[i]))
      sig.push(s[i]);
    else if (script.isKeyEncoding(s[i]))
      key.push(s[i]);
  }

  hash = key.map(function(key) {
    return bcoin.wallet.key2hash(key);
  });

  address = hash.map(function(hash) {
    return bcoin.wallet.hash2addr(hash, 'pubkey');
  });

  return {
    type: 'unknown',
    signatures: sig,
    keys: key,
    hashes: hash,
    addresses: address,
    none: key.length === 0
  };
};

script.isPubkey = function isPubkey(s, key) {
  var res;

  if (s.length !== 2)
    return false;

  res = script.isKey(s[0]) && s[1] === 'checksig';

  if (!res)
    return false;

  if (key) {
    if (!utils.isEqual(s[0], key))
      return false;
  }

  return s[0];
};

script.isPubkeyhash = function isPubkeyhash(s, hash) {
  var res;

  if (s.length !== 5)
    return false;

  res = s[0] === 'dup'
    && s[1] === 'hash160'
    && script.isHash(s[2])
    && s[3] === 'equalverify'
    && s[4] === 'checksig';

  if (!res)
    return false;

  if (hash) {
    if (!utils.isEqual(s[2], hash))
      return false;
  }

  return s[2];
};

script.isMultisig = function isMultisig(s, keys) {
  var m, n, i, j;
  var total = 0;

  if (s.length < 4)
    return false;

  if (s[s.length - 1] !== 'checkmultisig')
    return false;

  n = s[s.length - 2];

  if (Array.isArray(n)) {
    if (n.length !== 0)
      return false;
    n = 0;
  }

  if (typeof n !== 'number')
    return false;

  // Bitcoind technically doesn't check for the
  // 15 limit here. It just counts the sigops
  // later.
  if (!(n >= 1 && n <= 15))
    return false;

  m = s[0];

  if (Array.isArray(m)) {
    if (m.length !== 0)
      return false;
    m = 0;
  }

  if (typeof m !== 'number')
    return false;

  if (!(m >= 1 && m <= n))
    return false;

  if (n + 3 !== s.length)
    return false;

  for (i = 1; i < n + 1; i++) {
    if (!script.isKey(s[i]))
      return false;
  }

  if (keys) {
    for (i = 1; i < n + 1; i++) {
      for (j = 0; j < keys.length; j++) {
        if (utils.isEqual(s[i], keys[j])) {
          total++;
          break;
        }
      }
    }

    if (total !== n)
      return false;
  }

  return {
    keys: s.slice(1, n + 1),
    m: m,
    n: n
  };
};

script.isScripthash = function isScripthash(s, hash) {
  var res;

  if (s.length !== 3)
    return false;

  res = s[0] === 'hash160'
    && script.isHash(s[1])
    && s[2] === 'equal';

  if (!res)
    return false;

  if (hash) {
    if (!utils.isEqual(s[1], hash))
      return false;
  }

  return s[1];
};

script.isNulldata = function isNulldata(s) {
  var res;

  if (s.length !== 2)
    return false;

  res = s[0] === 'return' && script.isData(s[1]);

  if (!res)
    return false;

  return s[1];
};

script.getInputType = function getInputType(s) {
  return (script.isPubkeyInput(s) && 'pubkey')
    || (script.isPubkeyhashInput(s) && 'pubkeyhash')
    || (script.isMultisigInput(s) && 'multisig')
    || (script.isScripthashInput(s) && 'scripthash')
    || null;
};

script.isPubkeyInput = function isPubkeyInput(s, key, tx, i) {
  if (s.length !== 1)
    return false;

  if (!script.isSignature(s[0]))
    return false;

  // Execute the script against our key's
  // checksig script to see if this is our input.
  // This will only work if the script verifies.
  if (key) {
    assert(tx);
    assert(i != null);
    if (!script.verify(s, [key, 'checksig'], tx, i))
      return false;
  }

  return s[0];
};

script.isPubkeyhashInput = function isPubkeyhashInput(s, key) {
  if (s.length !== 2)
    return false;

  if (!script.isSignature(s[0]))
    return false;

  if (!script.isKey(s[1]))
    return false;

  if (key) {
    if (!utils.isEqual(s[1], key))
      return false;
  }

  return s[1];
};

script.isMultisigInput = function isMultisigInput(s, keys, tx, i) {
  var i, o;

  // We need to rule out scripthash because
  // it may look like multisig. This is
  // strange because it's technically a
  // recursive call.
  if (script.isScripthashInput(s))
    return false;

  if (s.length < 3)
    return false;

  if (!Array.isArray(s[0]) || s[0].length !== 0)
    return false;

  for (i = 1; i < s.length; i++) {
    if (!script.isSignature(s[i]))
      return false;
  }

  // Execute the script against our pubkeys'
  // redeem script to see if this is our input.
  // This will only work if the script verifies.
  if (keys) {
    assert(keys.length >= 2);
    assert(tx);
    assert(i != null);
    o = script.createMultisig(keys, s.length - 1, keys.length);
    if (!script.verify(s, o, tx, i))
      return false;
  }

  // We also also try to recover the keys from the signatures.
  // var recovered = [];
  // for (i = 1; i < s.length; i++) {
  //   var sig = s[i];
  //   var prev = script.createMultisig(keys, s.length - 1, keys.length);
  //   var msg = tx.signatureHash(i, prev, s[s.length - 1]);
  //   var key = bcoin.ecdsa.recoverPubKey(msg, sig.slice(0, -1), 0).toArray();
  //   recovered.push(key);
  // }

  return {
    signatures: s.slice(1),
    m: s.length - 1
  };
};

script.isScripthashInput = function isScripthashInput(s, data, strict) {
  var raw, redeem;

  // Grab the raw redeem script.
  raw = s[s.length - 1];

  // Need at least one data element with
  // the redeem script.
  if (s.length < 2)
    return false;

  // Last data element should be an array
  // for the redeem script.
  if (!Array.isArray(raw))
    return false;

  // If the last data element is a valid
  // signature or key, it's _extremely_
  // unlikely this is a scripthash.
  if (script.isSignatureEncoding(raw))
    return false;

  if (script.isKeyEncoding(raw))
    return false;

  // Ensure this is a valid encoded script
  // if (!script.isEncoded(raw))
  //   return false;

  // Check data against last array in case
  // a raw redeem script was passed in.
  if (data && utils.isEqual(data, raw))
    return raw;

  // Return here if we do not want to check
  // against standard transaction types.
  if (!strict)
    return raw;

  // P2SH redeem scripts can be nonstandard: make
  // it easier for other functions to parse this.
  redeem = script.getSubscript(script.decode(raw));

  // Get the "real" scriptSig
  s = s.slice(0, -1);

  // Do some sanity checking on the inputs
  if (!script.isPubkeyInput(s)
    && !script.isPubkeyhashInput(s)
    && !script.isMultisigInput(s)) {
    return false;
  }

  // Test against all other script types
  if (!script.isPubkey(redeem, data)
    && !script.isPubkeyhash(redeem, data)
    && !script.isMultisig(redeem, data)) {
    return false;
  }

  return raw;
};

script.getCoinbaseData = function getCoinbaseData(s) {
  var coinbase, flags;

  coinbase = {
    script: s
  };

  if (Array.isArray(s[0]))
    coinbase.height = script.num(s[0], true);
  else
    coinbase.height = -1;

  if (Array.isArray(s[1]))
    coinbase.extraNonce = script.num(s[1]);
  else
    coinbase.extraNonce = script.num(0);

  flags = s.slice(2).filter(function(chunk) {
    return Array.isArray(chunk) && chunk.length !== 0;
  });

  coinbase.flags = flags;
  coinbase.text =
    flags.map(utils.array2utf8).join('')
    .replace(/[\u0000-\u0019\u007f-\u00ff]/g, '');

  return coinbase;
};

// Detect script array types. Note: these functions
// are not mutually exclusive. Only use for
// verification, not detection.

script.isHash = function isHash(hash) {
  if (!utils.isBuffer(hash))
    return false;

  return hash.length === 20;
};

script.isKey = function isKey(key) {
  if (!utils.isBuffer(key))
    return false;

  return key.length >= 33 && key.length <= 65;
};

script.isSignature = function isSignature(sig) {
  if (!utils.isBuffer(sig))
    return false;

  return sig.length >= 9 && sig.length <= 73;
};

script.isDummy = function isDummy(data) {
  if (!utils.isBuffer(data))
    return false;

  return data.length === 0;
};

script.isData = function isData(data) {
  if (!utils.isBuffer(data))
    return false;

  return data.length <= constants.script.maxOpReturn;
};

script.isValidKey = function isValidKey(key, flags) {
  if (!flags)
    flags = {};

  if (!utils.isBuffer(key))
    return false;

  if (flags.strictenc !== false) {
    if (!script.isKeyEncoding(key))
      return false;
  }

  return true;
};

script.isKeyEncoding = function isKeyEncoding(key) {
  if (!utils.isBuffer(key))
    return false;

  if (key.length < 33)
    return false;

  if (key[0] === 0x04) {
    if (key.length !== 65)
      return false;
  } else if (key[0] === 0x02 || key[0] === 0x03) {
    if (key.length !== 33)
      return false;
  } else {
    return false;
  }

  return true;
};

script.isValidSignature = function isValidSignature(sig, flags) {
  if (!flags)
    flags = {};

  if (!utils.isBuffer(sig))
    return false;

  // Allow empty sigs
  if (sig.length === 0)
    return true;

  if (flags.dersig !== false
      || flags.low_s !== false
      || flags.strictenc !== false) {
    if (!script.isSignatureEncoding(sig))
      return false;
  }

  if (flags.low_s !== false) {
    if (!script.isLowDER(sig))
      return false;
  }

  if (flags.strictenc !== false) {
    if (!script.isHashType(sig))
      return false;
  }

  return true;
};

// https://github.com/bitcoin/bips/blob/master/bip-0066.mediawiki
/**
 * A canonical signature exists of: <30> <total len> <02> <len R> <R> <02> <len S> <S> <hashtype>
 * Where R and S are not negative (their first byte has its highest bit not set), and not
 * excessively padded (do not start with a 0 byte, unless an otherwise negative number follows,
 * in which case a single 0 byte is necessary and even required).
 *
 * See https://bitcointalk.org/index.php?topic=8392.msg127623#msg127623
 *
 * This function is consensus-critical since BIP66.
 */
script.isSignatureEncoding = function isSignatureEncoding(sig) {
  var lenR, lenS;

  if (!utils.isBuffer(sig))
    return false;

  // Format: 0x30 [total-length] 0x02 [R-length] [R] 0x02 [S-length] [S] [sighash]
  // * total-length: 1-byte length descriptor of everything that follows,
  //   excluding the sighash byte.
  // * R-length: 1-byte length descriptor of the R value that follows.
  // * R: arbitrary-length big-endian encoded R value. It must use the shortest
  //   possible encoding for a positive integers (which means no null bytes at
  //   the start, except a single one when the next byte has its highest bit set).
  // * S-length: 1-byte length descriptor of the S value that follows.
  // * S: arbitrary-length big-endian encoded S value. The same rules apply.
  // * sighash: 1-byte value indicating what data is hashed (not part of the DER
  //   signature)

  // Minimum and maximum size constraints.
  if (sig.length < 9)
    return false;

  if (sig.length > 73)
    return false;

  // A signature is of type 0x30 (compound).
  if (sig[0] !== 0x30)
    return false;

  // Make sure the length covers the entire signature.
  if (sig[1] !== sig.length - 3)
    return false;

  // Extract the length of the R element.
  lenR = sig[3];

  // Make sure the length of the S element is still inside the signature.
  if (5 + lenR >= sig.length)
    return false;

  // Extract the length of the S element.
  lenS = sig[5 + lenR];

  // Verify that the length of the signature matches the sum of the length
  // of the elements.
  if (lenR + lenS + 7 !== sig.length)
    return false;

  // Check whether the R element is an integer.
  if (sig[2] !== 0x02)
    return false;

  // Zero-length integers are not allowed for R.
  if (lenR === 0)
    return false;

  // Negative numbers are not allowed for R.
  if (sig[4] & 0x80)
    return false;

  // Null bytes at the start of R are not allowed, unless R would
  // otherwise be interpreted as a negative number.
  if (lenR > 1 && (sig[4] === 0x00) && !(sig[5] & 0x80))
    return false;

  // Check whether the S element is an integer.
  if (sig[lenR + 4] !== 0x02)
    return false;

  // Zero-length integers are not allowed for S.
  if (lenS === 0)
    return false;

  // Negative numbers are not allowed for S.
  if (sig[lenR + 6] & 0x80)
    return false;

  // Null bytes at the start of S are not allowed, unless S would otherwise be
  // interpreted as a negative number.
  if (lenS > 1 && (sig[lenR + 6] === 0x00) && !(sig[lenR + 7] & 0x80))
    return false;

  return true;
};

script.isHashType = function isHashType(sig) {
  if (!utils.isBuffer(sig))
    return false;

  if (sig.length === 0)
    return false;

  type = sig[sig.length - 1] & ~constants.hashType.anyonecanpay;

  if (!constants.hashTypeByVal[type])
    return false;

  return true;
};

script.isLowDER = function isLowDER(sig) {
  var half = bcoin.ecdsa.n.ushrn(1);

  if (!sig.s) {
    if (!utils.isBuffer(sig))
      return false;

    if (!script.isSignatureEncoding(sig))
      return false;

    try {
      sig = new bcoin.signature(sig.slice(0, -1));
    } catch (e) {
      return false;
    }
  }

  // Technically a negative S value is low,
  // but we don't want to ever use negative
  // S values in bitcoin.
  if (sig.s.cmpn(0) <= 0)
    return false;

  // If S is greater than half the order,
  // it's too high.
  if (sig.s.cmp(half) > 0)
    return false;

  return true;
};

script.format = function format(input, output) {
  var scripts = [];
  var prev, redeem;

  if (Array.isArray(input)) {
    scripts.push(input);
  } else if (Array.isArray(output)) {
    scripts.push(output);
  } else if (input) {
    scripts.push(input.script);
    if (input.out.tx && input.out.tx.outputs[input.out.index]) {
      prev = input.out.tx.outputs[input.out.index].script;
      scripts.push(prev);
      if (script.isScripthash(prev)) {
        redeem = script.decode(input.script[input.script.length - 1]);
        scripts.push(redeem);
      }
    }
  } else if (output) {
    scripts.push(output.script);
  }

  scripts = scripts.map(function(script) {
    return script.map(function(chunk) {
      if (Array.isArray(chunk)) {
        if (chunk.length === 0)
          return 0 + '';
        return '[' + utils.toHex(chunk) + ']';
      }
      if (typeof chunk === 'number')
        return chunk + '';
      return chunk;
    }).join(' ');
  });

  return scripts;
};

script.isPushOnly = function isPushOnly(s) {
  var i, op;
  for (i = 0; i < s.length; i++) {
    op = s[i];
    if (Array.isArray(op) || op === '1negate' || (op >= 1 && op <= 16))
      continue;
    if (constants.opcodes[op] == null)
      return false;
    return false;
  }
  return true;
};

script.getSigops = function getSigops(s, accurate) {
  var i, op;
  var n = 0;
  var lastOp = -1;

  for (i = 0; i < s.length; i++) {
    op = s[i];
    if (Array.isArray(op))
      continue;
    if (constants.opcodes[op] == null)
      return 0;
    if (op === 'checksig' || op === 'checksigverify') {
      n++;
    } else if (op === 'checkmultisig' || op === 'checkmultisigverify') {
      if (accurate && lastOp >= 1 && lastOp <= 16) {
        n += lastOp;
      } else {
        n += constants.script.maxPubkeysPerMultisig;
      }
    }
    lastOp = op;
  }

  return n;
};

script.getScripthashSigops = function getScripthashSigops(s) {
  if (!script.isScripthashInput(s))
    return 0;

  if (!script.isPushOnly(s))
    return 0;

  s = script.getSubscript(script.decode(s[s.length - 1]));

  return script.getSigops(s, true);
};

script.getArgs = function getArgs(s) {
  var keys, m;

  if (script.isPubkey(s))
    return 1;

  if (script.isPubkeyhash(s))
    return 2;

  if (script.isMultisig(s)) {
    keys = s.slice(1, -2);
    if (!pub)
      return -1;
    m = s[0];
    if (keys.length < 1 || m < 1)
      return -1;
    return m + 1;
  }

  if (script.isScripthash(s))
    return 1;

  if (script.isNulldata(s))
    return -1;

  return -1;
};
