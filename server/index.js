const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const { readConfig, readState, updateConfig, writeConfig, writeState } = require('./config');
const { MidiBridge, getMidiHardwarePresence, isApcDeviceName, resolveMidiDeviceName } = require('./midi');
const { OscBridge } = require('./osc');
const { LedController } = require('./led');
const { applyBackupIp, applyNetworkConfig, getNetworkStatus } = require('./network');
const { deleteMapping, findMapping, isPress, normalizeSourceType, scaleFader, upsertMapping } = require('./mappings');

let config = readConfig();
config.state = readState();
let pendingConfigWrite = null;
let ledRefreshTimer = null;
let midiWatchTimer = null;
let networkBackupTimer = null;
let lastMidiDeviceSignature = '';
let lastMidiReconnectAttemptAt = 0;
let lastMidiWatchReportAt = 0;
let networkBackupApplying = false;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const httpSockets = new Set();
const midi = new MidiBridge(config);
const osc = new OscBridge(config);
const led = new LedController(midi);
const recent = {
  midi: [],
  oscSent: [],
  oscReceived: [],
  errors: []
};
const executorState = {};
const playbackState = {};
const liveInputState = {
  last: null,
  notes: {},
  ccs: {}
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function remember(bucket, item) {
  const limit = config.ui?.recentEventLimit || 80;
  recent[bucket].unshift(item);
  recent[bucket] = recent[bucket].slice(0, limit);
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function reportError(error, source = 'server') {
  const data = {
    source,
    message: error.message || String(error),
    at: new Date().toISOString()
  };
  console.error(`[${source}]`, data.message);
  remember('errors', data);
  broadcast('error', data);
}

function status() {
  return {
    midi: midi.getStatus(),
    osc: osc.getStatus(),
    network: getNetworkStatus(config),
    devices: midi.listDevices(),
    state: config.state || { faders: {}, currentPage: 1 },
    executorState,
    playbackState,
    liveInput: liveInputState
  };
}

function createBackupPayload() {
  const backupConfig = JSON.parse(JSON.stringify(config));
  backupConfig.state = readState();
  if (backupConfig.network?.backup) {
    delete backupConfig.network.backup.address;
  }
  return {
    type: 'akai-magicq-bridge-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: 'network.backup.address ist absichtlich nicht enthalten und bleibt beim Restore lokal erhalten.',
    config: backupConfig
  };
}

function restoreBackupPayload(payload) {
  const importedConfig = payload.config || payload;
  if (!importedConfig || typeof importedConfig !== 'object') {
    throw new Error('Backup enthaelt keine Konfiguration.');
  }

  const currentBackupAddress = config.network?.backup?.address;
  const currentState = readState();
  const nextConfig = JSON.parse(JSON.stringify(importedConfig));
  nextConfig.network = {
    ...(config.network || {}),
    ...(nextConfig.network || {}),
    backup: {
      ...(config.network?.backup || {}),
      ...(nextConfig.network?.backup || {}),
      address: currentBackupAddress
    }
  };

  const nextState = nextConfig.state || payload.state || currentState;
  delete nextConfig.state;
  return { config: nextConfig, state: nextState };
}

function reconnect(options = {}) {
  led.setApcLayout(config.apc);
  const midiStatus = midi.connect(config, { keepExisting: !options.forceMidi });
  try {
    osc.start(config);
  } catch (error) {
    reportError(error, 'osc');
  }
  if (midiStatus.outputConnected) {
    refreshAllLeds();
  } else {
    syncPageLeds();
  }
  broadcast('status', status());
}

midi.on('midi', (event) => {
  console.log('[midi]', event);
  remember('midi', event);
  updateLiveInput(event);
  broadcast('midi-event', event);
  broadcast('live-input', liveInputState);

  const sourceType = normalizeSourceType(event, config.apc);
  if (sourceType === 'shift') {
    config.state = {
      ...(config.state || {}),
      currentPage: midi.shiftActive ? 2 : 1
    };
    refreshAllLeds();
    broadcast('page-changed', config.state);
    broadcast('status', status());
    return;
  }

  const mapping = findMapping(event, config, midi.shiftActive || config.state?.currentPage === 2);
  if (sourceType === 'fader') {
    const level = scaleFader(event.value, mapping?.range);
    saveFaderValue(event.controller, event.value, level, mapping);
    if (!mapping) {
      broadcast('status', status());
      return;
    }
  }

  if (sourceType === 'fader' && mapping?.target?.type === 'disabled') {
    broadcast('status', status());
    return;
  }

  if (sourceType === 'fader' && mapping) {
    const level = scaleFader(event.value, mapping.range);
    try {
      osc.sendForMapping(mapping, event, level);
    } catch (error) {
      reportError(error, 'osc');
    }
    if (mapping.target?.type?.startsWith('magicq-executor')) {
      setExecutorState(mapping.target, level);
      refreshExecutorTargetLeds(mapping.target);
    }
    if (mapping.target?.type === 'magicq-playback-level') {
      setPlaybackLevel(mapping.target.playback || 1, level);
    }
    broadcast('status', status());
    return;
  }

  if (!mapping) return;
  if (mapping.target?.type === 'disabled') {
    if (isPress(event) && mapping.source?.note !== undefined) applyLedSafe(mapping, false);
    return;
  }

  try {
    if (mapping.target?.type === 'special' && mapping.target.action === 'clear-leds' && isPress(event)) {
      led.clearAllPads(allLedNotes());
      return;
    }

    if (mapping.target?.type === 'magicq-executor-fader') {
      const level = scaleFader(event.value, mapping.range);
      saveFaderValue(event.controller, event.value, level, mapping);
      try {
        osc.sendForMapping(mapping, event, level);
      } catch (error) {
        reportError(error, 'osc');
      }
      setExecutorState(mapping.target, level);
      broadcast('status', status());
      return;
    }

    if (mapping.target?.type === 'magicq-executor-button' && mapping.target.action === 'flash') {
      const active = isPress(event);
      try {
        osc.sendForMapping(mapping, event);
      } catch (error) {
        reportError(error, 'osc');
      }
      setExecutorState(mapping.target, active ? 100 : 0);
      refreshExecutorTargetLeds(mapping.target);
      broadcast('status', status());
      return;
    }

    if (mapping.target?.type === 'magicq-playback-flash' && mapping.target.action !== 'toggle') {
      const active = isPress(event);
      try {
        osc.sendForMapping(mapping, event);
      } catch (error) {
        reportError(error, 'osc');
      }
      setPlaybackFlash(mapping.target.playback || 1, active ? 1 : 0);
      applyLedSafe(mapping, active);
      broadcast('status', status());
      return;
    }

    if (isPress(event)) {
      applyLocalAction(mapping);
      try {
        sendPressMapping(mapping, event);
      } catch (error) {
        reportError(error, 'osc');
      }
      if (mapping.target?.type === 'special') {
        if (isPageAction(mapping.target.action)) {
          refreshAllLeds();
          syncPageLeds();
        } else {
          applyLedSafe(mapping, true);
          setTimeout(() => applyLedSafe(mapping, false), 180);
        }
      }
      broadcast('status', status());
    }
  } catch (error) {
    reportError(error, 'mapping');
  }
});

midi.on('status', (data) => broadcast('status', { ...status(), midi: data }));
midi.on('error', (error) => reportError(error, 'midi'));

osc.on('sent', (data) => {
  console.log('[osc:sent]', data);
  remember('oscSent', data);
  broadcast('osc-sent', data);
});

osc.on('received', (data) => {
  console.log('[osc:received]', data);
  remember('oscReceived', data);
  updateFromOscFeedback(data);
  broadcast('osc-received', data);
});

osc.on('status', (data) => broadcast('status', { ...status(), osc: data }));
osc.on('error', (error) => reportError(error, 'osc'));

app.get('/api/config', (req, res) => {
  config = readConfig();
  config.state = readState();
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = updateConfig(req.body || {});
  config.state = readState();
  led.setApcLayout(config.apc);
  reconnect();
  startNetworkBackupTimer();
  res.json(config);
});

app.get('/api/backup', (req, res) => {
  res.json(createBackupPayload());
});

app.post('/api/backup/restore', (req, res) => {
  try {
    const restored = restoreBackupPayload(req.body || {});
    config = writeConfig(restored.config);
    config.state = writeState(restored.state);
    led.setApcLayout(config.apc);
    reconnect();
    startNetworkBackupTimer();
    res.json({ ok: true, config, state: config.state });
  } catch (error) {
    reportError(error, 'backup');
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/midi/devices', (req, res) => {
  res.json(midi.listDevices({ force: true }));
});

app.post('/api/midi/select', (req, res) => {
  config = updateConfig({ midi: { input: req.body.input || '', output: req.body.output || '' } });
  const midiStatus = midi.connect(config);
  lastMidiDeviceSignature = midiDeviceSignature(midi.listDevices());
  broadcast('status', status());
  res.json({ config, status: midiStatus });
});

app.get('/api/mappings', (req, res) => {
  res.json(config.mappings || []);
});

app.post('/api/mappings', (req, res) => {
  const mapping = req.body;
  config = writeConfig(upsertMapping(config, mapping));
  led.setApcLayout(config.apc);
  refreshMappingLed(mapping);
  broadcast('status', status());
  res.json(config.mappings);
});

app.post('/api/mappings/bulk', (req, res) => {
  try {
    const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    if (!mappings.length) {
      return res.status(400).json({ ok: false, error: 'No mappings provided' });
    }

    let nextConfig = config;
    for (const mapping of mappings) {
      nextConfig = upsertMapping(nextConfig, mapping);
    }

    config = writeConfig(nextConfig);
    led.setApcLayout(config.apc);
    refreshAllLeds();
    broadcast('status', status());
    res.json({ ok: true, mappings: config.mappings });
  } catch (error) {
    reportError(error, 'mappings');
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/mappings/:id', (req, res) => {
  config = writeConfig(deleteMapping(config, req.params.id));
  led.setApcLayout(config.apc);
  broadcast('status', status());
  res.json(config.mappings);
});

app.post('/api/led/test', (req, res) => {
  try {
    const note = Number(req.body.note ?? 0);
    const color = Number(req.body.color ?? 21);
    const mode = req.body.mode || 'solid';
    led.setLed(note, color, mode);
    res.json({ ok: true, note, color, mode });
  } catch (error) {
    reportError(error, 'led');
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/osc/test', (req, res) => {
  try {
    const sent = osc.send(req.body.address || '/exec/1/1', req.body.args || [1]);
    res.json({ ok: true, sent });
  } catch (error) {
    reportError(error, 'osc');
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/led/refresh', (req, res) => {
  try {
    refreshAllLeds();
    res.json({ ok: true });
  } catch (error) {
    reportError(error, 'led');
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/reconnect', (req, res) => {
  reconnect({ forceMidi: true });
  res.json(status());
});

app.get('/api/network', (req, res) => {
  res.json(getNetworkStatus(config));
});

app.post('/api/network', (req, res) => {
  config = updateConfig({ network: req.body || {} });
  startNetworkBackupTimer();
  broadcast('status', status());
  res.json(getNetworkStatus(config));
});

app.post('/api/network/apply', async (req, res) => {
  try {
    config = updateConfig({ network: req.body || config.network || {} });
    const networkStatus = await applyNetworkConfig(config);
    startNetworkBackupTimer();
    broadcast('status', status());
    res.json({
      ok: networkStatus.lastApply?.ok !== false,
      error: networkStatus.lastApply?.errors?.join('\n') || '',
      network: networkStatus
    });
  } catch (error) {
    reportError(error, 'network');
    res.status(500).json({ ok: false, error: error.message, network: getNetworkStatus(config) });
  }
});

app.post('/api/page', (req, res) => {
  const currentPage = Math.max(1, Number(req.body.currentPage || 1));
  config.state = { ...(config.state || {}), currentPage };
  refreshAllLeds();
  broadcast('page-changed', config.state);
  broadcast('status', status());
  res.json(config.state);
});

app.get('/api/status', (req, res) => {
  res.json({ ...status(), recent });
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'status', data: { ...status(), recent } }));

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === 'led-test') {
        led.setPadColor(Number(message.note || 0), Number(message.color || 21));
      }

      if (message.type === 'osc-test') {
        osc.send(message.address || '/exec/1/1', message.args || [1]);
      }
    } catch (error) {
      reportError(error, 'websocket');
    }
  });
});

