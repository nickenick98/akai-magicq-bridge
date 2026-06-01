const EventEmitter = require('events');

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
  }

  listDevices(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && now - this.deviceCacheAt < this.deviceCacheTtlMs) {
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

  connect(config = this.config) {
    this.close();
    this.config = config;

    if (!easymidi) {
      const error = new Error(easymidiLoadError ? easymidiLoadError.message : 'easymidi not available');
      this.emit('error', error);
      this.emit('status', this.getStatus(error));
      return this.getStatus(error);
    }

    const devices = this.listDevices({ force: true });
    const inputName = config.midi.input || devices.inputs.find((name) => /APC Mini/i.test(name));
    const outputName = config.midi.output || devices.outputs.find((name) => /APC Mini/i.test(name));

    try {
      if (inputName) {
        this.input = new easymidi.Input(inputName);
        this.inputName = inputName;
        this.bindInput();
      }

      if (outputName) {
        this.output = new easymidi.Output(outputName);
        this.outputName = outputName;
      }
    } catch (error) {
      this.emit('error', error);
      this.emit('status', this.getStatus(error));
      return this.getStatus(error);
    }

    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  bindInput() {
    const forward = (eventName) => (message) => {
      const normalized = normalizeMidiEvent(eventName, message);
      if (normalized.note === this.config.apc.shiftNote) {
        this.shiftActive = normalized.event === 'noteon' && normalized.velocity > 0;
      }
      this.emit('midi', {
        ...normalized,
        shift: this.shiftActive,
        at: new Date().toISOString()
      });
    };

    this.input.on('noteon', forward('noteon'));
    this.input.on('noteoff', forward('noteoff'));
    this.input.on('cc', forward('cc'));
  }

  close() {
    if (this.input) {
      try {
        this.input.close();
      } catch (error) {
        this.emit('error', error);
      }
    }

    if (this.output) {
      try {
        this.output.close();
      } catch (error) {
        this.emit('error', error);
      }
    }

    this.input = null;
    this.output = null;
    this.inputName = '';
    this.outputName = '';
    this.shiftActive = false;
  }

  sendNote(note, velocity, channel = 0) {
    if (!this.output) {
      throw new Error('MIDI output is not connected');
    }
    this.output.send('noteon', { note: Number(note), velocity: Number(velocity), channel: Number(channel) });
  }

  getStatus(error) {
    return {
      input: this.inputName,
      output: this.outputName,
      inputConnected: Boolean(this.input),
      outputConnected: Boolean(this.output),
      shiftActive: this.shiftActive,
      error: error ? error.message : undefined
    };
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

module.exports = {
  MidiBridge,
  normalizeMidiEvent
};
