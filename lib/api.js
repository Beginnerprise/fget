/********************************************************************
 * Libraries - Why we need 'em
 ********************************************************************/
// Centralized Configs
var config = require('../config/config.js');
// Controllable Log Levels
var log = require('iphb-logs');
// File System access
var fs = require('fs');
// Path agostic'ness
var path = require('path');
// Operating system information for Agent
var os = require('os');
// Higher level request object - Events
var request = require('request');

/********************************************************************
 * Privates
 ********************************************************************/

// Globals
var state = {};
state.totalOfBytesDownloadedFromServer = 0;
state.totalSizeOfFile = 0;
state.downloadStartEpoch = null;
state.lastSpeedInBytes = 0;
state.avgSpeedInBytes = 0;
state.chunksCompleted = 0;
_cancel = false;

/**
 * @private
 * @function    _getRateWithUnits
 * @description Given a number of bytes, convert the result
 *              into the short friendly size using the appropriate
 *              measure.
 * @param       {number}      bytes         A number that represents bytes
 * @return      {string}                    The friendly form of bytes.
 *                                          For Example:
 *                                             var example = _getRateWithUnits(2048)
 *                                             example: 2KB
 * Converting to sizes:
 *   http://stackoverflow.com/a/18650828
 */
var _getRateWithUnits = function(bytes) {
  var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) {
    return '0 Byte';
  }
  var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + sizes[i];
};

var _doPurgeFile = function(file) {
  log.debug("_doPurgeFile", file);
  fs.unlinkSync(file);
};

/**
 * @private
 * @function    _padTimeLeft
 * @description Pad a string with a 'pad' digit for 'length' spaces
 * @param       {string}      string        The string we want to pad
 * @param       {char}        pad           The digit to use for padding
 * @param       {number}      length        How much to pad
 * @return      {string}                    The original string padded with the
 *                                          pad character $length times
 * Padding Function pulled from here
 *    http://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
 */
var _padTimeLeft = function(string, pad, length) {
  return (new Array(length + 1).join(pad) + string).slice(-length);
};

var _startChunk = function(outputFileName, options, chunkNumber, callback) {
  log.verbose(
    "_startChunk parms:",
    outputFileName,
    options,
    chunkNumber,
    callback
  );
  // Get the size of this chunk
  chunkSize = Math.ceil(1 * state.totalSizeOfFile / api.chunkCount);
  // We will need to start writing this chunks bits at the right
  // offset inside the file
  var _offset = chunkSize * chunkNumber;
  // Standard options for a writeStream
  var _fops = {
    flags: 'r+',
    start: _offset
  };
  // This file handle will be passed around to each of the Downloads
  // so they can write their various bits into the correct portion
  // of the final file
  var _file = fs.createWriteStream(outputFileName, _fops);
  // Get the last byte location inside the final file
  var _endOfChunkBytes = Math.min(chunkSize * (chunkNumber + 1) - 1, state.totalSizeOfFile - 1);
  // Now start downloading this chunk of the file
  _downloadChunk(_file, options, _offset, _endOfChunkBytes, chunkNumber, callback);
};

/**
 * @private
 * @function    _downloadChunk
 * @description Grab a chunk of a file
 * @param       {object}      file          The descriptor to the file for data
 *                                          output which should have already had
 *                                          the appropriate offset configured
 * @param       {object}      options       An appropriate request node module
 *                                          options object.  We will take this
 *                                          object an inject addition settings
 * @param       {number}      offset        Where in the file we should start
 *                                          downloading data for this chunk
 * @param       {number}      end           Where the download should finish
 * @param       {number}      number        Which sections of the file are we
 *                                          downloading
 * @param       {Function}    callback      callback(err,fileDescriptor); either
 *                                          this callback is called with an error
 *                                          or on success, with the original file
 *                                          descriptor passed into us so the file
 *                                          can be closed when all chunks are
 *                                          complete
 */
