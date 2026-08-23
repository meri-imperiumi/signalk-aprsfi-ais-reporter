/**
 * Smoke tests for the plugin entry point (start/stop, AIS decoding, submission).
 * @file plugin.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const makePlugin = require('../plugin/index');
const { FakeSignalKApp, emitDelta } = require('./fake-app');

// The plugin posts to aprs.fi using the global fetch + FormData. We capture
// submissions in memory and respond with the { result: 'ok' } ack.
let lastFetchArgs = null;
const fetchResult = { result: 'ok' };

function installFetchShim() {
  lastFetchArgs = null;
  global.fetch = async (url, options) => {
    lastFetchArgs = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => fetchResult,
    };
  };
  // FormData isn't part of Node's built-ins on the older target; provide a
  // minimal shim that just stashes fields so the body construction runs.
  global.FormData = class FormData {
    constructor() {
      this.fields = {};
    }

    append(name, value) {
      this.fields[name] = value;
    }
  };
}

function restoreFetchShim() {
  delete global.fetch;
  delete global.FormData;
}

/**
 * Wait `ms` milliseconds, resolving the returned promise.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

/**
 * Builds a started plugin instance wired to a fresh fake app with the
 * given settings (defaulted) and a fast submission interval.
 *
 * @param {object} [overrides]
 * @returns {{app: FakeSignalKApp, plugin: object}}
 */
function makeStarted(overrides) {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  plugin.start({
    name: 'NOCALL',
    sender_url: 'https://signalk.org',
    url: 'https://aprs.fi/jsonais/post/secret',
    event: 'nmea0183,nmea0183out',
    interval: 0.1, // 100ms tick for fast tests
    ...overrides,
  });
  return { app, plugin };
}

test('creates a plugin object with the right id/name', () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.id, 'signalk-aprsfi-ais-reporter');
  assert.strictEqual(plugin.name, 'aprs.fi AIS reporter');
  assert.ok(plugin.description);
});

test('schema is a JSON object with required upload settings', () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.schema.type, 'object');
  assert.ok(plugin.schema.properties.url);
  assert.ok(plugin.schema.properties.interval);
  assert.ok(plugin.schema.properties.event);
});

test('start without a URL sets a status message and does not subscribe', () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  plugin.start({});
  assert.ok(
    app.statusMessages.some(
      (m) => m.type === 'status' && /upload URL/i.test(m.msg),
    ),
    `got ${JSON.stringify(app.statusMessages)}`,
  );
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
});

test('start subscribes to the internet state path and listens to NMEA events', () => {
  const { app, plugin } = makeStarted();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 1);
  const sub = app.subscriptionmanager.subscriptions[0].subscription;
  assert.strictEqual(sub.context, 'vessels.self');
  assert.strictEqual(sub.subscribe[0].path, 'network.internet.state');
  assert.ok(app.listenerCount('nmea0183') > 0);
  assert.ok(app.listenerCount('nmea0183out') > 0);
  plugin.stop();
});

test('start sets up the submission interval without error', () => {
  const { app, plugin } = makeStarted();
  // No status is set until the first interval tick; just confirm no errors.
  assert.strictEqual(app.errors.length, 0, `got ${JSON.stringify(app.errors)}`);
  plugin.stop();
});

test('emitting an AIS position report does not crash the decoder', async () => {
  const { app, plugin } = makeStarted();
  // AIVDM Type 3 position report (MMSI 366790334, lat ~57.9, lon ~5.07).
  app.emit('nmea0183', '!AIVDM,1,1,,A,35Mk6gP0000G>2JQ8P000@N00000,0*31');
  await wait(5);
  plugin.stop();
  assert.strictEqual(app.errors.length, 0, `got ${JSON.stringify(app.errors)}`);
});

test('interval submits queued AIS entries to the configured URL', async () => {
  installFetchShim();
  try {
    const { app, plugin } = makeStarted();
    app.emit('nmea0183', '!AIVDM,1,1,,A,35Mk6gP0000G>2JQ8P000@N00000,0*31');
    // interval is 100ms; wait for one submission cycle.
    await wait(250);
    plugin.stop();
    assert.ok(lastFetchArgs, 'no fetch was made');
    assert.strictEqual(lastFetchArgs.url, 'https://aprs.fi/jsonais/post/secret');
    assert.strictEqual(lastFetchArgs.options.method, 'post');
    const payload = JSON.parse(lastFetchArgs.options.body.fields.jsonais);
    assert.strictEqual(payload.protocol, 'jsonais');
    assert.ok(payload.groups[0].msgs.length > 0, 'no messages submitted');
    const first = payload.groups[0].msgs[0];
    assert.ok(first.mmsi, 'submitted entry has no mmsi');
    assert.ok(first.msgtype, 'submitted entry has no msgtype');
  } finally {
    restoreFetchShim();
  }
});

test('internet offline state skips submission', async () => {
  installFetchShim();
  try {
    const { app, plugin } = makeStarted();
    emitDelta(app, {
      context: 'vessels.self',
      updates: [
        {
          values: [{ path: 'network.internet.state', value: 'offline' }],
        },
      ],
    });
    await wait(5);
    app.emit('nmea0183', '!AIVDM,1,1,,A,35Mk6gP0000G>2JQ8P000@N00000,0*31');
    await wait(250);
    plugin.stop();
    assert.ok(
      app.statusMessages.some((m) => /skipping/i.test(m.msg)),
      `got ${JSON.stringify(app.statusMessages)}`,
    );
    assert.ok(!lastFetchArgs, 'a fetch was made while offline');
  } finally {
    restoreFetchShim();
  }
});

test('stop removes event listeners and clears subscriptions', () => {
  const { app, plugin } = makeStarted();
  assert.ok(app.subscriptionmanager.subscriptions.length > 0);
  assert.ok(app.listenerCount('nmea0183') > 0);
  plugin.stop();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
  assert.strictEqual(app.listenerCount('nmea0183'), 0);
});
