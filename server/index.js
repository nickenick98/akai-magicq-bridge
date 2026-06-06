const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');

const { DATA_DIR, readConfig, readState, updateConfig, writeConfig, writeState } = require('./config');
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
let oscResyncTimer = null;
let ledRecoveryTimers = new Set();
let lastMidiDeviceSignature = '';
let lastMidiReconnectAttemptAt = 0;
let lastMidiWatchReportAt = 0;
let lastShiftGuardReportAt = 0;
let networkBackupApplying = false;
let lastNetworkApply = null;
let lastNetworkBackupApply = null;
let lastOscResync = null;
let systemUpdateRunning = false;
let systemUpdateCheckRunning = false;
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const SYSTEM_UPDATE_GIT_TIMEOUT_MS = Number(process.env.AKAI_MAGICQ_UPDATE_GIT_TIMEOUT_MS || 15000);
const SYSTEM_UPDATE_STATUS_PATH = path.join(DATA_DIR, 'system-update.json');
const SYSTEM_UPDATE_LOG_PATH = path.join(DATA_DIR, 'system-update.log');

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
markSystemUpdateAfterStartup();

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
    server: {
      startedAt: SERVER_STARTED_AT,
      bootId: SERVER_BOOT_ID
    },
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
    oscResync: oscResyncStatus(),
    systemUpdate: systemUpdateStatus(),
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
    applyShiftMapping(event);
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
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = updateConfig(req.body || {});
  config.state = readState();
  led.setApcLayout(config.apc);
  reconnect();
  startNetworkBackupTimer();
  startOscResyncTimer();
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
    startOscResyncTimer();
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

