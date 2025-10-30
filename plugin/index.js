const { default: AISDecoder } = require('ais-stream-decoder');
const CircularBuffer = require('circular-buffer');

const decoder = new AISDecoder();

module.exports = (app) => {
  let onAISEvent;
  let events = [];
  // Max messages per submission
  let queue = new CircularBuffer(300);
  let interval;
  const plugin = {
    id: 'signalk-aprsfi-ais-reporter',
    name: 'aprs.fi AIS reporter',
    description: 'AIS data to aprs.fi forwarder service',
    start: (settings) => {
      if (!settings.url) {
        app.setPluginStatus('No upload URL set');
        return;
      }
      decoder.on('data', (aisData) => {
        // Based on https://github.com/gregbartels/ais_jsonaprs/blob/main/ais_json.py
        const entry = {
          msgtype: aisData.type,
          mmsi: aisData.mmsi,
          rxtime: new Date().toISOString().replace(/[T:-]/g, '').substr(0, 14),
        };
        if (Number.isFinite(aisData.lat)) {
          entry.lat = aisData.lat;
        }
        if (Number.isFinite(aisData.lon)) {
          entry.lon = aisData.lon;
        }
        if (Number.isFinite(aisData.speedOverGround)) {
          entry.speed = aisData.speedOverGround;
        }
        if (Number.isFinite(aisData.courseOverGround)) {
          entry.course = aisData.courseOverGround;
        }
        if (Number.isFinite(aisData.heading)) {
          entry.heading = aisData.heading;
        }
        if (Number.isFinite(aisData.navStatus)) {
          entry.status = aisData.navStatus;
        }
        if (aisData.typeAndCargo) {
          entry.shiptype = aisData.typeAndCargo;
        }
        if (aisData.typeAndCargo) {
          entry.shiptype = aisData.typeAndCargo;
        }
        if (aisData.callsign) {
          entry.callsign = aisData.callsign;
        }
        if (aisData.name) {
          entry.name = aisData.name;
        }
        if (Number.isFinite(aisData.draught)) {
          entry.draught = aisData.draught;
        }
        if (Number.isFinite(aisData.length)) {
          entry.length = aisData.length;
        }
        if (Number.isFinite(aisData.width)) {
          entry.width = aisData.width;
        }
        if (aisData.destination) {
          entry.destination = aisData.destination;
        }
        queue.enq(entry);
      });
      onAISEvent = (message) => {
        if (!message.match(/!AIVDM/)) {
          // Not AIS other vessel message
          return;
        }
        decoder.write(message);
      };
      events = settings.event.split(',');
      events.forEach((eventName) => {
        app.on(eventName, onAISEvent);
      });
      interval = setInterval(() => {
        if (queue.size() === 0) {
          app.setPluginStatus('No AIS events to report');
          return;
        }
        const messages = queue.toarray();
        // Clear queue
        queue = new CircularBuffer(300);
        fetch(settings.url, {
          method: 'post',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            encodetime: new Date().toISOString().replace(/[T:-]/g, '').substr(0, 14),
            protocol: 'jsonais',

            groups: [
              {
                path: [
                  {
                    name: settings.name || 'NOCALL',
                    url: settings.url,
                  },
                ],
                msgs: messages,
              },
            ],
          }),
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`Request failed with HTTP ${response.status}`);
            }
            app.setPluginStatus(`Submitted ${messages.length} AIS entries`);
          })
          .catch((err) => {
            app.setPluginError(err.message);
          });
      }, settings.interval * 1000);
    },
    stop: () => {
      events.forEach((eventName) => {
        app.removeListener(eventName, onAISEvent);
      });
      if (interval) {
        clearInterval(interval);
      }
    },
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          title: 'Sender name',
        },
        url: {
          type: 'string',
          format: 'uri',
          title: 'Service upload endpoint URL',
          description: 'AIS sending URL from aprs.fi settings page including password',
          example: 'https://aprs.fi/jsonais/post/c273rhauwf7',
        },
        event: {
          type: 'string',
          title: 'NMEA 0183 Events',
          default: 'nmea0183,nmea0183out',
          description: 'Can be comma separated list',
        },
        interval: {
          type: 'integer',
          title: 'Sending interval',
          default: 30,
          description: 'in seconds',
        },
      },
    },
  };
  return plugin;
};
