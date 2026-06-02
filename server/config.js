const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AKAI_MAGICQ_DATA_DIR || (process.pkg ? path.join(path.dirname(process.execPath), 'data') : __dirname);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const APC_DEFAULTS = {
  matrixNotes: Array.from({ length: 64 }, (_, index) => index),
  sceneNotes: Array.from({ length: 8 }, (_, index) => 112 + index),
  controlNotes: Array.from({ length: 8 }, (_, index) => 100 + index),
  shiftNote: 122,
  faderCcs: Array.from({ length: 9 }, (_, index) => 48 + index)
};

const LEGACY_APC_DEFAULTS = {
  sceneNotes: Array.from({ length: 8 }, (_, index) => 100 + index),
  controlNotes: Array.from({ length: 8 }, (_, index) => 64 + index),
  shiftNote: 98
};

function createDefaultMappings() {
  const padMappings = APC_DEFAULTS.matrixNotes.map((note, index) => ({
    id: `pad-${index}`,
    source: { type: 'pad', note },
    target: {
      type: 'magicq-executor-button',
      page: 1,
      executor: index + 1,
      action: 'toggle'
    },
    led: {
      offColor: 5,
      offMode: 'solid',
      onColor: 21,
      activeMode: 'solid'
    }
  }));

  const faderMappings = APC_DEFAULTS.faderCcs.map((cc, index) => ({
    id: `fader-${index + 1}`,
    source: { type: 'fader', cc },
    target: {
      type: 'magicq-executor-fader',
      page: 1,
      executor: index + 1
    },
    range: { min: 0, max: 100 }
  }));

  const sceneMappings = APC_DEFAULTS.sceneNotes.map((note, index) => ({
    id: `scene-page-${index + 1}`,
    source: { type: 'scene', note },
    target: {
      type: 'special',
      action: 'select-page',
      page: index + 1
    },
    led: {
      offColor: 0,
      offMode: 'off',
      onColor: 1,
      activeMode: 'solid'
    }
  }));

  const controlActions = [
    'release',
    'blackout',
    'previous-page',
    'next-page',
    'clear-leds',
    'osc-test',
    'reserved-1',
    'reserved-2'
  ];

  const controlMappings = APC_DEFAULTS.controlNotes.map((note, index) => ({
    id: `control-${controlActions[index]}`,
    source: { type: 'control', note },
    target: {
      type: 'special',
      action: controlActions[index]
    },
    led: {
      offColor: 0,
      offMode: 'off',
      onColor: 1,
      activeMode: 'solid'
    }
  }));

  return [...padMappings, ...faderMappings, ...sceneMappings, ...controlMappings];
}

const defaultConfig = {
  server: {
    host: '0.0.0.0',
    port: 3001,
    shutdownTimeoutMs: 2500
  },
  magicq: {
    ip: '192.168.178.50',
    sendPort: 8000,
    receivePort: 9000,
    feedbackOnStart: true,
    feedbackIntervalMs: 5000
  },
  midi: {
    input: '',
    output: '',
    watchIntervalMs: 1500,
    reconnectIntervalMs: 2000,
    deviceCacheTtlMs: 1000
  },
  network: {
    interface: 'eth0',
    backup: {
      enabled: true,
      applyOnStart: true,
      address: '192.168.50.10/24',
      refreshMs: 5000
    },
    main: {
      connection: '',
      mode: 'dhcp',
      address: '192.168.178.60/24',
      gateway: '192.168.178.1',
      dns: '192.168.178.1,1.1.1.1'
    }
  },
  apc: APC_DEFAULTS,
  ui: {
    recentEventLimit: 80
  },
  state: {
    faders: {},
    currentPage: 1
  },
  mappings: createDefaultMappings()
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(base[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8');
  }
}

function readConfig() {
  ensureConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return normalizeConfig(deepMerge(defaultConfig, parsed));
  } catch (error) {
    const brokenPath = `${CONFIG_PATH}.broken-${Date.now()}`;
    fs.renameSync(CONFIG_PATH, brokenPath);
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8');
    return {
      ...defaultConfig,
      _warning: `Invalid config moved to ${brokenPath}`
    };
  }
}

function writeConfig(nextConfig) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const merged = normalizeConfig(deepMerge(defaultConfig, nextConfig));
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