app.post('/api/osc/resync', (req, res) => {
  try {
    const result = resyncMappedOscStates('manual');
    broadcast('status', status());
    res.json({ ok: true, ...result });
  } catch (error) {
    reportError(error, 'osc-resync');
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

app.get('/api/system/update', (req, res) => {
  res.json(systemUpdateStatus({ includeLog: true }));
});

app.post('/api/system/update/check', (req, res) => {
  try {
    const update = startSystemUpdateCheck();
    broadcast('status', status());
    res.json({ ok: true, update });
  } catch (error) {
    reportError(error, 'system-update-check');
    res.status(400).json({ ok: false, error: error.message, update: systemUpdateStatus({ includeLog: true }) });
  }
});

app.post('/api/system/update', (req, res) => {
  try {
    const update = startSystemUpdate();
    broadcast('status', status());
    res.json({ ok: true, update });
  } catch (error) {
    reportError(error, 'system-update');
    res.status(400).json({ ok: false, error: error.message, update: systemUpdateStatus({ includeLog: true }) });
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
startOscResyncTimer();

const port = Number(process.env.PORT || config.server.port || 3001);
const host = config.server.host || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`AKAI MagicQ bridge listening on http://${host}:${port}`);
  scheduleStartupSystemUpdateCheck();
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
  if (oscResyncTimer) {
    clearInterval(oscResyncTimer);
    oscResyncTimer = null;
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
  const behavior = {
    switchPage: true,
    guardInternalCombos: false,
    blockedShiftSources: ['scene', 'fader', 'cc', 'note'],
    recoverOnRelease: true,
    sendIntroductionOnConnect: false,
    sendIntroductionOnRecovery: false,
    sceneButtonsBlockedOnShift: true,
    recoverDelaysMs: [0, 80, 250, 800],
    ...(config.apc?.shiftBehavior || {})
  };
  behavior.guardInternalCombos = false;
  behavior.sendIntroductionOnConnect = false;
  behavior.sendIntroductionOnRecovery = false;
  return behavior;
}

function applyShiftMapping(event) {
  const mapping = findMapping(event, config, false);
  const targetType = mapping?.target?.type || 'shift-hold';
  config.state = config.state || { faders: {}, currentPage: 1 };

  if (targetType === 'shift-toggle') {
    if (!isPress(event)) return;
    config.state.currentPage = config.state.currentPage === 2 ? 1 : 2;
    return;
  }

  if (targetType === 'shift-hold') {
    config.state.currentPage = midi.shiftActive ? 2 : 1;
  }
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

function startOscResyncTimer() {
  if (oscResyncTimer) {
    clearInterval(oscResyncTimer);
    oscResyncTimer = null;
  }

  const settings = oscResyncSettings();
  lastOscResync = {
    ...(lastOscResync || {}),
    enabled: settings.enabled,
    intervalMs: settings.intervalMs
  };

  if (!settings.enabled) return;

  oscResyncTimer = setInterval(() => {
    try {
      resyncMappedOscStates('timer');
    } catch (error) {
      reportError(error, 'osc-resync');
    }
  }, settings.intervalMs);
  oscResyncTimer.unref?.();
}

function oscResyncSettings() {
  return {
    enabled: config.feedback?.oscResyncEnabled === true,
    intervalMs: Math.max(5000, Number(config.feedback?.oscResyncIntervalMs || 10000))
  };
}

function oscResyncStatus() {
  const settings = oscResyncSettings();
  return {
    enabled: settings.enabled,
    intervalMs: settings.intervalMs,
    ...(lastOscResync || {})
  };
}

function resyncMappedOscStates(reason = 'timer') {
  const settings = oscResyncSettings();
  if (reason !== 'manual' && !settings.enabled) {
    lastOscResync = {
      enabled: settings.enabled,
      intervalMs: settings.intervalMs,
      reason,
      sent: 0,
      skipped: true,
      skipReason: 'disabled',
      at: new Date().toISOString()
    };
    return lastOscResync;
  }

  if (!osc.getStatus().ready) {
    lastOscResync = {
      enabled: settings.enabled,
      intervalMs: settings.intervalMs,
      reason,
      sent: 0,
      skipped: true,
      skipReason: 'osc-not-ready',
      at: new Date().toISOString()
    };
    return lastOscResync;
  }

  const silent = reason !== 'manual';
  const sent = [];
  const seen = new Set();

  for (const mapping of config.mappings || []) {
    const target = mapping.target || {};
    if (!target.type || target.type === 'disabled') continue;

    if (target.type === 'magicq-executor-fader') {
      if (!hasExecutorAddress(target)) continue;
      const level = mappedFaderLevel(mapping);
      if (level !== undefined) sendUniqueOsc(seen, sent, `/exec/${target.page}/${target.executor}`, [percentToFloat(level)], { silent });
      continue;
    }

    if (target.type === 'magicq-executor-button' || target.type === 'magicq-executor-adjust') {
      if (!hasExecutorAddress(target)) continue;
      const key = `${target.page}/${target.executor}`;
      const state = executorState[key];
      if (state?.level !== undefined) sendUniqueOsc(seen, sent, `/exec/${target.page}/${target.executor}`, [percentToFloat(state.level)], { silent });
      continue;
    }

    if (target.type === 'magicq-playback-level' || target.type === 'magicq-playback-adjust') {
      const playback = target.playback || target.executor || 1;
      const level = mappedFaderLevel(mapping) ?? playbackState[playback]?.level;
      if (level !== undefined) sendUniqueOsc(seen, sent, `/pb/${playback}`, [clampPercent(level)], { silent });
      continue;
    }

    if (target.type === 'magicq-playback-flash') {
      const playback = target.playback || 1;
      const flash = playbackState[playback]?.flash;
      if (flash !== undefined) sendUniqueOsc(seen, sent, `/pb/${playback}/flash`, [Number(flash) > 0 ? 1 : 0], { silent });
      continue;
    }

    if (target.type === 'magicq-10scene') {
      const level = mappedFaderLevel(mapping);
      if (level !== undefined) {
        sendUniqueOsc(seen, sent, `/10scene/${target.item || 1}/${target.zone || 1}`, [percentToFloat(level)], { silent });
      }
      continue;
    }

    if (target.type === 'magicq-dbo' && config.state?.dboActive !== undefined) {
      sendUniqueOsc(seen, sent, '/dbo', [config.state.dboActive ? 1 : 0], { silent });
    }
  }

  lastOscResync = {
    enabled: settings.enabled,
    intervalMs: settings.intervalMs,
    reason,
    sent: sent.filter(Boolean).length,
    skipped: false,
    at: new Date().toISOString()
  };
  return lastOscResync;
}

function sendUniqueOsc(seen, sent, address, args, options = {}) {
  if (seen.has(address)) return null;
  seen.add(address);
  const result = osc.send(address, args, options);
  sent.push(result);
  return result;
}

function mappedFaderLevel(mapping) {
  if (mapping?.source?.type !== 'fader') return undefined;
  const fader = config.state?.faders?.[mapping.source.cc];
  return fader?.level;
}

function hasExecutorAddress(target) {
  return Number.isFinite(Number(target?.page)) && Number.isFinite(Number(target?.executor));
}

function systemUpdateStatus(options = {}) {
  const current = readSystemUpdateStatus();
  const statusData = {
    state: 'idle',
    running: systemUpdateRunning,
    checking: systemUpdateCheckRunning,
    githubReachable: null,
    updateAvailable: false,
    behind: 0,
    serviceName: systemServiceName(),
    ...(current || {}),
    running: systemUpdateRunning || current?.state === 'running' || current?.state === 'restarting',
    checking: systemUpdateCheckRunning || current?.state === 'checking',
    updateAvailable: current?.updateAvailable === true || Number(current?.behind || 0) > 0
  };

  if (options.includeLog) {
    statusData.log = readSystemUpdateLogTail();
  }

  return statusData;
}

function startSystemUpdateCheck(options = {}) {
  if (systemUpdateRunning) {
    throw new Error('Update laeuft bereits.');
  }

  if (systemUpdateCheckRunning) {
    return systemUpdateStatus({ includeLog: true });
  }

  if (process.platform !== 'linux') {
    throw new Error('Update-Pruefung per GUI ist nur auf dem Raspberry Pi/Linux aktiv.');
  }

  systemUpdateCheckRunning = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (options.clearLog !== false) fs.writeFileSync(SYSTEM_UPDATE_LOG_PATH, '', 'utf8');
  writeSystemUpdateStatus({
    ...readSystemUpdateStatus(),
    state: 'checking',
    running: false,
    checking: true,
    updateAvailable: false,
    githubReachable: null,
    step: 'git-fetch',
    checkSource: options.source || 'manual',
    checkedStartedAt: new Date().toISOString(),
    serviceName: systemServiceName(),
    error: ''
  });

  runSystemUpdateCheck(options.source || 'manual').catch((error) => {
    appendSystemUpdateLog(`FEHLER: ${error.message}`);
    writeSystemUpdateStatus({
      ...readSystemUpdateStatus(),
      state: 'github-offline',
      running: false,
      checking: false,
      updateAvailable: false,
      githubReachable: false,
      step: 'failed',
      checkSource: options.source || 'manual',
      error: error.message,
      checkedAt: new Date().toISOString(),
      serviceName: systemServiceName()
    });
    systemUpdateCheckRunning = false;
    broadcast('status', status());
  });

  return systemUpdateStatus({ includeLog: true });
}

function startSystemUpdate() {
  if (systemUpdateRunning) {
    throw new Error('Update laeuft bereits.');
  }

  if (systemUpdateCheckRunning) {
    throw new Error('Update-Pruefung laeuft gerade.');
  }

  if (process.platform !== 'linux') {
    throw new Error('System-Update per GUI ist nur auf dem Raspberry Pi/Linux aktiv.');
  }

  const current = systemUpdateStatus();
  if (current.githubReachable !== true) {
    throw new Error('GitHub ist aktuell nicht erreichbar. Bitte erst Update pruefen.');
  }

  if (current.updateAvailable !== true) {
    throw new Error('Kein Update verfuegbar.');
  }

  systemUpdateRunning = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYSTEM_UPDATE_LOG_PATH, '', 'utf8');
  const initialStatus = {
    state: 'running',
    running: true,
    startedAt: new Date().toISOString(),
    step: 'start',
    serviceName: systemServiceName()
  };
  writeSystemUpdateStatus(initialStatus);

  runSystemUpdate().catch((error) => {
    appendSystemUpdateLog(`FEHLER: ${error.message}`);
    writeSystemUpdateStatus({
      state: 'failed',
      running: false,
      step: 'failed',
      error: error.message,
      failedAt: new Date().toISOString(),
      serviceName: systemServiceName()
    });
    systemUpdateRunning = false;
    broadcast('status', status());
  });

  return systemUpdateStatus({ includeLog: true });
}

async function runSystemUpdateCheck(source = 'manual') {
  appendSystemUpdateLog(`Update-Pruefung gestartet (${source}).`);
  await runSystemUpdateCommand('Git Fetch', 'git', ['fetch', '--prune']);

  writeSystemUpdateStatus({ ...readSystemUpdateStatus(), step: 'check-update' });
  const updateInfo = await checkGitUpdateAvailable();
  writeSystemUpdateStatus({
    ...readSystemUpdateStatus(),
    state: updateInfo.behind > 0 ? 'update-available' : 'up-to-date',
    running: false,
    checking: false,
    updateAvailable: updateInfo.behind > 0,
    githubReachable: true,
    step: updateInfo.behind > 0 ? 'update-available' : 'up-to-date',
    checkSource: source,
    checkedAt: new Date().toISOString(),
    head: updateInfo.head,
    upstream: updateInfo.upstream,
    upstreamHead: updateInfo.upstreamHead,
    behind: updateInfo.behind,
    error: ''
  });
  appendSystemUpdateLog(`Aktueller Stand: ${updateInfo.head}`);
  appendSystemUpdateLog(`Upstream: ${updateInfo.upstream} (${updateInfo.upstreamHead})`);
  appendSystemUpdateLog(`Commits hinter Upstream: ${updateInfo.behind}`);
  systemUpdateCheckRunning = false;
  broadcast('status', status());
}

async function runSystemUpdate() {
  appendSystemUpdateLog('Update gestartet.');
  writeSystemUpdateStatus({ ...readSystemUpdateStatus(), step: 'git-fetch' });
  await runSystemUpdateCommand('Git Fetch', 'git', ['fetch', '--prune']);

  writeSystemUpdateStatus({ ...readSystemUpdateStatus(), step: 'check-update' });
  const updateInfo = await checkGitUpdateAvailable();
  appendSystemUpdateLog(`Aktueller Stand: ${updateInfo.head}`);
  appendSystemUpdateLog(`Upstream: ${updateInfo.upstream} (${updateInfo.upstreamHead})`);
  appendSystemUpdateLog(`Commits hinter Upstream: ${updateInfo.behind}`);

  if (updateInfo.behind <= 0) {
    writeSystemUpdateStatus({
      ...readSystemUpdateStatus(),
      state: 'up-to-date',
      running: false,
      step: 'up-to-date',
      checkedAt: new Date().toISOString(),
      head: updateInfo.head,
      upstream: updateInfo.upstream,
      upstreamHead: updateInfo.upstreamHead,
      behind: updateInfo.behind,
      githubReachable: true,
      updateAvailable: false
    });
    appendSystemUpdateLog('Kein Update vorhanden. Build und Neustart werden uebersprungen.');
    systemUpdateRunning = false;
    broadcast('status', status());
    return;
  }

  writeSystemUpdateStatus({
    ...readSystemUpdateStatus(),
    step: 'git-pull',
    behind: updateInfo.behind,
    githubReachable: true,
    updateAvailable: true
  });
  await runSystemUpdateCommand('Git Pull', 'git', ['pull', '--ff-only']);

  writeSystemUpdateStatus({ ...readSystemUpdateStatus(), step: 'build' });
  await runSystemUpdateCommand('Build', 'npm', ['run', 'build']);

  writeSystemUpdateStatus({
    ...readSystemUpdateStatus(),
    state: 'restarting',
    running: true,
    updateAvailable: false,
    behind: 0,
    githubReachable: true,
    step: 'restart',
    restartingAt: new Date().toISOString()
  });
  appendSystemUpdateLog('Build fertig. Service wird neu gestartet.');
  broadcast('status', status());

  const restart = restartServiceCommand();
  await runSystemUpdateCommand('Service Restart', restart.bin, restart.args);
}

function runSystemUpdateCommand(label, bin, args) {
  appendSystemUpdateLog(`\n### ${label}: ${bin} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    let finished = false;
    const child = spawn(bin, args, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      env: updateCommandEnv(bin)
    });
    const timeout = updateCommandTimeout(bin, label, child, reject, () => finished);

    child.stdout.on('data', (data) => appendSystemUpdateLog(data.toString()));
    child.stderr.on('data', (data) => appendSystemUpdateLog(data.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      finished = true;
      if (timeout) clearTimeout(timeout);
      appendSystemUpdateLog(`### ${label} beendet mit Code ${code}`);
      if (code === 0) resolve();
      else reject(new Error(`${label} fehlgeschlagen mit Code ${code}`));
    });
  });
}

async function checkGitUpdateAvailable() {
  const head = (await runSystemUpdateCommandCapture('Git HEAD', 'git', ['rev-parse', 'HEAD'])).trim();
  let upstream = '';
  try {
    upstream = (await runSystemUpdateCommandCapture('Git Upstream', 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    upstream = 'origin/main';
  }

  const upstreamHead = (await runSystemUpdateCommandCapture('Git Upstream HEAD', 'git', ['rev-parse', upstream])).trim();
  const behindText = (await runSystemUpdateCommandCapture('Git Behind Count', 'git', ['rev-list', '--count', `HEAD..${upstream}`])).trim();
  const behind = Math.max(0, Number(behindText) || 0);
  return { head, upstream, upstreamHead, behind };
}

function runSystemUpdateCommandCapture(label, bin, args) {
  appendSystemUpdateLog(`\n### ${label}: ${bin} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    let finished = false;
    const child = spawn(bin, args, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      env: updateCommandEnv(bin)
    });
    const timeout = updateCommandTimeout(bin, label, child, reject, () => finished);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      appendSystemUpdateLog(text);
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      appendSystemUpdateLog(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      finished = true;
      if (timeout) clearTimeout(timeout);
      appendSystemUpdateLog(`### ${label} beendet mit Code ${code}`);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${label} fehlgeschlagen mit Code ${code}: ${stderr || stdout}`));
    });
  });
}

function updateCommandEnv(bin) {
  if (bin !== 'git') return process.env;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo'
  };
}