server.on('connection', (socket) => {
  httpSockets.add(socket);
  socket.on('close', () => httpSockets.delete(socket));
});

const staticDir = path.join(__dirname, '..', 'web', 'build');
app.use(express.static(staticDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  try {
    res.type('html').send(require('fs').readFileSync(path.join(staticDir, 'index.html'), 'utf8'));
  } catch (error) {
    next(error);
  }
});

reconnect();
startLedRefreshTimer();
startMidiWatchTimer();
startNetworkBackupTimer();

const port = Number(process.env.PORT || config.server.port || 3001);
const host = config.server.host || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`AKAI MagicQ bridge listening on http://${host}:${port}`);
});

let shuttingDown = false;

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down AKAI MagicQ bridge (${signal})`);

  if (ledRefreshTimer) {
    clearInterval(ledRefreshTimer);
    ledRefreshTimer = null;
  }
  if (midiWatchTimer) {
    clearInterval(midiWatchTimer);
    midiWatchTimer = null;
  }
  if (networkBackupTimer) {
    clearInterval(networkBackupTimer);
    networkBackupTimer = null;
  }
  if (pendingConfigWrite) {
    clearTimeout(pendingConfigWrite);
    config.state = writeState(config.state);
  }
  led.stopAll();
  midi.close();
  osc.stop();
  closeWebSockets();
  closeHttpSockets();

  const forceExitTimer = setTimeout(() => {
    console.warn('Forced shutdown after timeout.');
    process.exit(0);
  }, Number(config.server.shutdownTimeoutMs || 2500));
  forceExitTimer.unref?.();

  wss.close(() => {
    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  });
}

function closeWebSockets() {
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutdown');
      setTimeout(() => {
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }, 500).unref?.();
    } catch {
      try {
        client.terminate();
      } catch {
        // Ignore shutdown cleanup errors.
      }
    }
  }
}

function closeHttpSockets() {
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  }, 750).unref?.();
  for (const socket of httpSockets) {
    try {
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, 500).unref?.();
    } catch {
      // Ignore shutdown cleanup errors.
    }
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function startLedRefreshTimer() {
  if (ledRefreshTimer) clearInterval(ledRefreshTimer);
  ledRefreshTimer = setInterval(() => {
    try {
      refreshCurrentLayerLeds();
    } catch (error) {
      reportError(error, 'led-refresh');
    }
  }, 1000);
}

function startMidiWatchTimer() {
  if (midiWatchTimer) clearInterval(midiWatchTimer);
  lastMidiDeviceSignature = midiDeviceSignature(midi.listDevices({ force: true }));
  midiWatchTimer = setInterval(() => {
    try {
      watchMidiDevices();
    } catch (error) {
      reportError(error, 'midi-watch');
    }
  }, Number(config.midi?.watchIntervalMs || 1500));
}

function watchMidiDevices() {
  const devices = midi.listDevices({ force: true });
  const signature = midiDeviceSignature(devices);
  const devicesChanged = signature !== lastMidiDeviceSignature;
  const hardware = getMidiHardwarePresence(devices);
  if (devicesChanged) {
    lastMidiDeviceSignature = signature;
  }

  const current = midi.getStatus();
  const desiredInput = resolveMidiDeviceName(config.midi?.input, devices.inputs);
  const desiredOutput = resolveMidiDeviceName(config.midi?.output, devices.outputs);
  const currentInputMissing = current.inputConnected && current.input && !(devices.inputs || []).includes(current.input);
  const currentOutputMissing = current.outputConnected && current.output && !(devices.outputs || []).includes(current.output);
  const currentApcConnected = isApcDeviceName(current.input) || isApcDeviceName(current.output);
  const apcHardwareMissing = currentApcConnected && !hardware.apcPresent;
  const linuxApcHardwareMissing = process.platform === 'linux' && currentApcConnected && !hardware.linuxApcPresent;
  const deviceMissing = currentInputMissing || currentOutputMissing || apcHardwareMissing || linuxApcHardwareMissing;
  const shouldConnectInput = desiredInput && (!current.inputConnected || current.input !== desiredInput);
  const shouldConnectOutput = desiredOutput && (!current.outputConnected || current.output !== desiredOutput);
  const shouldReconnect = deviceMissing || shouldConnectInput || shouldConnectOutput;

  if (deviceMissing) {
    midi.close();
    rememberMidiWatch('MIDI device disappeared, closing stale connection', {
      input: current.input,
      output: current.output,
      currentInputMissing,
      currentOutputMissing,
      apcHardwareMissing,
      linuxApcHardwareMissing,
      hardware
    });
    broadcast('status', status());
  }

  if (linuxApcHardwareMissing || (deviceMissing && (!desiredInput || !desiredOutput))) {
    return;
  }

  if (shouldReconnect) {
    const now = Date.now();
    const reconnectInterval = Number(config.midi?.reconnectIntervalMs || 2000);
    if (now - lastMidiReconnectAttemptAt < reconnectInterval) {
      if (devicesChanged) broadcast('status', status());
      return;
    }
    lastMidiReconnectAttemptAt = now;
    const nextStatus = midi.connect(config);
    if (nextStatus.outputConnected) {
      refreshAllLeds();
    }
    broadcast('status', status());
    return;
  }

  if (devicesChanged) {
    broadcast('status', status());
  }
}

function rememberMidiWatch(message, details = {}) {
  const now = Date.now();
  if (now - lastMidiWatchReportAt < 3000) return;
  lastMidiWatchReportAt = now;
  const data = {
    source: 'midi-watch',
    message,
    details,
    at: new Date().toISOString()
  };
  console.warn('[midi-watch]', message, details);
  remember('errors', data);
  broadcast('error', data);
}

function midiDeviceSignature(devices) {
  return JSON.stringify({
    inputs: devices.inputs || [],
    outputs: devices.outputs || [],
    error: devices.error || ''
  });
}

function startNetworkBackupTimer() {
  if (networkBackupTimer) clearInterval(networkBackupTimer);
  startNetworkBackup();
  const interval = Math.max(2000, Number(config.network?.backup?.refreshMs || 5000));
  networkBackupTimer = setInterval(startNetworkBackup, interval);
}

async function startNetworkBackup() {
  if (networkBackupApplying) return;
  networkBackupApplying = true;
  try {
    const networkStatus = await applyBackupIp(config);
    if (networkStatus?.lastBackupApply && !networkStatus.lastBackupApply.ok) {
      reportError(new Error(networkStatus.lastBackupApply.errors.join('; ')), 'network-backup');
    }
    broadcast('status', status());
  } catch (error) {
    reportError(error, 'network-backup');
  } finally {
    networkBackupApplying = false;
  }
}

function updateLiveInput(event) {
  const at = new Date().toISOString();
  liveInputState.last = { ...event, at };

  if (event.event === 'cc') {
    liveInputState.ccs[event.controller] = {
      value: event.value,
      at
    };
    setTimeout(() => {
      if (liveInputState.ccs[event.controller]?.at === at) {
        delete liveInputState.ccs[event.controller];
        broadcast('live-input', liveInputState);
      }
    }, 900);
    return;
  }

  if (event.note !== undefined) {
    if (event.event === 'noteoff' || event.velocity === 0) {
      delete liveInputState.notes[event.note];
      broadcast('live-input', liveInputState);
      return;
    }

    liveInputState.notes[event.note] = {
      velocity: event.velocity,
      at
    };
  }
}

function saveFaderValue(controller, midiValue, level, mapping) {
  config.state = config.state || { faders: {}, currentPage: 1 };
  config.state.faders = {
    ...(config.state.faders || {}),
    [controller]: {
      midiValue,
      level,
      target: mapping?.target || null,
      at: new Date().toISOString()
    }
  };

  if (pendingConfigWrite) clearTimeout(pendingConfigWrite);
  pendingConfigWrite = setTimeout(() => {
    pendingConfigWrite = null;
    config.state = writeState(config.state);
  }, 300);
}

function sendPressMapping(mapping, event) {
  const target = mapping.target || {};

  if (target.type === 'magicq-executor-button') {
    const nextLevel = resolveExecutorPressLevel(target);
    osc.sendForMapping(mapping, event, undefined, nextLevel);
    setExecutorState(target, nextLevel);
    refreshExecutorTargetLeds(target);
    return;
  }

  if (target.type === 'magicq-executor-adjust') {
    const key = `${target.page}/${target.executor}`;
    const current = Number(executorState[key]?.level || 0);
    const nextLevel = clampPercent(current + Number(target.amount || 0));
    osc.sendForMapping(mapping, event, nextLevel);
    setExecutorState(target, nextLevel);
    refreshExecutorTargetLeds(target);
    return;
  }

  if (target.type === 'magicq-playback-level') {
    const level = clampPercent(target.value ?? 100);
    osc.sendForMapping(mapping, event, level);
    setPlaybackLevel(target.playback || 1, level);
    applyLedSafe(mapping, level > 0);
    return;
  }

  if (target.type === 'magicq-playback-adjust') {
    const playback = target.playback || 1;
    const current = Number(playbackState[playback]?.level || 0);
    const level = clampPercent(current + Number(target.amount || 0));
    osc.sendForMapping(mapping, event, level);
    setPlaybackLevel(playback, level);
    applyLedSafe(mapping, level > 0);
    return;
  }

  if (target.type === 'magicq-playback-flash') {
    const playback = target.playback || 1;
    const nextFlash = playbackState[playback]?.flash ? 0 : 1;
    osc.sendForMapping(mapping, event, undefined, nextFlash);
    setPlaybackFlash(playback, nextFlash);
    applyLedSafe(mapping, nextFlash > 0);
    return;
  }

  if (target.type === 'magicq-dbo' && target.action === 'toggle') {
    const nextDbo = config.state?.dboActive ? 0 : 1;
    config.state = { ...(config.state || {}), dboActive: Boolean(nextDbo) };
    osc.sendForMapping(mapping, event, undefined, nextDbo);
    applyLedSafe(mapping, nextDbo > 0);
    return;
  }

  osc.sendForMapping(mapping, event);

  if (target.type?.startsWith('magicq-') && target.type !== 'magicq-rpc') {
    applyLedSafe(mapping, true);
    setTimeout(() => applyLedSafe(mapping, false), 180);
  }
}

function resolveExecutorPressLevel(target) {
  const key = `${target.page}/${target.executor}`;
  if (target.action === 'toggle') return executorState[key]?.active ? 0 : 100;
  if (target.action === 'release') return 0;
  if (target.action === 'set-level') return clampPercent(target.value ?? 100);
  return 100;
}

function setExecutorState(target, level) {
  const key = `${target.page}/${target.executor}`;
  const nextLevel = clampPercent(level);
  executorState[key] = {
    ...(executorState[key] || {}),
    level: nextLevel,
    active: nextLevel > 0,
    at: new Date().toISOString()
  };
}

function setPlaybackLevel(playback, level) {
  const id = Number(playback || 1);
  playbackState[id] = {
    ...(playbackState[id] || {}),
    level: clampPercent(level),
    active: clampPercent(level) > 0,
    at: new Date().toISOString()
  };
}

function setPlaybackFlash(playback, flash) {
  const id = Number(playback || 1);
  playbackState[id] = {
    ...(playbackState[id] || {}),
    flash: Number(flash) > 0 ? 1 : 0,
    at: new Date().toISOString()
  };
}

function updateFromOscFeedback(data) {
  const address = data.address || '';
  const firstArg = Array.isArray(data.args) ? data.args[0] : undefined;
  const execMatch = address.match(/^\/exec\/(\d+)\/(\d+)$/);
  const playbackMatch = address.match(/^\/pb\/(\d+)$/);
  const playbackFlashMatch = address.match(/^\/pb\/(\d+)\/flash$/);

  if (execMatch) {
    const target = { page: Number(execMatch[1]), executor: Number(execMatch[2]) };
    setExecutorState(target, oscLevelToPercent(firstArg));
    refreshMappingsForTarget('magicq-executor-button', target);
    refreshMappingsForTarget('magicq-executor-fader', target);
    broadcast('status', status());
    return;
  }

  if (playbackMatch) {
    setPlaybackLevel(Number(playbackMatch[1]), oscLevelToPercent(firstArg));
    broadcast('status', status());
    return;
  }

  if (playbackFlashMatch) {
    setPlaybackFlash(Number(playbackFlashMatch[1]), firstArg);
    broadcast('status', status());
  }
}

function oscLevelToPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return clampPercent(number <= 1 ? Math.round(number * 100) : Math.round(number));
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function applyLocalAction(mapping) {
  const target = mapping.target || {};
  if (target.type !== 'special') return;

  config.state = config.state || { faders: {}, currentPage: 1 };
  if (target.action === 'select-page') {
    config.state.currentPage = target.page || 1;
  }
  if (target.action === 'next-page') {
    config.state.currentPage = Math.min(99, (config.state.currentPage || 1) + 1);
  }
  if (target.action === 'previous-page') {
    config.state.currentPage = Math.max(1, (config.state.currentPage || 1) - 1);
  }
}

function applyLedSafe(mapping, active) {
  try {
    led.applyMappingLed(mapping, active);
  } catch (error) {
    reportError(error, 'led');
  }
}

function syncPageLeds() {
  if (!midi.getStatus().outputConnected) return;
  const currentPage = config.state?.currentPage || 1;
  for (const mapping of config.mappings || []) {
    if (mappingMatchesCurrentLayer(mapping) && mapping.target?.type === 'special' && mapping.target.action === 'select-page') {
      applyLedSafe(mapping, mapping.target.page === currentPage);
    }
  }
}

function refreshAllLeds() {
  if (!midi.getStatus().outputConnected) return;
  led.clearAllPads(allLedNotes());
  refreshCurrentLayerLeds();
  syncPageLeds();
}

function refreshCurrentLayerLeds() {
  if (!midi.getStatus().outputConnected) return;
  for (const mapping of config.mappings || []) {
    if (!mappingMatchesCurrentLayer(mapping)) continue;
    const key = `${mapping.target?.page}/${mapping.target?.executor}`;
    const active = mappingActiveState(mapping, key);
    applyLedSafe(mapping, active);
  }
}

function refreshMappingsForTarget(type, target) {
  for (const mapping of config.mappings || []) {
    if (!mappingMatchesCurrentLayer(mapping)) continue;
    if (mapping.target?.type !== type) continue;
    if (Number(mapping.target.page) !== Number(target.page)) continue;
    if (Number(mapping.target.executor) !== Number(target.executor)) continue;
    applyLedSafe(mapping, mappingActiveState(mapping, `${target.page}/${target.executor}`));
  }
}

function refreshExecutorTargetLeds(target) {
  refreshMappingsForTarget('magicq-executor-button', target);
  refreshMappingsForTarget('magicq-executor-fader', target);
  refreshMappingsForTarget('magicq-executor-adjust', target);
}

function mappingMatchesCurrentLayer(mapping) {
  if (mapping.source?.type === 'fader') return true;
  return Boolean(mapping.source?.shift) === Boolean(midi.shiftActive || config.state?.currentPage === 2);
}

function mappingActiveState(mapping, executorKey) {
  if (mapping.target?.type === 'disabled') {
    return false;
  }
  if (mapping.target?.type === 'magicq-playback-level' || mapping.target?.type === 'magicq-playback-adjust') {
    return Boolean(playbackState[mapping.target.playback || 1]?.active);
  }
  if (mapping.target?.type === 'magicq-playback-flash') {
    return Boolean(playbackState[mapping.target.playback || 1]?.flash);
  }
  if (mapping.target?.type === 'magicq-dbo') {
    return Boolean(config.state?.dboActive);
  }
  return Boolean(executorState[executorKey]?.active);
}

function refreshMappingLed(mapping) {
  if (!mapping?.source?.note && mapping?.source?.note !== 0) return;
  if (!mappingMatchesCurrentLayer(mapping)) return;
  const key = `${mapping.target?.page}/${mapping.target?.executor}`;
  applyLedSafe(mapping, mappingActiveState(mapping, key));
  syncPageLeds();
}

function isPageAction(action) {
  return action === 'select-page' || action === 'next-page' || action === 'previous-page';
}

function allLedNotes() {
  return [
    ...(config.apc.matrixNotes || []),
    ...(config.apc.sceneNotes || []),
    ...(config.apc.controlNotes || [])
  ];
}
