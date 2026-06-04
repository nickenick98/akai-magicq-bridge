const EventEmitter = require('events');
const { execFileSync } = require('child_process');
const fs = require('fs');

let easymidi = null;
let easymidiLoadError = null;

try {
  easymidi = require('easymidi');
} catch (error) {
  easymidiLoadError = error;
}

class MidiBridge extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.input = null;
    this.output = null;
    this.inputName = '';
    this.outputName = '';
    this.shiftActive = false;
    this.deviceCache = { inputs: [], outputs: [] };
    this.deviceCacheAt = 0;
    this.deviceCacheTtlMs = Number(config.midi?.deviceCacheTtlMs || 3000);
    this.connectedAt = '';
    this.lastEventAt = '';
    this.lastError = '';
  }

  listDevices(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && now - this.deviceCacheAt < this.deviceCacheTtlMs) {
      return this.deviceCache;
    }

    const alsaDevices = listAlsaDevices();
    if (alsaDevices) {
      this.deviceCache = alsaDevices;
      this.deviceCacheAt = now;
      return this.deviceCache;
    }

    if (!easymidi) {
      this.deviceCache = {
        inputs: [],
        outputs: [],
        error: easymidiLoadError ? easymidiLoadError.message : 'easymidi not available'
      };
      this.deviceCacheAt = now;
      return this.deviceCache;
    }

    try {
      this.deviceCache = {
        inputs: easymidi.getInputs(),
        outputs: easymidi.getOutputs()
      };
      this.deviceCacheAt = now;
      return this.deviceCache;
    } catch (error) {
      this.deviceCache = {
        inputs: [],
        outputs: [],
        error: error.message
      };
      this.deviceCacheAt = now;
      return this.deviceCache;
    }
  }

  connect(config = this.config, options = {}) {
    this.config = config;

    if (!easymidi) {
      const error = new Error(easymidiLoadError ? easymidiLoadError.message : 'easymidi not available');
      this.emit('error', error);
      this.emit('status', this.getStatus(error));
      return this.getStatus(error);
    }

    const devices = this.listDevices({ force: true });
    const inputName = resolveMidiDeviceName(config.midi.input, devices.inputs);
    const outputName = resolveMidiDeviceName(config.midi.output, devices.outputs);
    const keepExisting = Boolean(options.keepExisting);
    const force = Boolean(options.force);

    if (keepExisting) {
      const wantsInput = Boolean(config.midi.input) || Boolean(inputName);
      const wantsOutput = Boolean(config.midi.output) || Boolean(outputName);
      const missingInput = wantsInput && !inputName;
      const missingOutput = wantsOutput && !outputName;

      if ((this.input || this.output) && (missingInput || missingOutput)) {
        const error = new Error(`MIDI device not available yet: input=${inputName || config.midi.input || 'auto'} output=${outputName || config.midi.output || 'auto'}`);
        this.emit('status', this.getStatus(error));
        return this.getStatus(error);
      }
    }

    const inputReusable = sameOpenPort(this.input, this.inputName, inputName);
    const outputReusable = sameOpenPort(this.output, this.outputName, outputName);

    if (!force && inputReusable && outputReusable) {
      this.lastError = '';
      this.emit('status', this.getStatus());
      return this.getStatus();
    }

    if (!inputReusable) this.closeInput();
    if (!outputReusable) this.closeOutput();

    try {
      if (inputName && !this.input) {
        this.input = new easymidi.Input(inputName);
        this.inputName = inputName;
        this.connectedAt = new Date().toISOString();
        this.bindInput();
      }

      if (outputName && !this.output) {
        this.output = new easymidi.Output(outputName);
        this.outputName = outputName;
        this.connectedAt = this.connectedAt || new Date().toISOString();
      }
      this.lastError = '';
    } catch (error) {
      this.lastError = error.message;
      this.emit('error', error);
      this.emit('status', this.getStatus(error));
      return this.getStatus(error);
    }

    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  bindInput() {
    const forward = (eventName) => (message) => {
      const at = new Date().toISOString();
      const normalized = normalizeMidiEvent(eventName, message);
      if (normalized.note === this.config.apc.shiftNote) {
        this.shiftActive = normalized.event === 'noteon' && normalized.velocity > 0;
      }
      this.lastEventAt = at;
      this.emit('midi', {
        ...normalized,
        shift: this.shiftActive,
        at
      });
    };

    this.input.on('noteon', forward('noteon'));
    this.input.on('noteoff', forward('noteoff'));
    this.input.on('cc', forward('cc'));
  }

  close() {
    this.closeInput();
    this.closeOutput();
    this.shiftActive = false;
    this.connectedAt = '';
  }

  closeInput() {
    if (this.input) {
      try {
        if (this.input._input?.removeAllListeners) this.input._input.removeAllListeners('message');
        if (this.input.removeAllListeners) this.input.removeAllListeners();
        this.input.close();
      } catch (error) {
        this.emit('error', error);
      } finally {
        if (this.input) this.input._input = null;
      }
    }

    this.input = null;
    this.inputName = '';
  }

  closeOutput() {
    if (this.output) {
      try {
        this.output.close();
      } catch (error) {
        this.emit('error', error);
      } finally {
        if (this.output) this.output._output = null;
      }
    }

    this.output = null;
    this.outputName = '';
  }

  sendNote(note, velocity, channel = 0) {
    if (!this.output) {
      throw new Error('MIDI output is not connected');
    }
    this.output.send('noteon', { note: Number(note), velocity: Number(velocity), channel: Number(channel) });
  }

  sendSysex(bytes) {
    if (!this.output) {
      throw new Error('MIDI output is not connected');
    }

    const data = Array.from(bytes || []).map((value) => Number(value));
    if (data.length < 3 || data[0] !== 0xf0 || data[data.length - 1] !== 0xf7) {
      throw new Error('Invalid MIDI SysEx message');
    }

    this.output.send('sysex', data);
  }

  sendApcIntroduction() {
    this.sendSysex([0xf0, 0x47, 0x7f, 0x4f, 0x60, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0xf7]);
  }

  getStatus(error) {
    return {
      input: this.inputName,
      output: this.outputName,
      inputConnected: Boolean(this.input),
      outputConnected: Boolean(this.output),
      shiftActive: this.shiftActive,
      connectedAt: this.connectedAt || undefined,
      lastEventAt: this.lastEventAt || undefined,
      hardware: getMidiHardwarePresence(this.deviceCache),
      lastError: this.lastError || undefined,
      error: error ? error.message : undefined
    };
  }
}

