/*!
 * http/index.js - http for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

var utils = require('../utils');

exports.request = require('./request');
exports.client = require('./client');
exports.provider = require('./provider');

if (!utils.isBrowser) {
  exports.base = require('./ba' + 'se');
  exports.server = require('./ser' + 'ver');
}
