/**
 * Shared test fakes: a mock Signal K app and Express-style router matching
 * the patterns used by the dead-reckoning test suite.
 *
 * @file fake-app.js
 */

/* eslint-disable class-methods-use-this */

const { EventEmitter } = require('node:events');

/**
 * Minimal Signal K app fake with subscriptionmanager + handleMessage +
 * setPluginStatus + setPluginError + getSelfPath. The data path is set
 * per-test to a temp directory.
 */
class FakeSignalKApp extends EventEmitter {
  constructor() {
    super();
    this.selfId = 'urn:mrn:imo:mmsi:123456789';
    this.subscriptionmanager = {
      subscriptions: [],
      subscribe(subscription, unsubscribes, onError, onDelta) {
        this.subscriptions.push({ subscription, onDelta });
        unsubscribes.push(() => {
          const idx = this.subscriptions.findIndex(
            (s) => s.subscription === subscription,
          );
          if (idx >= 0) this.subscriptions.splice(idx, 1);
        });
      },
    };
    this.selfPath = {};
    this.statusMessages = [];
    this.errors = [];
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus(msg) {
    this.statusMessages.push({ type: 'status', msg });
  }

  setPluginError(msg) {
    this.statusMessages.push({ type: 'error', msg });
  }

  getSelfPath(path) {
    return this.selfPath[path] || null;
  }

  debug() {}

  error(msg) {
    this.errors.push(msg);
  }
}

/**
 * Emits a delta into the subscriptionmanager's registered handlers, for
 * tests that want to feed sensor values.
 *
 * @param {object} app
 * @param {object} delta
 * @returns {void}
 */
function emitDelta(app, delta) {
  app.subscriptionmanager.subscriptions.forEach(({ onDelta }) => onDelta(delta));
}

module.exports = { FakeSignalKApp, emitDelta };