function sameOpenPort(port, currentName, desiredName) {
  if (!desiredName) return !port;
  if (!port || currentName !== desiredName) return false;
  if (typeof port.isPortOpen !== 'function') return true;
  try {
    return Boolean(port.isPortOpen());
  } catch {
    return false;
  }
}

function normalizeMidiEvent(eventName, message) {
  const base = {
    type: 'midi',
    event: eventName,
    channel: message.channel || 0
  };

  if (eventName === 'cc') {
    return {
      ...base,
      controller: message.controller,
      value: message.value
    };
  }

  return {
    ...base,
    note: message.note,
    velocity: message.velocity
  };
}

function resolveMidiDeviceName(configuredName, available = []) {
  if (configuredName && available.includes(configuredName)) return configuredName;
  const apcDevice = available.find((name) => isApcDeviceName(name));
  if (apcDevice && (!configuredName || isApcDeviceName(configuredName))) {
    return apcDevice;
  }
  return configuredName ? '' : '';
}

function isApcDeviceName(name = '') {
  return /APC\s*Mini|APC mini mk2|APC/i.test(String(name));
}

function getMidiHardwarePresence(devices = {}) {
  const inputs = devices.inputs || [];
  const outputs = devices.outputs || [];
  const apcInputs = inputs.filter(isApcDeviceName);
  const apcOutputs = outputs.filter(isApcDeviceName);
  const linuxApcPresent = linuxApcHardwarePresent();
  return {
    apcPresent: apcInputs.length > 0 || apcOutputs.length > 0 || linuxApcPresent,
    linuxApcPresent,
    apcInputs,
    apcOutputs
  };
}

function linuxApcHardwarePresent() {
  if (process.platform !== 'linux') return false;
  const chunks = [];

  try {
    chunks.push(fs.readFileSync('/proc/asound/cards', 'utf8'));
  } catch {
    // Optional hardware hint.
  }

  try {
    chunks.push(fs.readdirSync('/dev/snd/by-id').join('\n'));
  } catch {
    // Optional hardware hint.
  }

  return chunks.some((chunk) => isApcDeviceName(chunk));
}

function listAlsaDevices() {
  if (process.platform !== 'linux') return null;

  try {
    const output = execFileSync('aconnect', ['-l'], {
      encoding: 'utf8',
      timeout: 750,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const ports = parseAconnectPorts(output);
    return { inputs: ports, outputs: ports, source: 'alsa' };
  } catch {
    return null;
  }
}

function parseAconnectPorts(output = '') {
  const ports = [];
  let client = null;
  let clientName = '';

  for (const line of output.split(/\r?\n/)) {
    const clientMatch = line.match(/^client\s+(\d+):\s+'([^']+)'/);
    if (clientMatch) {
      client = clientMatch[1];
      clientName = clientMatch[2].trim();
      continue;
    }

    const portMatch = line.match(/^\s+(\d+)\s+'([^']+)'/);
    if (client && portMatch) {
      const port = portMatch[1];
      const portName = portMatch[2].trim();
      ports.push(`${clientName}:${portName} ${client}:${port}`);
    }
  }

  return ports;
}

module.exports = {
  MidiBridge,
  getMidiHardwarePresence,
  isApcDeviceName,
  normalizeMidiEvent,
  resolveMidiDeviceName
};
