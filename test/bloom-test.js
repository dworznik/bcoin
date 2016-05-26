var bcoin = require('../').set('main');
var utils = bcoin.utils;
var constants = bcoin.protocol.constants;
var assert = require('assert');

describe('Bloom', function() {
  this.timeout(20000);

  var filterHex = ''
    + '000000000000000000000000000000000000000000000000088004000000000000000'
    + '000000000200000000000000000000000000000000800000000000000000002000000'
    + '000000000000002000000000000000000000000000000000000000000040000200000'
    + '0000000001000000800000080000000';

  it('should do proper murmur3', function() {
    var murmur3 = bcoin.bloom.murmur3;
    assert.equal(murmur3(new Buffer('', 'ascii'), 0), 0);
    assert.equal(murmur3(new Buffer('', 'ascii'), 0xfba4c795), 0x6a396f08);
    assert.equal(murmur3(new Buffer('00', 'ascii'), 0xfba4c795), 0x2a101837);
    assert.equal(murmur3(new Buffer('hello world', 'ascii'), 0), 0x5e928f0f);
  });

  it('should test and add stuff', function() {
    var b = new bcoin.bloom(512, 10, 156);

    b.add('hello', 'ascii');
    assert(b.test('hello', 'ascii'));
    assert(!b.test('hello!', 'ascii'));
    assert(!b.test('ping', 'ascii'));

    b.add('hello!', 'ascii');
    assert(b.test('hello!', 'ascii'));
    assert(!b.test('ping', 'ascii'));

    b.add('ping', 'ascii');
    assert(b.test('ping', 'ascii'));
  });

  it('should serialize to the correct format', function() {
    var filter = new bcoin.bloom(952, 6, 3624314491, constants.filterFlags.NONE);
    var item1 = '8e7445bbb8abd4b3174d80fa4c409fea6b94d96b';
    var item2 = '047b00000078da0dca3b0ec2300c00d0ab4466ed10'
      + 'e763272c6c9ca052972c69e3884a9022084215e2eef'
      + '0e6f781656b5d5a87231cd4349e534b6dea55ad4ff55e';
    filter.add(item1, 'hex');
    filter.add(item2, 'hex');
    assert.equal(filter.filter.toString('hex'), filterHex);
  });

  it('should test regular filter', function() {
    var filter = bcoin.bloom.fromRate(210000, 0.00001, -1);
    filter.tweak = 0xdeadbeef;
    // ~1m operations
    for (var i = 0; i < 1000; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true);
        assert(filter.test(str + '-', 'ascii') === false);
      } while (j--);
    }
  });

  it('should test rolling filter', function() {
    var filter = new bcoin.bloom.rolling(210000, 0.00001);
    filter.tweak = 0xdeadbeef;
    // ~1m operations
    for (var i = 0; i < 1000; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true);
        assert(filter.test(str + '-', 'ascii') === false);
      } while (j--);
    }
  });

  it('should handle rolling generations', function() {
    var filter = new bcoin.bloom.rolling(50, 0.00001);
    filter.tweak = 0xdeadbeee;
    for (var i = 0; i < 25; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true);
        assert(filter.test(str + '-', 'ascii') === false);
      } while (j--);
    }
    for (var i = 25; i < 50; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true, str);
        assert(filter.test(str + '-', 'ascii') === false, str);
      } while (j--);
    }
    for (var i = 50; i < 75; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true, str);
        assert(filter.test(str + '-', 'ascii') === false, str);
      } while (j--);
    }
    for (var i = 75; i < 100; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true, str);
        assert(filter.test(str + '-', 'ascii') === false, str);
      } while (j-- > 25);
      assert(filter.test('foobar 24', 'ascii') === false);
    }
    for (var i = 100; i < 125; i++) {
      var str = 'foobar' + i;
      filter.add(str, 'ascii');
      var j = i;
      do {
        var str = 'foobar' + j;
        assert(filter.test(str, 'ascii') === true, str);
        assert(filter.test(str + '-', 'ascii') === false, str);
      } while (j-- > 50);
    }
    assert(filter.test('foobar 49', 'ascii') === false);
  });
});
