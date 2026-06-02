const EventEmitter = require('events');

class LedController extends EventEmitter {
  constructor(midiBridge) {
    super();
    this.midiBridge = midiBridge;
    this.timers = new Map();
    this.apc = null;
    this.pending = new Map();
    this.queue = [];
    this.queueTimer = null;
    this.sendSpacingMs = 3;
  }

  setApcLayout(apc) {
    this.apc = apc;
  }

  setPadColor(note, color) {
    this.setLed(note, color, 'solid');
  }

  setPadOff(note) {
    this.setLed(note, 0, 'off');
  }

  blinkPad(note, color) {
    this.setLed(note, color, 'blink');
  }

  pulsePad(note, color) {
    this.setLed(note, color, 'pulse');
  }

  clearAllPads(notes = []) {
    this.stopAll();
    this.clearQueue();
    const padNotes = notes.length ? notes : Array.from({ length: 64 }, (_, index) => index);
    for (const note of padNotes) {
      this.send(note, 0);
    }
  }

  applyMappingLed(mapping, active) {
    if (!mapping?.source) return;
    if (mapping.source.type === 'fader') return;

    const led = mapping.led || {};
    const note = mapping.source.note;
    if (!isValidMidiValue(note)) return;

    const color = active ? led.onColor || 21 : led.offColor || 0;
    const mode = active ? led.activeMode || 'solid' : led.offMode || (color > 0 ? 'solid' : 'off');

    if (mode === 'solid') {
      this.setPadColor(note, color);
    } else if (mode === 'blink') {
      this.blinkPad(note, color);
    } else if (mode === 'pulse') {
      this.pulsePad(note, color);
    } else {
      this.setPadOff(note);
    }
  }

  stopAll() {
    for (const note of this.timers.keys()) {
      this.stopTimer(note);
    }
  }

  stopTimer(note) {
    const timer = this.timers.get(note);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(note);
    }
  }

  send(note, color, channel = 0) {
    const normalizedNote = Number(note);
    if (!isValidMidiValue(normalizedNote)) return;

    const status = this.midiBridge.getStatus?.();
    if (status && !status.outputConnected) {
      throw new Error('MIDI output is not connected');
    }

    const key = String(normalizedNote);
    const command = {
      note: normalizedNote,
      velocity: clampMidiValue(color),
      channel: clampMidiValue(channel)
    };

    if (!this.pending.has(key)) {
      this.queue.push(key);
    }
    this.pending.set(key, command);
    this.pumpQueue();
  }

  setButtonLed(note, active) {
    this.setLed(note, active ? 1 : 0, active ? 'solid' : 'off');
  }

  setLed(note, color, mode = 'solid') {
    this.stopTimer(note);
    const normalizedNote = Number(note);
    if (!isValidMidiValue(normalizedNote)) return;

    const normalizedColor = clampMidiValue(color);

    if (this.isPad(normalizedNote)) {
      this.send(normalizedNote, mode === 'off' ? 0 : normalizedColor, rgbChannelForMode(mode));
      return;
    }

    this.send(normalizedNote, singleLedVelocity(mode, normalizedColor), 0);
  }

  isPad(note) {
    return !this.apc || (this.apc.matrixNotes || []).includes(Number(note));
  }

  pumpQueue() {
    if (this.queueTimer || this.queue.length === 0) return;

    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      const key = this.queue.shift();
      const command = this.pending.get(key);
      this.pending.delete(key);

      if (command) {
        try {
          this.midiBridge.sendNote(command.note, command.velocity, command.channel);
        } catch (error) {
          this.emit('error', error);
        }
      }

      this.pumpQueue();
    }, this.sendSpacingMs);
    this.queueTimer.unref?.();
  }

  clearQueue() {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    this.pending.clear();
    this.queue = [];
  }
}

function isValidMidiValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 127;
}

function rgbChannelForMode(mode) {
  if (mode === 'pulse') return 9;
  if (mode === 'blink') return 14;
  return 6;
}

function singleLedVelocity(mode, color) {
  if (mode === 'off') return 0;
  if (mode === 'blink' || mode === 'pulse') return 2;
  return 1;
}

function clampMidiValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(127, Math.round(number)));
}

module.exports = {
  LedController
};
