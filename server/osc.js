const EventEmitter = require('events');
const osc = require('osc');

class OscBridge extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.udpPort = null;
    this.ready = false;
    this.lastSentAt = null;
    this.lastReceivedAt = null;
    this.lastIgnoredAt = null;
  }

  start(config = this.config) {
    this.stop();
    this.config = config;

    this.udpPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: Number(config.magicq.receivePort),
      remoteAddress: config.magicq.ip,
      remotePort: Number(config.magicq.sendPort),
      metadata: true
    });

    this.udpPort.on('ready', () => {
      this.ready = true;
      this.emit('status', this.getStatus());
      if (this.config.magicq.feedbackOnStart !== false) {
        try {
          this.requestFeedback();
        } catch (error) {
          this.emit('error', error);
        }
      }
    });

    this.udpPort.on('message', (message, timeTag, info) => {
      const remoteAddress = info?.address || '';
      if (!isAllowedRemote(remoteAddress, this.config.magicq.ip)) {
        this.lastIgnoredAt = new Date().toISOString();
        this.emit('ignored', {
          address: message.address,
          remote: info ? `${info.address}:${info.port}` : undefined,
          expected: this.config.magicq.ip,
          at: this.lastIgnoredAt
        });
        return;
      }

      this.lastReceivedAt = new Date().toISOString();
      const data = {
        address: message.address,
        args: decodeArgs(message.args),
        remote: info ? `${info.address}:${info.port}` : undefined,
        at: this.lastReceivedAt
      };
      this.emit('received', data);
      this.emit('status', this.getStatus());
    });

    this.udpPort.on('error', (error) => {
      this.ready = false;
      this.emit('error', error);
      this.emit('status', this.getStatus(error));
    });

    this.udpPort.open();
  }

  stop() {
    if (!this.udpPort) return;
    try {
      this.udpPort.close();
    } catch (error) {
      this.emit('error', error);
    }
    this.udpPort = null;
    this.ready = false;
  }

  send(address, args = []) {
    if (!this.udpPort || !this.ready) {
      throw new Error('OSC port is not ready');
    }

    const message = {
      address,
      args: encodeArgs(args)
    };
    this.udpPort.send(message);

    this.lastSentAt = new Date().toISOString();
    const data = {
      address,
      args: decodeArgs(message.args),
      remote: `${this.config.magicq.ip}:${this.config.magicq.sendPort}`,
      at: this.lastSentAt
    };
    this.emit('sent', data);
    return data;
  }

  requestFeedback() {
    return this.send('/feedback/pb+exec', []);
  }

  sendForMapping(mapping, event, level, resolvedValue) {
    const target = mapping.target || {};

    if (target.type === 'disabled') {
      return null;
    }

    if (target.type === 'magicq-executor-fader') {
      return this.send(`/exec/${target.page}/${target.executor}`, [percentToFloat(level)]);
    }

    if (target.type === 'magicq-executor-button') {
      return this.send(`/exec/${target.page}/${target.executor}`, [
        percentToFloat(executorActionPercent(target, event, resolvedValue))
      ]);
    }

    if (target.type === 'magicq-executor-adjust') {
      return this.send(`/exec/${target.page}/${target.executor}`, [percentToFloat(level)]);
    }

    if (target.type === 'magicq-playback-level') {
      return this.send(`/pb/${target.playback || target.executor || 1}`, [clampPercent(level ?? target.value ?? 100)]);
    }

    if (target.type === 'magicq-playback-adjust') {
      return this.send(`/pb/${target.playback || 1}`, [clampPercent(level)]);
    }

    if (target.type === 'magicq-playback-action') {
      return this.sendPlaybackAction(target);
    }

    if (target.type === 'magicq-playback-flash') {
      const action = target.action || 'momentary';
      const value = action === 'toggle' ? resolvedValue : buttonActionValue(action, event);
      return this.send(`/pb/${target.playback || 1}/flash`, [value]);
    }

    if (target.type === 'magicq-playback-jump') {
      return this.send(`/pb/${target.playback || 1}/${target.cue || 1}`);
    }

    if (target.type === 'magicq-10scene') {
      return this.send(`/10scene/${target.item || 1}/${target.zone || 1}`, [
        { type: 'f', value: level === undefined ? Number(target.value ?? 1) : clampPercent(level) / 100 }
      ]);
    }

    if (target.type === 'magicq-dbo') {
      return this.send('/dbo', [dboActionValue(target.action, resolvedValue)]);
    }

    if (target.type === 'magicq-swap') {
      return this.send('/swap', [target.mode === 'swap' || target.value === 1 ? 1 : 0]);
    }

    if (target.type === 'magicq-rpc') {
      return this.send('/rpc', [target.command || '']);
    }

    if (target.type === 'special') {
      return this.sendSpecial(target);
    }

    throw new Error(`Unsupported mapping target: ${target.type || 'unknown'}`);
  }

  sendSpecial(target) {
    const action = target.action || 'unknown';
    if (action === 'blackout') return this.send('/dbo', [2]);
    if (action === 'release') return this.send('/release', [1]);
    if (action === 'select-page') return this.send('/page', [target.page || 1]);
    if (action === 'next-page') return this.send('/page/next', [1]);
    if (action === 'previous-page') return this.send('/page/previous', [1]);
    return this.send(`/special/${action}`, [1]);
  }

  sendPlaybackAction(target) {
    const playback = target.playback || 1;
    const action = target.action || 'go';
    if (action === 'pause') return this.send(`/pb/${playback}/pause`);
    if (action === 'release') return this.send(`/pb/${playback}/release`);
    return this.send(`/pb/${playback}/go`);
  }

  getStatus(error) {
    return {
      ready: this.ready,
      connected: this.ready && Boolean(this.lastReceivedAt),
      remote: `${this.config.magicq.ip}:${this.config.magicq.sendPort}`,
      localPort: this.config.magicq.receivePort,
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      lastIgnoredAt: this.lastIgnoredAt,
      feedbackOnStart: this.config.magicq.feedbackOnStart !== false,
      error: error ? error.message : undefined
    };
  }
}