var _downloadChunk = function(file, options, offset, end, chunkNumber, callback) {
  // Use whatever was passed, then append our own
  var _options = options;

  // We are going to set the byte offset for this chunk
  var _byteRange = ["bytes=", offset, "-", end].join('');
  // Set a browser agent for this request
  var _browserAgent = ["fget/", options.version, "(", (os.type()), "/", (os.release()), ";", (os.arch()), ");"].join('');

  _options.method = "GET";

  if (!_options.headers) {
    _options.headers = {};
  }
  _options.headers["user-agent"] = _browserAgent;
  _options.headers.range = _byteRange;


  _options.pool = {};
  _options.pool.maxSockets = 5;

  // Make our request in 'stream' mode so we don't run out of ram on big files
  var _request = request
    .get(_options)
    .on('data', function(data) {
      if (_cancel) {
        _request.abort();
        return log.debug("Aborting _downloadChunk");
      }
      if (!state.chunkStatus) {
        state.chunkStatus = {};
      }
      state.totalOfBytesDownloadedFromServer += data.length;
      state.chunkStatus[chunkNumber] += data.length;
      file.write(data);
    })
    .on('end', function() {
      log.debug("Ending _downloadChunk");
      file.end(function() {
        log.verbose("...Done writing chunk to file");
        callback();
      });
    })
    .on('error', function(err) {
      log.error("Request Error:", err);
      log.warn("Trying chunk again");
      return;
    });

  log.verbose(_request);
  return _request.end();

};

/********************************************************************
 * Main Exports
 ********************************************************************/

/**
 * @description Public Exports for this module
 * @type {Object}
 */