function updateCommandTimeout(bin, label, child, reject, isFinished) {
  if (bin !== 'git' || !SYSTEM_UPDATE_GIT_TIMEOUT_MS) return null;
  return setTimeout(() => {
    if (isFinished()) return;
    const message = `${label} nach ${SYSTEM_UPDATE_GIT_TIMEOUT_MS}ms abgebrochen.`;
    appendSystemUpdateLog(message);
    child.kill('SIGTERM');
    reject(new Error(message));
  }, SYSTEM_UPDATE_GIT_TIMEOUT_MS);
}

function restartServiceCommand() {
  const service = systemServiceUnitName();
  if (process.getuid && process.getuid() === 0) {
    return { bin: 'systemctl', args: ['--no-block', 'restart', service] };
  }
  return { bin: 'sudo', args: ['-n', 'systemctl', '--no-block', 'restart', service] };
}

function systemServiceName() {
  return process.env.AKAI_MAGICQ_SERVICE || config.server?.serviceName || 'akai-magicq-bridge';
}

function systemServiceUnitName() {
  const service = systemServiceName();
  return service.endsWith('.service') ? service : `${service}.service`;
}

function readSystemUpdateStatus() {
  try {
    if (!fs.existsSync(SYSTEM_UPDATE_STATUS_PATH)) return null;
    return JSON.parse(fs.readFileSync(SYSTEM_UPDATE_STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeSystemUpdateStatus(nextStatus) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYSTEM_UPDATE_STATUS_PATH, `${JSON.stringify(nextStatus, null, 2)}\n`, 'utf8');
  return nextStatus;
}

function appendSystemUpdateLog(message) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SYSTEM_UPDATE_LOG_PATH, `${message.replace(/\r/g, '')}${message.endsWith('\n') ? '' : '\n'}`, 'utf8');
}

