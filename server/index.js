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
let oscStateResendTimer = null;
let ledRecoveryTimers = new Set();
let lastMidiDeviceSignature = '';
let lastMidiReconnectAttemptAt = 0;
let lastMidiWatchReportAt = 0;
let lastShiftGuardReportAt = 0;
let networkBackupApplying = false;
let lastNetworkApply = null;
let lastNetworkBackupApply = null;
let lastOscStateResend = null;

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
hydrateRuntimeState(config.state);

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
    network: {
      ...getNetworkStatus(config),
      ...(lastNetworkApply ? { lastApply: lastNetworkApply } : {}),
      ...(lastNetworkBackupApply ? { lastBackupApply: lastNetworkBackupApply } : {})
    },
    devices: midi.listDevices(),
    state: config.state || { faders: {}, currentPage: 1 },
    executorState,
    playbackState,
    oscStateResend: lastOscStateResend,
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
    sendApcIntroductionSafe('connect');
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
    if (shiftSwitchesPage()) {
      config.state = {
        ...(config.state || {}),
        currentPage: midi.shiftActive ? 2 : 1
      };
    }
    refreshAllLeds();
    if (!midi.shiftActive && shiftBehavior().recoverOnRelease !== false) {
      scheduleHardwareLedRecovery('shift-release');
    }
    broadcast('page-changed', config.state);
    broadcast('status', status());
    return;
  }

  if (shouldBlockInternalShiftCombo(sourceType, event)) {
    rememberShiftGuard(sourceType, event);
    scheduleHardwareLedRecovery('shift-guard');
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
      if (setExecutorState(mapping.target, level)) {
        refreshExecutorTargetLeds(mapping.target);
      }
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
      if (setExecutorState(mapping.target, level)) {
        refreshExecutorTargetLeds(mapping.target);
      }
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
      if (setExecutorState(mapping.target, active ? 100 : 0)) {
        refreshExecutorTargetLeds(mapping.target);
      }
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
      if (setPlaybackFlash(mapping.target.playback || 1, active ? 1 : 0)) {
        applyLedSafe(mapping, active);
      }
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
led.on('error', (error) => reportError(error, 'led'));

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

osc.on('ignored', (data) => {
  console.warn('[osc:ignored]', data);
  remember('errors', { source: 'osc-ignored', ...data });
  broadcast('error', { source: 'osc-ignored', ...data });
  broadcast('status', status());
});

osc.on('status', (data) => broadcast('status', { ...status(), osc: data }));
osc.on('error', (error) => reportError(error, 'osc'));

app.get('/api/config', (req, res) => {
  config = readConfig();
  config.state = readState();
  hydrateRuntimeState(config.state);
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = updateConfig(req.body || {});
  config.state = readState();
  hydrateRuntimeState(config.state);
  led.setApcLayout(config.apc);
  reconnect();
  startNetworkBackupTimer();
  startOscStateResendTimer();
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
    hydrateRuntimeState(config.state);
    led.setApcLayout(config.apc);
    reconnect();
    startNetworkBackupTimer();
    startOscStateResendTimer();
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
  if (midiStatus.outputConnected) {
    sendApcIntroductionSafe('connect');
    refreshAllLeds();
  }
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

app.post('/api/osc/resend', (req, res) => {
  try {
    const result = resendStoredOscStates('manual');
    broadcast('status', status());
    res.json({ ok: true, ...result });
  } catch (error) {
    reportError(error, 'osc-resend');
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
    if (networkStatus.config?.main?.connection) {
      config = updateConfig({ network: networkStatus.config });
    }
    lastNetworkApply = networkStatus.lastApply || null;
    if (lastNetworkApply?.errors?.length) {
      reportError(new Error(lastNetworkApply.errors.join('; ')), 'network');
    }
    startNetworkBackupTimer();
    broadcast('status', status());
    res.json({
      ok: networkStatus.lastApply?.ok !== false,
      error: networkStatus.lastApply?.errors?.join('\n') || '',
      network: networkStatus
    });
  } catch (error) {
    reportError(error, 'network');
    lastNetworkApply = { ok: false, errors: [error.message], at: new Date().toISOString() };
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
startOscStateResendTimer();

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
  if (oscStateResendTimer) {
    clearInterval(oscStateResendTimer);
    oscStateResendTimer = null;
  }
  for (const timer of ledRecoveryTimers) {
    clearTimeout(timer);
  }
  ledRecoveryTimers.clear();
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
      refreshAllLeds();
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
      sendApcIntroductionSafe('midi-watch');
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

function shiftBehavior() {
  return {
    switchPage: true,
    guardInternalCombos: true,
    blockedShiftSources: ['scene', 'fader', 'cc', 'note'],
    recoverOnRelease: true,
    sendIntroductionOnConnect: true,
    sendIntroductionOnRecovery: true,
    sceneButtonsBlockedOnShift: true,
    recoverDelaysMs: [0, 80, 250, 800],
    ...(config.apc?.shiftBehavior || {})
  };
}

function shiftSwitchesPage() {
  return shiftBehavior().switchPage !== false;
}

function shouldBlockInternalShiftCombo(sourceType, event) {
  const behavior = shiftBehavior();
  if (sourceType === 'scene' && behavior.sceneButtonsBlockedOnShift !== false && (midi.shiftActive || event.shift || config.state?.currentPage === 2)) return true;
  if (sourceType === 'control') return false;
  if (behavior.guardInternalCombos === false) return false;
  if (!midi.shiftActive && !event.shift) return false;
  if (sourceType === 'shift' || sourceType === 'pad') return false;
  return (behavior.blockedShiftSources || []).includes(sourceType);
}

function rememberShiftGuard(sourceType, event) {
  const now = Date.now();
  if (now - lastShiftGuardReportAt < 1000) return;
  lastShiftGuardReportAt = now;
  const data = {
    source: 'shift-guard',
    message: 'Interne AKAI Shift-Kombination geblockt',
    details: {
      sourceType,
      note: event.note,
      controller: event.controller,
      event: event.event
    },
    at: new Date().toISOString()
  };
  console.warn('[shift-guard]', data.message, data.details);
  remember('errors', data);
  broadcast('error', data);
}

function scheduleHardwareLedRecovery(reason = '') {
  const delays = [...new Set(shiftBehavior().recoverDelaysMs || [0, 80, 250, 800])];
  for (const delay of delays) {
    if (Math.max(0, Number(delay) || 0) === 0) {
      recoverApcHardware(reason || 'led-recovery');
      continue;
    }

    const timer = setTimeout(() => {
      ledRecoveryTimers.delete(timer);
      recoverApcHardware(reason || 'led-recovery');
    }, Math.max(0, Number(delay) || 0));
    timer.unref?.();
    ledRecoveryTimers.add(timer);
  }
}

function recoverApcHardware(reason = 'led-recovery') {
  try {
    sendApcIntroductionSafe(reason);
    refreshAllLeds();
  } catch (error) {
    reportError(error, reason || 'led-recovery');
  }
}

function sendApcIntroductionSafe(reason = 'apc-introduction') {
  const behavior = shiftBehavior();
  const isConnect = reason === 'connect' || reason === 'midi-watch';
  if (isConnect && behavior.sendIntroductionOnConnect === false) return;
  if (!isConnect && behavior.sendIntroductionOnRecovery === false) return;
  if (!midi.getStatus().outputConnected) return;

  try {
    midi.sendApcIntroduction();
  } catch (error) {
    reportError(error, reason || 'apc-introduction');
  }
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

function startOscStateResendTimer() {
  if (oscStateResendTimer) {
    clearInterval(oscStateResendTimer);
    oscStateResendTimer = null;
  }

  const settings = oscStateResendSettings();
  if (!settings.enabled) {
    lastOscStateResend = {
      enabled: false,
      intervalMs: settings.intervalMs,
      sent: 0,
      at: new Date().toISOString()
    };
    return;
  }

  oscStateResendTimer = setInterval(() => {
    try {
      resendStoredOscStates('timer');
    } catch (error) {
      reportError(error, 'osc-resend');
    }
  }, settings.intervalMs);
  oscStateResendTimer.unref?.();
}

function oscStateResendSettings() {
  return {
    enabled: config.feedback?.resendStatesEnabled === true,
    intervalMs: Math.max(5000, Number(config.feedback?.resendStatesIntervalMs || 10000))
  };
}

function resendStoredOscStates(reason = 'timer') {
  const settings = oscStateResendSettings();
  if (reason !== 'manual' && !settings.enabled) {
    return { sent: 0, skipped: true, reason: 'disabled' };
  }

  if (!osc.getStatus().ready) {
    return { sent: 0, skipped: true, reason: 'osc-not-ready' };
  }

  const seenExec = new Set();
  const seenPlaybackLevel = new Set();
  const seenPlaybackFlash = new Set();
  const seenTenScene = new Set();
  const sent = [];
  const options = { silent: reason === 'timer' };

  for (const mapping of config.mappings || []) {
    const target = mapping.target || {};
    if (!target.type || target.type === 'disabled') continue;

    if (target.type === 'magicq-executor-fader') {
      const level = mappedFaderLevel(mapping);
      if (level === undefined) continue;
      const key = `${target.page}/${target.executor}`;
      if (!seenExec.has(key)) {
        seenExec.add(key);
        sent.push(sendExecutorLevel(target, level, options));
      }
      continue;
    }

    if (target.type === 'magicq-executor-button' || target.type === 'magicq-executor-adjust') {
      const key = `${target.page}/${target.executor}`;
      const state = executorState[key];
      if (!state || state.level === undefined || seenExec.has(key)) continue;
      seenExec.add(key);
      sent.push(sendExecutorLevel(target, state.level, options));
      continue;
    }

    if (target.type === 'magicq-playback-level' || target.type === 'magicq-playback-adjust') {
      const playback = String(target.playback || target.executor || 1);
      const level = mappedFaderLevel(mapping) ?? playbackState[playback]?.level;
      if (level !== undefined && !seenPlaybackLevel.has(playback)) {
        seenPlaybackLevel.add(playback);
        sent.push(sendPlaybackLevel(playback, level, options));
      }
      continue;
    }

    if (target.type === 'magicq-playback-flash') {
      const playback = String(target.playback || 1);
      const flash = playbackState[playback]?.flash;
      if (flash !== undefined && !seenPlaybackFlash.has(playback)) {
        seenPlaybackFlash.add(playback);
        sent.push(osc.send(`/pb/${playback}/flash`, [Number(flash) > 0 ? 1 : 0], options));
      }
      continue;
    }

    if (target.type === 'magicq-10scene') {
      const level = mappedFaderLevel(mapping);
      const key = `${target.item || 1}/${target.zone || 1}`;
      if (level !== undefined && !seenTenScene.has(key)) {
        seenTenScene.add(key);
        sent.push(sendTenSceneLevel(target, level, options));
      }
      continue;
    }

    if (target.type === 'magicq-dbo' && config.state?.dboActive !== undefined) {
      sent.push(osc.send('/dbo', [config.state.dboActive ? 1 : 0], options));
    }
  }

  lastOscStateResend = {
    enabled: settings.enabled,
    intervalMs: settings.intervalMs,
    reason,
    sent: sent.filter(Boolean).length,
    at: new Date().toISOString()
  };
  if (reason === 'manual') {
    broadcast('status', status());
  }
  return lastOscStateResend;
}

function mappedFaderLevel(mapping) {
  if (mapping?.source?.type !== 'fader') return undefined;
  const fader = config.state?.faders?.[mapping.source.cc];
  return fader && fader.level !== undefined ? fader.level : undefined;
}

function sendExecutorLevel(target, level, options = {}) {
  if (!Number.isFinite(Number(target.page)) || !Number.isFinite(Number(target.executor))) return null;
  return osc.send(`/exec/${target.page}/${target.executor}`, [percentToFloat(level)], options);
}

function sendPlaybackLevel(playback, level, options = {}) {
  return osc.send(`/pb/${playback}`, [clampPercent(level)], options);
}

function sendTenSceneLevel(target, level, options = {}) {
  return osc.send(`/10scene/${target.item || 1}/${target.zone || 1}`, [percentToFloat(level)], options);
}

async function startNetworkBackup() {
  if (networkBackupApplying) return;
  networkBackupApplying = true;
  try {
    const networkStatus = await applyBackupIp(config);
    lastNetworkBackupApply = networkStatus?.lastBackupApply || null;
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

  scheduleStateWrite();
}

function scheduleStateWrite(delayMs = 300) {
  if (pendingConfigWrite) clearTimeout(pendingConfigWrite);
  pendingConfigWrite = setTimeout(() => {
    pendingConfigWrite = null;
    config.state = writeState(config.state);
  }, delayMs);
}

function sendPressMapping(mapping, event) {
  const target = mapping.target || {};

  if (target.type === 'magicq-executor-button') {
    const nextLevel = resolveExecutorPressLevel(target);
    osc.sendForMapping(mapping, event, undefined, nextLevel);
    if (setExecutorState(target, nextLevel)) {
      refreshExecutorTargetLeds(target);
    }
    return;
  }

  if (target.type === 'magicq-executor-adjust') {
    const key = `${target.page}/${target.executor}`;
    const current = Number(executorState[key]?.level || 0);
    const nextLevel = clampPercent(current + Number(target.amount || 0));
    osc.sendForMapping(mapping, event, nextLevel);
    if (setExecutorState(target, nextLevel)) {
      refreshExecutorTargetLeds(target);
    }
    return;
  }

  if (target.type === 'magicq-playback-level') {
    const level = clampPercent(target.value ?? 100);
    osc.sendForMapping(mapping, event, level);
    if (setPlaybackLevel(target.playback || 1, level)) {
      applyLedSafe(mapping, level > 0);
    }
    return;
  }

  if (target.type === 'magicq-playback-adjust') {
    const playback = target.playback || 1;
    const current = Number(playbackState[playback]?.level || 0);
    const level = clampPercent(current + Number(target.amount || 0));
    osc.sendForMapping(mapping, event, level);
    if (setPlaybackLevel(playback, level)) {
      applyLedSafe(mapping, level > 0);
    }
    return;
  }

  if (target.type === 'magicq-playback-flash') {
    const playback = target.playback || 1;
    const nextFlash = playbackState[playback]?.flash ? 0 : 1;
    osc.sendForMapping(mapping, event, undefined, nextFlash);
    if (setPlaybackFlash(playback, nextFlash)) {
      applyLedSafe(mapping, nextFlash > 0);
    }
    return;
  }

  if (target.type === 'magicq-dbo' && target.action === 'toggle') {
    const nextDbo = config.state?.dboActive ? 0 : 1;
    osc.sendForMapping(mapping, event, undefined, nextDbo);
    if (setDboState(nextDbo)) {
      applyLedSafe(mapping, nextDbo > 0);
    }
    return;
  }

  osc.sendForMapping(mapping, event);

  if (localStateUpdatesEnabled() && target.type?.startsWith('magicq-') && target.type !== 'magicq-rpc') {
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

function setExecutorState(target, level, source = 'local') {
  if (source !== 'osc' && !localStateUpdatesEnabled()) return false;
  if (!Number.isFinite(Number(target.page)) || !Number.isFinite(Number(target.executor))) return false;
  const key = `${target.page}/${target.executor}`;
  const nextLevel = clampPercent(level);
  executorState[key] = {
    ...(executorState[key] || {}),
    level: nextLevel,
    active: nextLevel > 0,
    at: new Date().toISOString()
  };
  config.state = {
    ...(config.state || {}),
    executorState: {
      ...(config.state?.executorState || {}),
      [key]: executorState[key]
    }
  };
  scheduleStateWrite();
  return true;
}

function setPlaybackLevel(playback, level, source = 'local') {
  if (source !== 'osc' && !localStateUpdatesEnabled()) return false;
  const id = Number(playback || 1);
  const nextLevel = clampPercent(level);
  playbackState[id] = {
    ...(playbackState[id] || {}),
    level: nextLevel,
    active: nextLevel > 0,
    at: new Date().toISOString()
  };
  config.state = {
    ...(config.state || {}),
    playbackState: {
      ...(config.state?.playbackState || {}),
      [id]: playbackState[id]
    }
  };
  scheduleStateWrite();
  return true;
}

function setPlaybackFlash(playback, flash, source = 'local') {
  if (source !== 'osc' && !localStateUpdatesEnabled()) return false;
  const id = Number(playback || 1);
  playbackState[id] = {
    ...(playbackState[id] || {}),
    flash: Number(flash) > 0 ? 1 : 0,
    at: new Date().toISOString()
  };
  config.state = {
    ...(config.state || {}),
    playbackState: {
      ...(config.state?.playbackState || {}),
      [id]: playbackState[id]
    }
  };
  scheduleStateWrite();
  return true;
}

function setDboState(active, source = 'local') {
  if (source !== 'osc' && !localStateUpdatesEnabled()) return false;
  config.state = { ...(config.state || {}), dboActive: Boolean(active) };
  scheduleStateWrite();
  return true;
}

function updateFromOscFeedback(data) {
  const address = data.address || '';
  const firstArg = Array.isArray(data.args) ? data.args[0] : undefined;
  const execMatch = address.match(/^\/exec\/(\d+)\/(\d+)$/);
  const playbackMatch = address.match(/^\/pb\/(\d+)$/);
  const playbackFlashMatch = address.match(/^\/pb\/(\d+)\/flash$/);

  if (execMatch) {
    const target = { page: Number(execMatch[1]), executor: Number(execMatch[2]) };
    setExecutorState(target, oscLevelToPercent(firstArg), 'osc');
    refreshMappingsForTarget('magicq-executor-button', target);
    refreshMappingsForTarget('magicq-executor-fader', target);
    broadcast('status', status());
    return;
  }

  if (playbackMatch) {
    setPlaybackLevel(Number(playbackMatch[1]), oscLevelToPercent(firstArg), 'osc');
    broadcast('status', status());
    return;
  }

  if (playbackFlashMatch) {
    setPlaybackFlash(Number(playbackFlashMatch[1]), firstArg, 'osc');
    broadcast('status', status());
  }
}

function localStateUpdatesEnabled() {
  return config.feedback?.localStateUpdates !== false;
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

function percentToFloat(value) {
  return { type: 'f', value: clampPercent(value) / 100 };
}

function hydrateRuntimeState(state = {}) {
  replaceObject(executorState, state.executorState || {});
  replaceObject(playbackState, state.playbackState || {});
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source || {});
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
  if (sceneButtonsBlockedByShift()) {
    applyShiftSceneBlockedLeds();
    return;
  }
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
  if (sceneButtonsBlockedByShift()) applyShiftSceneBlockedLeds();
  else syncPageLeds();
}

function refreshCurrentLayerLeds() {
  if (!midi.getStatus().outputConnected) return;
  for (const mapping of config.mappings || []) {
    if (!mappingMatchesCurrentLayer(mapping)) continue;
    if (sceneButtonsBlockedByShift() && mapping.source?.type === 'scene') continue;
    const key = `${mapping.target?.page}/${mapping.target?.executor}`;
    const active = mappingActiveState(mapping, key);
    applyLedSafe(mapping, active);
  }
}

function refreshMappingsForTarget(type, target) {
  for (const mapping of config.mappings || []) {
    if (!mappingMatchesCurrentLayer(mapping)) continue;
    if (sceneButtonsBlockedByShift() && mapping.source?.type === 'scene') {
      applyShiftSceneBlockedLeds();
      continue;
    }
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
  if (sceneButtonsBlockedByShift() && mapping.source?.type === 'scene') {
    applyShiftSceneBlockedLeds();
    return;
  }
  const key = `${mapping.target?.page}/${mapping.target?.executor}`;
  applyLedSafe(mapping, mappingActiveState(mapping, key));
  syncPageLeds();
}

function sceneButtonsBlockedByShift() {
  return shiftBehavior().sceneButtonsBlockedOnShift !== false && (midi.shiftActive || config.state?.currentPage === 2);
}

function applyShiftSceneBlockedLeds() {
  if (!midi.getStatus().outputConnected) return;
  for (const note of config.apc.sceneNotes || []) {
    led.blinkPad(note, 1);
  }
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