var api = {
  filename: null,
  /**
   * @description Integer representing how many simultaneous connections we should make
   *              against the server at one time
   * @type {Number}
   */
  maximumConnections: 5,
  /**
   * @description Integer representing how many chunks we should use when chunking
   *              the file
   * @type {Number}
   */
  chunkCount: 5,
  /**
   * @function    get
   * @description Given at least a uri, try to investigate the meta data
   *              at the destination of the uri and download the file.  If
   *              the server supports the functionality, we will chunk
   *              the file into multiple tcp streams
   * @param       {object}      options       This should be valid options
   *                                          supported by the 'request' node
   *                                          module.  At a minimum a uri must
   *                                          be passed.  You can also include
   *                                          credentials in the 'auth' property
   *                                          Example:
   *                                            options = {
   *                                              uri: "https://example.com/file.tar.gz",
   *                                              auth: "username:password"
   *                                            }
   * @param       {Function}    callback      callback(err,(true|false))
   *                                          The callback will have an error
   *                                          or the result will be set to 'true'
   *                                          when completed on success.
   *                                          See:
   *                                             "status" doc for getting progress
   */
  get: function(options, callback) {

    var _chunkCount = api.chunkCount;
    var _maxConnections = api.maximumConnections;

    // **********************
    // Guards
    // **********************
    if (!callback || typeof(callback) !== "function") {
      throw new Error("Must provide a callback");
    }

    if (!options || !options.uri) {
      return callback("Must provide a uri in options");
    }

    /*
     * Turns out performing a 'head' here doesn't work with self signed
     * GET urls from Amazon.  The signed URL includes the method type (HEAD, GET, POST, etc).
     *   See:  http://stackoverflow.com/a/27473301
     * In order to support this we are going to perform a GET for 1 byte.  However,
     * it's possible the server we are attaching to won't support ranges.  If that's the
     * case the server will send the entire file.  SO, we do a 1 byte get instead of a head
     * and if it turns out the server doesn't support byte ranges we just save the
     * entire file from the first GET.
     */
    // Use whatever was passed, then append our own
    var _options = JSON.parse(JSON.stringify(options));
    // We are going to set the byte offset for this chunk
    var _byteRange = ["bytes=", 1, "-", 1].join('');
    // Set a browser agent for this request
    var _browserAgent = ["fget/", options.version, "(", (os.type()), "/", (os.release()), ";", (os.arch()), ");"].join('');

    _options.method = "GET";
    if (!_options.headers) {
      _options.headers = {};
    }
    _options.headers["user-agent"] = _browserAgent;
    _options.headers.range = _byteRange;

    _options.pool = {};
    _options.pool.maxSockets = 5;

    // Extract the filename from the uri
    if (api.filename !== null) {
      _filename = api.filename;
    } else {
      _filename = api.filename = decodeURI(_options.uri.replace(/\?.*/, "").split('/').pop());
    }
    log.debug("Emitting to File:", _filename);

    state.downloadStartEpoch = new Date();
    state.totalOfBytesDownloadedFromServer = 0;
    _cancel = false;
    var _chunkDownload = false;

    // Build a temp file name we will dump data into until we complete.
    // Upon completition we'll move this temp file in place
    _rootFileName = path.basename(_filename);
    _tmpStubFile = [".", _rootFileName, ".stub.fget.tmp"].join('');

    var _fops = {
      flags: 'w'
    };
    // This file handle will be passed around to each of the Downloads
    // so they can write their various bits into the correct portion
    // of the final file
    var _file = fs.createWriteStream(_tmpStubFile, _fops);

    // Make our request in 'stream' mode so we don't run out of ram on big files
    var _request = request
      .get(_options)
      .on('data', function(data) {
        if (_cancel) {
          _request.abort();
          return log.debug("Aborting stub download");
        }
        state.totalOfBytesDownloadedFromServer += data.length;
        _file.write(data);
      })
      .on('end', function() {
        log.debug("Ending stub check");
        _file.end(function() {
          if (_cancel || _chunkDownload) {
            return _doPurgeFile(_tmpStubFile);
          }
          fs.renameSync(_tmpStubFile, _filename);
          return callback();
        });
      })
      .on('error', function(err) {
        api.cancel();
        return log.error("Request Error:", err);
      })
      .on('response', function(response) {
        log.verbose('Response Object', response);

        if (response.statusCode < 200 || response.statusCode > 299) {
          api.cancel();
          var _msg = ["Invalid Response returned from Server:", response.statusCode].join(' ');
          log.verbose(_msg, response);
          return callback(_msg);
        }

        // If the server doesn't support byte ranges we will not be able to
        // get files faster
        if (!response.headers['accept-ranges'] || response.headers['accept-ranges'] !== "bytes") {
          return log.warn("Byte Ranges and Fast Downloads not supported by host");
        }

        //
        _chunkDownload = true;

        // If the header exists and containes the word 'bytes'
        if (response.headers['content-range'] && ~response.headers['content-range'].indexOf("bytes")) {
          state.totalSizeOfFile = response.headers['content-range'].split('/').pop();
        } else {
          state.totalSizeOfFile = response.headers['content-length'];
        }

        // Build a temp file name we will dump data into until we complete.
        // Upon completition we'll move this temp file in place
        _rootFileName = path.basename(_filename);
        _tmpFileName = [".", _rootFileName, ".fget.tmp"].join('');

        // Open the file
        return fs.open(_tmpFileName, 'w', function(err, fd) {
          // Expand the file to size
          return fs.truncate(fd, state.totalSizeOfFile, function() {

            /**
             * @private
             * @function    _doHandleDownloadChunkDone
             * @description When each chunk is completed we keep track with
             *              this handler.  When all chunks complete, we
             *              close the file and move the file into its final
             *              home.  We will call our callback on success with
             *              a value of 'true'
             * @param       {string}      err           If set this will contain
             *                                          any errors that occured
             *                                          for this chunk.  errors
             *                                          need to throw an exception
             *                                          to break out of everything
             * @param       {object}      file          The file descriptor for the
             *                                          file we are writing all the
             *                                          chunks into.  When we are
             *                                          done with all chunks we
             *                                          need to close the file.
             */
            var _doHandleDownloadChunkDone = function(err) {
              state.chunksCompleted++;
              if (err) {
                throw new Error(err);
              }
              log.debug("Chunk completed", state.chunksCompleted, "of", api.chunkCount);
              if (state.chunksCompleted == api.chunkCount) {
                if (_cancel) {
                  log.debug("Cancel Detected");
                  log.verbose("State:", state);
                  return _doPurgeFile(_tmpFileName);
                }
                log.debug("Moving File Into Place");
                fs.renameSync(_tmpFileName, _filename);
                return callback(null, true);
              }

              if (_chunksStarted < api.chunkCount) {
                _chunksStarted++;
                _chunkCount--;
                return _startChunk(_tmpFileName, JSON.parse(JSON.stringify(options)), _chunkCount, _doHandleDownloadChunkDone);
              }

              return;
            };

            if (_maxConnections > _chunkCount) {
              _maxConnections = _chunkCount;
            }

            // Go through each chunk and start a simultaneous download
            var c = _maxConnections;
            var _chunksStarted = 0;
            while (c--) {
              // Now start downloading this chunk of the file
              _chunksStarted++;
              _chunkCount--;
              _startChunk(_tmpFileName, JSON.parse(JSON.stringify(options)), _chunkCount, _doHandleDownloadChunkDone);
            }
          });
        });
      });

  },

  /**
   * @function    cancel
   * @description Instruct the download to soft 'gently' by allowing buffers
   *              to finish and 'aborting' any open chunks
   */
  cancel: function() {
    _cancel = true;
  },
  /**
   * @function    status
   * @description Return meta data related to the current transfer
   * @return      {object}      An object that represents the metadata of this
   *                            current download.  Example:
   *                              {
   *                                "totalDownloaded": 4291242032,
   *                                "totalDownloadSize": "4309925376",
   *                                "rateInBytes": 104587215.060526,
   *                                "rateWithUnits": "99.7MB/s",
   *                                "averageSpeed": 105613363.18192902,
   *                                "averageSpeedWithUnits": "100.7MB/s",
   *                                "estSecsRemaining": 0.17690321979251972,
   *                                "estTimeLeftFriendlyFormat": "00:00"
   *                            }
   */
  status: function() {
    // Calculate since we started how much has been completed and how many
    // bytes per second we have downloaded
    var _rateInBytes = state.totalOfBytesDownloadedFromServer / (new Date() - state.downloadStartEpoch) * 1024;
    // Get the rateInBytes in a pretty/condensed format
    var _rateWithUnits = _getRateWithUnits(_rateInBytes);

    // Avg Speed:
    //    http://stackoverflow.com/questions/2779600/how-to-estimate-download-time-remaining-accurately
    var _smoothingFactor = 0.5;
    state.avgSpeedInBytes = _smoothingFactor * state.lastSpeedInBytes + (1 - _smoothingFactor) * state.avgSpeedInBytes;

    // Keep track of this rounds "rate" to perform an avg over time.
    state.lastSpeedInBytes = _rateInBytes;

    // Get the pretty version of the avgSpeed
    state.avgSpeedInBytesWithUnits = _getRateWithUnits(state.avgSpeedInBytes);

    // Figure out how much longer (using the average speed) we have to finish download
    var _estimatedSecondsRemaining = (state.totalSizeOfFile - state.totalOfBytesDownloadedFromServer) / state.avgSpeedInBytes;

    // Getting Minutes to Seconds:
    //    http://stackoverflow.com/questions/3733227/javascript-seconds-to-minutes-and-seconds
    var _minutesRemaining = Math.floor(_estimatedSecondsRemaining / 60);
    var _secondsRemaining = Math.round(_estimatedSecondsRemaining) - _minutesRemaining * 60;
    var _estimatedTimeLeftFriendlyFormat = [_padTimeLeft(_minutesRemaining, '0', 2), ":", _padTimeLeft(_secondsRemaining, '0', 2)].join('');

    return {
      totalDownloaded: state.totalOfBytesDownloadedFromServer,
      totalDownloadSize: state.totalSizeOfFile,
      rateInBytes: _rateInBytes,
      rateWithUnits: [_rateWithUnits, "/s"].join(''),
      averageSpeed: state.avgSpeedInBytes,
      averageSpeedWithUnits: [state.avgSpeedInBytesWithUnits, "/s"].join(''),
      estSecsRemaining: _estimatedSecondsRemaining,
      estTimeLeftFriendlyFormat: _estimatedTimeLeftFriendlyFormat,
      filename: api.filename
    };
  }
};

