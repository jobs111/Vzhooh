// Local MQTT-over-WebSocket broker for tests. Optional "curtain": freeze a connection after N bytes sent to the client.
const { Aedes } = require('aedes');
const { WebSocketServer, createWebSocketStream } = require('ws');
exports.broker = async (port, opts = {}) => {
  const aedes = await Aedes.createBroker();
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const state = { curtain: opts.curtain || 0, conns: 0, frozen: 0, drop: false };
  wss.on('connection', ws => {
    state.conns++;
    let sent = 0, frozen = false;
    const orig = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      if (state.drop) return;
      if (state.curtain) {
        sent += data.length || data.byteLength || 0;
        if (sent > state.curtain) { if (!frozen) { frozen = true; state.frozen++; } const cb = rest.find(x => typeof x === 'function'); if (cb) cb(); return; }
      }
      return orig(data, ...rest);
    };
    aedes.handle(createWebSocketStream(ws));
  });
  return { state, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => aedes.close(r)); }) };
};