function readSystemUpdateLogTail() {
  try {
    if (!fs.existsSync(SYSTEM_UPDATE_LOG_PATH)) return '';
    const content = fs.readFileSync(SYSTEM_UPDATE_LOG_PATH, 'utf8');
    return content.slice(-12000);
  } catch {
    return '';
  }
}

function scheduleStartupSystemUpdateCheck() {
  if (process.platform !== 'linux') return;
  setTimeout(() => {
    try {
      startSystemUpdateCheck({ source: 'startup', clearLog: false });
      broadcast('status', status());
    } catch (error) {
      reportError(error, 'system-update-startup-check');
    }
  }, 2500);
}

function markSystemUpdateAfterStartup() {
  const current = readSystemUpdateStatus();
  if (!current) return;
  if (current.state === 'restarting') {
    writeSystemUpdateStatus({
      ...current,
      state: 'completed',
      running: false,
      checking: false,
      updateAvailable: false,
      behind: 0,
      step: 'completed',
      completedAt: new Date().toISOString()
    });
    appendSystemUpdateLog('Service ist nach Update wieder gestartet.');
  } else if (current.state === 'running') {
    writeSystemUpdateStatus({
      ...current,
      state: 'failed',
      running: false,
      checking: false,
      step: 'failed',
      error: 'Server wurde waehrend des Updates beendet.',
      failedAt: new Date().toISOString()
    });
  } else if (current.state === 'checking') {
    writeSystemUpdateStatus({
      ...current,
      state: 'idle',
      running: false,
      checking: false,
      step: 'idle',
      error: '',
      updateAvailable: false
    });
  }
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
  const key = `${target.page}/${target.executor}`;
  const nextLevel = clampPercent(level);
  executorState[key] = {
    ...(executorState[key] || {}),
    level: nextLevel,
    active: nextLevel > 0,
    at: new Date().toISOString()
  };
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
  return true;
}

function setDboState(active, source = 'local') {
  if (source !== 'osc' && !localStateUpdatesEnabled()) return false;
  config.state = { ...(config.state || {}), dboActive: Boolean(active) };
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
  const mode = shiftSceneButtonMode();
  for (const note of config.apc.sceneNotes || []) {
    if (mode === 'off') led.setPadOff(note);
    else if (mode === 'solid') led.setPadColor(note, 1);
    else led.blinkPad(note, 1);
  }
}

function shiftSceneButtonMode() {
  const mode = shiftBehavior().sceneButtonsOnShift;
  return ['off', 'solid', 'blink'].includes(mode) ? mode : 'blink';
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