// Export our api
module.exports = api;

/********************************************************************
 * Test Code - Only runs when not imported
 ********************************************************************/
if (module.parent === null) {

  var progress = require('progress');

  // Enable test logging output
  log.enable.tests = true;

  var options = {
    uri: "http://mirror.internode.on.net/pub/test/1000meg.test"
  };

  var _bar = null;
  var _lastPercent = 0;

  var displayStatus = function() {
    var _status = api.status();
    // if (_status.totalDownloaded === 0 || _status.totalDownloadSize === 0) {
    if (_status.totalDownloaded === 0 || _status.totalDownloadSize === 0 || _lastPercent >= 100) {
      return;
    }
    if (!_bar && _status.totalDownloadSize > 0) {
      _bar = new progress('Downloading [:filename] [:bar] :percent :speed :etas', {
        complete: '=',
        incomplete: ' ',
        width: 40,
        total: 100,
        // total: parseInt(_status.totalDownloadSize, 10),
        speed: "0mb"
      });
    }
    var _thisPercent = Math.ceil(_status.totalDownloaded / _status.totalDownloadSize * 100);
    var _thisTime = _thisPercent - _lastPercent;
    _lastPercent += _thisTime;
    _bar.tick(_thisTime, {
      speed: _status.rateWithUnits,
      filename: _status.filename
    });
    // log.info([_status.totalDownloaded, "of", _status.totalDownloadSize, "|", _status.rateWithUnits].join(' '));
  };

  var _statusInterval = setInterval(displayStatus, 500);

  api.get(options, function(err, res) {
    clearInterval(_statusInterval);
    if (err || res !== true) {
      return log.fail("Something went wrong with test", err, res);
    }
    log.success("Everything worked out!", res);
  });
}
