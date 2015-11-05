var log = require('iphb-logs');

var config = {
};

module.exports = config;

// Only runs if we are called without an import (as in tests)
if (module.parent === null) {

  log.enable.logging = true;
  log.enable.debug = true;

  log.debug("------------------------------------------------------------------");
  log.debug("Configuration:");
  log.debug("------------------------------------------------------------------");
  for (var key in config) {
    log.debug("  ", key, "=", config[key]);
  }
  log.debug("------------------------------------------------------------------");
}
