/****************************************************************************
 The MIT License (MIT)

 Copyright (c) 2013 Apigee Corporation

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
'use strict';

var assert = require('assert');
var Quota = require('./quota');
var _ = require('underscore');

/*
 * options.bufferSize (Number) optional, use a memory buffer up to bufferSize to hold quota elements
 * options.bufferTimeout (Number) optional, flush the buffer every Number ms (default: 300)
 */

// todo: update clockOffset & bucket expires occasionally to account for clock drift?
// todo: after failure, only fail locally (no flush to remote) until end of time bucket?

var create = function(spi, options) {
  return new MemoryBuffer(spi, options);
};
module.exports.create = create;

function MemoryBuffer(spi, options) {
  this.spi = spi;
  this.options = options;
  this.buckets = {};
  this.clockOffset;

  assert(options.timeInterval);
  if (options.startTime) {
    assert.equal(typeof options.startTime, 'number');
  }

  var self = this;
  self.bucketTimer = setInterval(function() {
    trimTokens(self);
  }, options.timeInterval);

  if (options.bufferTimeout) {
    self.flushTimer = setInterval(function() {
      self.flushBuffer();
    }, options.bufferTimeout);
  }
}

MemoryBuffer.prototype.destroy = function() {
  clearTimeout(this.bucketTimer);
  clearTimeout(this.flushTimer);
  this.spi.destroy();
};

MemoryBuffer.prototype.apply = function(options, cb) {

  var bucket = this.buckets[options.identifier];
  var newBucket = !bucket;
  var now = _.now();

  if (!bucket) {
    bucket = new Bucket(now, options, this);
    this.buckets[options.identifier] = bucket;

    bucket.flushBucket(function(err, reply) { // sync count (and possibly time) with remote
      if (err) { return cb(err); }
      bucket.apply(now, options, cb);
    });
  } else {
    bucket.apply(now, options, cb);
  }
};

MemoryBuffer.prototype.flushBuffer = function() {
  _.each(this.buckets, function(bucket) {
    bucket.flushBucket();
  });
};

/*
 * Quotas always obey their expiration times (which prevents us from having to register a huge
 * number of individual timeouts) but we still want to periodically clean them up to prevent memory
 * issues. This job runs once per time interval (minute, hour, day, or week) and removes expired tokens.
 */
function trimTokens(self) {
  var now = new Date().getTime();
  for (var b in Object.keys(self.buckets)) {
    if (now > b.expires) {
      delete self.buckets.b;
    }
  }
}

function Bucket(time, options, owner) {
  this.options = options;
  this.owner = owner;
  this.reset(time);
}

Bucket.prototype.reset = function(time) {
  if (debugEnabled) { debug('bucket reset'); }
  this.count = 0;
  this.resetAt = time;
  this.expires = undefined;
  this.remoteCount = 0;
  this.remoteExpires = undefined;
  this.flushing = false;
};

Bucket.prototype.calculateExpiration = function() {
  var time = this.resetAt + this.owner.clockOffset;

  var startTime = this.owner.options.startTime;
  var timeInterval = this.owner.options.timeInterval;

  if (startTime) {
    // "calendar" start quota -- calculate time until the end of the bucket
    var remaining = (time - startTime) % timeInterval;
    this.expires = time + timeInterval - remaining;

  } else {
    // Default quota type -- start counting from now
    this.expires = time + timeInterval;
  }
};

Bucket.prototype.apply = function(time, options, cb) {
  if (time > this.expires) {
    this.reset(_.now()); // Quota bucket has expired. The timer also runs but only periodically
  }

  this.count += options.weight;

  var allow = options.allow || this.options.allow;

  var count = this.count + this.remoteCount;
  var result = {
    allowed: allow,
    used: count,
    isAllowed: (count <= allow),
    expiryTime: this.expires
  };

  cb(null, result);

  if (this.count > this.options.bufferSize) {
    this.flushBucket(); // async
  }
};

Bucket.prototype.flushBucket = function(cb) {
  if (this.flushing || (!this.count && this.remoteExpires)) { return cb ? cb() : null; }

  var localExpires = this.expires;
  var remoteExpires = this.remoteExpires;
  var options = {
    identifier: this.options.identifier,
    weight: this.count
  };
  var self = this;
  self.flushing = true;
  self.owner.spi.apply(options, function(err, reply) {
    self.flushing = false;
    if (err) { return (cb) ? cb(err) : console.log(err); }

    // sync time with remote if never been synced
    if (self.owner.clockOffset === undefined) {
      if (!reply.timestamp) {
        console.log('Warning: Quota spi not reporting timestamp. Buffer assuming spi timestamp is identical.');
      }
      var offset = reply.timestamp ? reply.timestamp - _.now() : 0;
      self.owner.clockOffset = offset;
      if (debugEnabled) { debug('clockOffset: ' + offset); }
    }

    var sameTimeBucket = (self.expires === localExpires) &&                        // same local time bucket?
                         (!remoteExpires || remoteExpires === self.remoteExpires); // same remote time bucket?
    if (debugEnabled && !sameTimeBucket) { debug('new time bucket'); }
    if (!sameTimeBucket) { return cb ? cb() : null; }

    self.remoteExpires = reply.expiryTime;
    self.remoteCount = reply.used;
    self.count -= options.weight; // subtract applied value

    // if it wasn't set because offset wasn't available, calc expiration
    if (!self.expires) { self.calculateExpiration(); }

    if (cb) { cb(null); }
  });
};

var debug;
var debugEnabled;
if (process.env.NODE_DEBUG && /apigee/.test(process.env.NODE_DEBUG)) {
  debug = function(x) {
    console.log('Apigee: ' + x);
  };
  debugEnabled = true;
} else {
  debug = function() { };
}