function encodeArgs(args) {
  return (args || []).map((value) => {
    if (value && typeof value === 'object' && value.type && 'value' in value) return value;
    if (Number.isInteger(value)) return { type: 'i', value };
    if (typeof value === 'number') return { type: 'f', value };
    if (typeof value === 'boolean') return { type: 'i', value: value ? 1 : 0 };
    return { type: 's', value: String(value) };
  });
}

function decodeArgs(args = []) {
  return args.map((arg) => (arg && typeof arg === 'object' && 'value' in arg ? arg.value : arg));
}

function buttonActionValue(action, event) {
  if (action === 'off') return 0;
  if (action === 'on') return 1;
  if (action === 'release') return 0;
  if (action === 'flash' || action === 'momentary') return event.event === 'noteoff' || event.velocity === 0 ? 0 : 1;
  return 1;
}

function dboActionValue(action, resolvedValue) {
  if (action === 'off') return 0;
  if (action === 'on') return 1;
  if (resolvedValue !== undefined) return resolvedValue;
  return 2;
}

function executorActionPercent(target, event, resolvedValue) {
  if (resolvedValue !== undefined) return resolvedValue;
  if (target.action === 'release') return 0;
  if (target.action === 'flash') return buttonActionValue('flash', event) * 100;
  if (target.action === 'set-level') return clampPercent(target.value ?? 100);
  return 100;
}

function percentToFloat(value) {
  return { type: 'f', value: clampPercent(value) / 100 };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function isAllowedRemote(remoteAddress, expectedAddress) {
  const remote = normalizeIp(remoteAddress);
  const expected = normalizeIp(expectedAddress);
  return Boolean(remote && expected && remote === expected);
}

function normalizeIp(address = '') {
  return String(address).trim().replace(/^::ffff:/, '');
}

module.exports = {
  OscBridge,
  decodeArgs,
  encodeArgs
};
