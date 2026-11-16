// Local MQTT-over-WebSocket broker for tests. Optional "curtain": freeze a connection after N bytes sent to the client.
const { Aedes } = require('aedes');
const { WebSocketServer, createWebSocketStream } = require('ws');
exports.broker = async (port, opts = {}) => {
  const aedes = await Aedes.createBroker();
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  // curtain: freeze a connection after N bytes sent to the client; delay: slow connection setup (ms);
  // mute: the client can connect and subscribe but never receives a message (like a relay blocked by the network)
  const state = { curtain: opts.curtain || 0, delay: opts.delay || 0, mute: !!opts.mute, conns: 0, frozen: 0, drop: false };
  wss.on('connection', ws => {
    state.conns++;
    let sent = 0, frozen = false, n = 0;
    const t0 = Date.now(), orig = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      const cb = rest.find(x => typeof x === 'function');
      if (state.drop) { if (cb) cb(); return; }
      if (state.mute && n++ >= 2) { if (cb) cb(); return; }
      if (state.curtain) {
        sent += data.length || data.byteLength || 0;
        if (sent > state.curtain) { if (!frozen) { frozen = true; state.frozen++; } if (cb) cb(); return; }
      }
      const wait = state.delay - (Date.now() - t0);
      if (wait > 0) { setTimeout(() => { try { orig(data, ...rest); } catch (e) { /* closed */ } }, wait); return; }
      return orig(data, ...rest);
    };
    aedes.handle(createWebSocketStream(ws));
  });
  return { state, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => aedes.close(r)); }) };
};