function updateConfig(patch) {
  const current = readConfig();
  return writeConfig(deepMerge(current, patch));
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { faders: {}, currentPage: 1 };
  }

  try {
    return deepMerge({ faders: {}, currentPage: 1 }, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch (error) {
    return { faders: {}, currentPage: 1 };
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const nextState = deepMerge({ faders: {}, currentPage: 1 }, state || {});
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  return nextState;
}

function normalizeConfig(config) {
  const next = deepMerge(defaultConfig, config);

  if (arraysEqual(next.apc.sceneNotes, LEGACY_APC_DEFAULTS.sceneNotes)) {
    next.apc.sceneNotes = APC_DEFAULTS.sceneNotes;
  }

  if (arraysEqual(next.apc.controlNotes, LEGACY_APC_DEFAULTS.controlNotes)) {
    next.apc.controlNotes = APC_DEFAULTS.controlNotes;
  }

  if (next.apc.shiftNote === LEGACY_APC_DEFAULTS.shiftNote) {
    next.apc.shiftNote = APC_DEFAULTS.shiftNote;
  }

  next.mappings = (next.mappings || []).map((mapping) => migrateMapping(mapping));
  next.state = next.state || { faders: {}, currentPage: 1 };
  next.state.faders = next.state.faders || {};
  next.state.currentPage = next.state.currentPage || 1;
  next.network = normalizeNetworkConfig(next.network);
  return next;
}

function normalizeNetworkConfig(network = {}) {
  const next = deepMerge(defaultConfig.network, network);
  const interfaceName = String(next.interface || next.backup?.interface || next.main?.interface || 'eth0').trim() || 'eth0';
  next.interface = interfaceName;
  next.backup.enabled = true;
  next.backup.applyOnStart = true;
  next.backup.interface = interfaceName;
  next.backup.address = String(next.backup.address || defaultConfig.network.backup.address).trim() || defaultConfig.network.backup.address;
  next.main.interface = interfaceName;
  next.main.connection = String(next.main.connection || '').trim();
  next.main.mode = next.main.mode === 'static' ? 'static' : 'dhcp';
  next.main.address = String(next.main.address || '').trim();
  next.main.gateway = String(next.main.gateway || '').trim();
  next.main.dns = String(next.main.dns || '').trim();
  return next;
}

function migrateMapping(mapping) {
  const next = JSON.parse(JSON.stringify(mapping));
  const source = next.source || {};

  if (source.type === 'scene') {
    const legacyIndex = LEGACY_APC_DEFAULTS.sceneNotes.indexOf(source.note);
    if (legacyIndex >= 0) source.note = APC_DEFAULTS.sceneNotes[legacyIndex];
    if (next.id?.startsWith('scene-page-')) {
      next.led = { offColor: 0, offMode: 'off', onColor: 1, activeMode: 'solid', ...(next.led || {}) };
      if (next.led.offColor === 1) next.led.offColor = 0;
      if (!next.led.offMode) next.led.offMode = next.led.offColor > 0 ? 'solid' : 'off';
      next.led.onColor = 1;
      next.led.activeMode = 'solid';
    }
  }

  if (source.type === 'control') {
    const legacyIndex = LEGACY_APC_DEFAULTS.controlNotes.indexOf(source.note);
    if (legacyIndex >= 0) source.note = APC_DEFAULTS.controlNotes[legacyIndex];
    if (next.id?.startsWith('control-')) {
      next.led = { offColor: 0, offMode: 'off', onColor: 1, activeMode: 'solid', ...(next.led || {}) };
      if (next.led.offColor === 1) next.led.offColor = 0;
      if (!next.led.offMode) next.led.offMode = next.led.offColor > 0 ? 'solid' : 'off';
      next.led.onColor = 1;
    }
  }

  if (source.type === 'shift' && source.note === LEGACY_APC_DEFAULTS.shiftNote) {
    source.note = APC_DEFAULTS.shiftNote;
  }

  if (source.type === 'fader') {
    source.shift = false;
    next.id = `fader-${source.cc}`;
  }

  next.source = source;
  return next;
}

function arraysEqual(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

module.exports = {
  APC_DEFAULTS,
  CONFIG_PATH,
  DATA_DIR,
  STATE_PATH,
  createDefaultMappings,
  defaultConfig,
  readConfig,
  readState,
  updateConfig,
  writeState,
  writeConfig
};
