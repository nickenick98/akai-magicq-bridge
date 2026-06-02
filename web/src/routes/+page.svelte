<script>
  import { onDestroy, onMount } from 'svelte';
  import ColorPicker from '$lib/ColorPicker.svelte';
  import EventList from '$lib/EventList.svelte';

  const API = '';
  const apcPalette = [
    '#000000', '#1E1E1E', '#7F7F7F', '#FFFFFF', '#FF4C4C', '#FF0000', '#590000', '#190000',
    '#FFBD6C', '#FF5400', '#591D00', '#271B00', '#FFFF4C', '#FFFF00', '#595900', '#191900',
    '#88FF4C', '#54FF00', '#1D5900', '#142B00', '#4CFF4C', '#00FF00', '#005900', '#001900',
    '#4CFF5E', '#00FF19', '#00590D', '#001902', '#4CFF88', '#00FF55', '#00591D', '#001F12',
    '#4CFFB7', '#00FF99', '#005935', '#001912', '#4CC3FF', '#00A9FF', '#004152', '#001019',
    '#4C88FF', '#0055FF', '#001D59', '#000819', '#4C4CFF', '#0000FF', '#000059', '#000019',
    '#874CFF', '#5400FF', '#190064', '#0F0030', '#FF4CFF', '#FF00FF', '#590059', '#190019',
    '#FF4C87', '#FF0054', '#59001D', '#220013', '#FF1500', '#993500', '#795100', '#436400',
    '#033900', '#005735', '#00547F', '#0000FF', '#00454F', '#2500CC', '#7F7F7F', '#202020',
    '#FF0000', '#BDFF2D', '#AFED06', '#64FF09', '#108B00', '#00FF87', '#00A9FF', '#002AFF',
    '#3F00FF', '#7A00FF', '#B21A7D', '#402100', '#FF4A00', '#88E106', '#72FF15', '#00FF00',
    '#3BFF26', '#59FF71', '#38FFCC', '#5B8AFF', '#3151C6', '#877FE9', '#D31DFF', '#FF005D',
    '#FF7F00', '#B9B000', '#90FF00', '#835D07', '#392B00', '#144C10', '#0D5038', '#15152A',
    '#16205A', '#693C1C', '#A8000A', '#DE513D', '#D86A1C', '#FFE126', '#9EE12F', '#67B50F',
    '#1E1E30', '#DCFF6B', '#80FFBD', '#9A99FF', '#8E66FF', '#404040', '#757575', '#E0FFFF',
    '#A00000', '#350000', '#1AD000', '#074200', '#B9B000', '#3F3100', '#B35F00', '#4B1502'
  ];
  const brightColorCodes = [0, 3, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 60, 72, 73, 76, 77, 80, 81, 84, 85, 88, 89, 92, 93, 96, 97, 101, 105, 113, 117, 121, 125, 127];
  const colorOptions = brightColorCodes.map((code) => ({ code, name: code === 0 ? 'Aus' : `100% ${code}`, hex: apcPalette[code] }));
  const targetTypeOptions = [
    ['disabled', 'Aus / deaktiviert'],
    ['magicq-executor-button', 'Executor Button / Level'],
    ['magicq-executor-fader', 'Executor Fader'],
    ['magicq-executor-adjust', 'Executor +/-'],
    ['magicq-playback-level', 'Playback Level'],
    ['magicq-playback-action', 'Playback Go/Pause/Release'],
    ['magicq-playback-flash', 'Playback Flash'],
    ['magicq-playback-adjust', 'Playback +/-'],
    ['magicq-playback-jump', 'Playback Cue Jump'],
    ['magicq-10scene', '10Scene Zone'],
    ['magicq-dbo', 'DBO'],
    ['magicq-swap', 'Swap'],
    ['magicq-rpc', 'RPC Command'],
    ['special', 'Bridge Spezialfunktion']
  ];
  const targetTypesBySource = {
    pad: [
      'disabled',
      'magicq-executor-button',
      'magicq-executor-adjust',
      'magicq-playback-level',
      'magicq-playback-action',
      'magicq-playback-flash',
      'magicq-playback-adjust',
      'magicq-playback-jump',
      'magicq-10scene',
      'magicq-dbo',
      'magicq-swap',
      'magicq-rpc',
      'special'
    ],
    scene: [
      'disabled',
      'magicq-executor-button',
      'magicq-executor-adjust',
      'magicq-playback-action',
      'magicq-playback-flash',
      'magicq-playback-adjust',
      'magicq-playback-jump',
      'magicq-dbo',
      'magicq-swap',
      'magicq-rpc',
      'special'
    ],
    control: [
      'disabled',
      'magicq-executor-button',
      'magicq-executor-adjust',
      'magicq-playback-action',
      'magicq-playback-flash',
      'magicq-playback-adjust',
      'magicq-playback-jump',
      'magicq-dbo',
      'magicq-swap',
      'magicq-rpc',
      'special'
    ],
    shift: ['disabled', 'special'],
    fader: ['disabled', 'magicq-executor-fader', 'magicq-playback-level', 'magicq-10scene']
  };
  const executorActions = ['toggle', 'flash', 'go', 'release', 'set-level'];
  const quickMapTargetOptions = [
    ['auto-executor', 'Auto Executor'],
    ['magicq-executor-button', 'Executor Button / Level'],
    ['magicq-executor-fader', 'Executor Fader'],
    ['disabled', 'Aus / deaktiviert']
  ];
  const playbackActions = ['go', 'pause', 'release'];
  const flashActions = ['momentary', 'toggle', 'on', 'off'];
  const dboActions = ['toggle', 'on', 'off'];
  const specialActions = ['select-page', 'next-page', 'previous-page', 'release', 'blackout', 'clear-leds', 'osc-test'];

  let config = null;
  let devices = { inputs: [], outputs: [] };
  let status = {};
  let recent = { midi: [], oscSent: [], oscReceived: [], errors: [] };
  let ws = null;
  let wsState = 'offline';
  let pollTimer = null;
  let ledClockTimer = null;
  let ledClock = Date.now();

  let activeLayer = 'normal';
  let previewState = 'live';
  let selected = null;
  let editor = null;
  let multiSelect = false;
  let selection = [];
  let notice = '';
  let error = '';
  let viewRevision = 0;

  let quickMapEnabled = false;
  let bulkLed = { offColor: 5, offMode: 'solid', onColor: 21, activeMode: 'solid' };
  let bulkLedEnabled = false;
  let bulkTargetEnabled = false;
  let bulkTarget = { type: 'disabled', action: 'off' };
  let quickMap = { targetType: 'auto-executor', page: 1, start: 1, action: 'toggle', value: 100 };

  let live = {
    notes: {},
    ccs: {},
    toggles: {},
    last: null,
    connectedAt: null
  };

  function bumpView() {
    viewRevision = (viewRevision + 1) % 1000000;
  }

  $: apc = config?.apc || {};
  $: matrix = apc.matrixNotes || Array.from({ length: 64 }, (_, index) => index);
  $: matrixDisplay = matrixToApcDisplay(matrix);
  $: scenes = apc.sceneNotes || Array.from({ length: 8 }, (_, index) => 112 + index);
  $: controls = apc.controlNotes || Array.from({ length: 8 }, (_, index) => 100 + index);
  $: faders = apc.faderCcs || Array.from({ length: 9 }, (_, index) => 48 + index);
  $: shiftNote = apc.shiftNote ?? 122;
  $: quickMapItems = quickMapSelection(selection, quickMap);
  $: quickMapCanSave = quickMapItems.length > 0;
  $: bulkApplyEnabled = selection.length > 0 && (bulkTargetEnabled || bulkLedEnabled || (quickMapEnabled && quickMapCanSave));

  onMount(async () => {
    await loadInitial();
    connectWs();
    pollTimer = setInterval(pollStatus, 500);
    ledClockTimer = setInterval(() => {
      ledClock = Date.now();
    }, 40);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (ledClockTimer) clearInterval(ledClockTimer);
    if (ws) ws.close();
  });

  async function loadInitial() {
    const [configResponse, devicesResponse, statusResponse] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/midi/devices'),
      fetch('/api/status')
    ]);
    config = await configResponse.json();
    devices = await devicesResponse.json();
    applyStatus(await statusResponse.json());
  }

  function connectWs() {
    if (ws) ws.close();
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}/ws`);
    wsState = 'connecting';

    ws.addEventListener('open', () => {
      wsState = 'online';
      live = { ...live, connectedAt: new Date().toISOString() };
    });

    ws.addEventListener('close', () => {
      wsState = 'offline';
      setTimeout(connectWs, 1000);
    });

    ws.addEventListener('error', () => {
      wsState = 'error';
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      handleMessage(message.type, message.data);
    });
  }

  function handleMessage(type, data) {
    if (type === 'status') applyStatus(data);
    if (type === 'midi-event') applyMidi(data);
    if (type === 'live-input') applyLiveInput(data);
    if (type === 'page-changed') applyPage(data);
    if (type === 'osc-sent') recent = { ...recent, oscSent: [data, ...(recent.oscSent || [])].slice(0, 80) };
    if (type === 'osc-received') recent = { ...recent, oscReceived: [data, ...(recent.oscReceived || [])].slice(0, 80) };
    if (type === 'error') recent = { ...recent, errors: [data, ...(recent.errors || [])].slice(0, 80) };
  }

  async function pollStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.ok) applyStatus(await response.json());
    } catch {
      // WebSocket reconnect handles visible connection status.
    }
  }

  function applyStatus(data) {
    if (!data) return;
    status = {
      ...data,
      state: {
        ...(data.state || {}),
        faders: {
          ...(status.state?.faders || {}),
          ...(data.state?.faders || {})
        }
      }
    };
    if (data.recent) recent = data.recent;
    if (data.liveInput) applyLiveInput(data.liveInput, false);
    if (data.midi?.shiftActive) activeLayer = 'shift';
    bumpView();
  }

  function applyLiveInput(data, updateLast = true) {
    if (!data) return;
    live = {
      ...live,
      notes: data.notes || live.notes,
      ccs: data.ccs || live.ccs,
      last: updateLast && data.last ? data.last : live.last
    };
    bumpView();
  }

  function applyPage(data) {
    if (data?.currentPage === 2) activeLayer = 'shift';
    if (data?.currentPage === 1) activeLayer = 'normal';
    status = { ...status, state: { ...(status.state || {}), ...(data || {}) } };
    bumpView();
  }

  function applyMidi(event, pushRecent = true) {
    if (!event) return;
    live = { ...live, last: event };
    if (pushRecent) recent = { ...recent, midi: [event, ...(recent.midi || [])].slice(0, 80) };

    if (event.event === 'cc') {
      const nextCcs = {
        ...live.ccs,
        [event.controller]: { value: event.value, at: event.at || new Date().toISOString() }
      };
      live = { ...live, ccs: nextCcs };
      updateFaderState(event.controller, event.value);
      bumpView();
      return;
    }

    if (event.note === shiftNote) {
      activeLayer = event.event === 'noteon' && event.velocity > 0 ? 'shift' : 'normal';
    }

    const eventAt = event.at || new Date().toISOString();
    let nextNotes = { ...live.notes };
    if (event.event === 'noteoff' || event.velocity === 0) {
      delete nextNotes[event.note];
    } else {
      nextNotes[event.note] = { velocity: event.velocity, at: eventAt };
    }
    live = { ...live, notes: nextNotes };

    if (event.event === 'noteoff' || event.velocity === 0) {
      updateFlashRelease(event);
    }

    if (event.event === 'noteon' && event.velocity > 0) {
      updateToggleForPress(event);
    }
    bumpView();
  }

  function updateFaderState(cc, midiValue) {
    const level = Math.round((Number(midiValue) / 127) * 100);
    status = {
      ...status,
      state: {
        ...(status.state || {}),
        faders: {
          ...(status.state?.faders || {}),
          [cc]: { ...(status.state?.faders?.[cc] || {}), midiValue, level, at: new Date().toISOString() }
        }
      }
    };
    bumpView();
  }

  function updateToggleForPress(event) {
    const type = noteSourceType(event.note);
    if (!type || type === 'shift') return;
    const mapping = mappingFor(type, event.note, event.shift ? 'shift' : activeLayer);
    if (mapping?.target?.type !== 'magicq-executor-button') return;
    const key = executorKey(mapping);
    if (!key) return;

    if (mapping.target.action === 'flash') {
      live = { ...live, toggles: { ...live.toggles, [key]: true } };
      setLocalExecutorState(key, 100);
      bumpView();
      return;
    }

    if (mapping.target.action === 'release') {
      live = { ...live, toggles: { ...live.toggles, [key]: false } };
      setLocalExecutorState(key, 0);
      bumpView();
      return;
    }

    if (mapping.target.action === 'go' || mapping.target.action === 'set-level') {
      live = { ...live, toggles: { ...live.toggles, [key]: true } };
      setLocalExecutorState(key, 100);
      bumpView();
      return;
    }

    const currentActive = executorActive(key);
    const nextActive = !currentActive;
    live = {
      ...live,
      toggles: {
        ...live.toggles,
        [key]: nextActive
      }
    };
    setLocalExecutorState(key, nextActive ? 100 : 0);
    bumpView();
  }

  function updateFlashRelease(event) {
    const type = noteSourceType(event.note);
    if (!type || type === 'shift') return;
    const mapping = mappingFor(type, event.note, event.shift ? 'shift' : activeLayer);
    if (mapping?.target?.type !== 'magicq-executor-button' || mapping.target.action !== 'flash') return;
    const key = executorKey(mapping);
    if (!key) return;
    live = { ...live, toggles: { ...live.toggles, [key]: false } };
    setLocalExecutorState(key, 0);
  }

  function executorActive(key) {
    if (!key) return false;
    if (status.executorState && key in status.executorState) return Boolean(status.executorState[key]?.active);
    return Boolean(live.toggles[key]);
  }

  function setLocalExecutorState(key, level) {
    status = {
      ...status,
      executorState: {
        ...(status.executorState || {}),
        [key]: {
          ...(status.executorState?.[key] || {}),
          level,
          active: Number(level) > 0,
          at: new Date().toISOString()
        }
      }
    };
  }

  function noteSourceType(note) {
    if (matrix.includes(note)) return 'pad';
    if (scenes.includes(note)) return 'scene';
    if (controls.includes(note)) return 'control';
    if (note === shiftNote) return 'shift';
    return null;
  }

  function layerForSource(type, layer = activeLayer) {
    return type === 'fader' ? 'normal' : layer;
  }

  function mappingFor(type, value, layer = activeLayer) {
    const sourceKey = type === 'fader' ? 'cc' : 'note';
    const effectiveLayer = layerForSource(type, layer);
    return (config?.mappings || []).find(
      (mapping) =>
        mapping.source?.type === type &&
        mapping.source?.[sourceKey] === value &&
        (type === 'fader' || Boolean(mapping.source?.shift) === (effectiveLayer === 'shift'))
    );
  }

  function createMapping(type, value, layer = activeLayer) {
    const sourceKey = type === 'fader' ? 'cc' : 'note';
    const isShift = type !== 'fader' && layerForSource(type, layer) === 'shift';
    return {
      id: `${isShift ? 'shift-' : ''}${type}-${value}`,
      source: { type, [sourceKey]: value, shift: isShift },
      target: {
        type: type === 'fader' ? 'magicq-executor-fader' : 'magicq-executor-button',
        page: isShift ? 2 : 1,
        executor: type === 'pad' ? value + 1 : 1,
        action: type === 'fader' ? 'set-level' : 'toggle',
        playback: 1,
        value: 100,
        amount: 10,
        cue: 1,
        item: 1,
        zone: 1,
        command: ''
      },
      led: { offColor: 5, offMode: 'solid', onColor: 21, activeMode: 'solid' },
      range: { min: 0, max: 100 }
    };
  }

  function withDefaults(mapping, type, value = 0) {
    const created = mapping || createMapping(type, value);
    const next = {
      ...created,
      target: { playback: 1, value: 100, amount: 10, cue: 1, item: 1, zone: 1, command: '', ...(created.target || {}) },
      led: { offColor: 5, offMode: 'solid', onColor: 21, activeMode: 'solid', ...(created.led || {}) },
      range: { min: 0, max: 100, ...(created.range || {}) }
    };
    if (!targetTypeAllowed(type, next.target.type)) {
      next.target = { ...next.target, type: 'disabled', action: 'off' };
      next.led = { ...next.led, offColor: 0, offMode: 'off', onColor: 0, activeMode: 'off' };
    }
    if (type === 'fader') {
      next.id = `fader-${value}`;
      next.source = { ...(next.source || {}), type: 'fader', cc: value, shift: false };
      next.led = { ...next.led, offColor: 0, offMode: 'off', onColor: 0, activeMode: 'off' };
    }
    return next;
  }

  function selectElement(type, value) {
    if (multiSelect) {
      toggleSelection(type, value);
      return;
    }
    selected = { type, value };
    editor = withDefaults(mappingFor(type, value) || createMapping(type, value), type, value);
    bumpView();
  }

  function activeFor(type, value, mapping) {
    if (mapping?.target?.type === 'disabled') return false;
    if (type === 'fader') return live.ccs[value] !== undefined;
    if (live.notes[value]) return true;
    if (mapping?.target?.type === 'magicq-playback-level' || mapping?.target?.type === 'magicq-playback-adjust') {
      return Boolean(status.playbackState?.[mapping.target.playback || 1]?.active);
    }
    if (mapping?.target?.type === 'magicq-playback-flash') {
      return Boolean(status.playbackState?.[mapping.target.playback || 1]?.flash);
    }
    if (mapping?.target?.type === 'magicq-dbo') return Boolean(status.state?.dboActive);
    const key = executorKey(mapping);
    if (key) return executorActive(key);
    return false;
  }

  function ledState(type, value) {
    const mapping = mappingFor(type, value);
    if (type === 'fader') {
      return { hasMapping: Boolean(mapping), active: activeFor(type, value, mapping), color: 0, mode: 'off' };
    }
    if (type === 'scene' || type === 'control' || type === 'shift') {
      const liveActive = activeFor(type, value, mapping);
      const previewActive = selected?.type === type && selected.value === value && previewState !== 'live' ? previewState === 'active' : liveActive;
      const led = mapping?.led || { offMode: 'off', activeMode: 'solid' };
      const mode = previewActive ? led.activeMode : led.offMode;
      return {
        hasMapping: Boolean(mapping),
        active: previewActive,
        color: mode === 'off' ? 0 : 1,
        mode
      };
    }
    const liveActive = activeFor(type, value, mapping);
    const previewActive = selected?.type === type && selected.value === value && previewState !== 'live' ? previewState === 'active' : liveActive;
    const led = mapping?.led || { offColor: 0, offMode: 'off', onColor: 21, activeMode: 'solid' };
    return {
      hasMapping: Boolean(mapping),
      active: previewActive,
      color: previewActive ? led.onColor : led.offColor,
      mode: previewActive ? led.activeMode : led.offMode
    };
  }

  function styleFor(type, value, clock = ledClock) {
    const state = ledState(type, value);
    const color = hardwareColor(type, state.color);
    const phase = syncedLedPhase(state.mode, clock);
    return `--control-color:${color};--control-text:${textColor(state.color)};--effect-color:${color};--blink-color:${phase.blinkOn ? color : '#050706'};--blink-brightness:${phase.blinkBrightness};--pulse-brightness:${phase.pulseBrightness};--pulse-shadow-size:${phase.pulseShadowSize};`;
  }

  function syncedLedPhase(mode, clock) {
    const blinkOn = mode !== 'blink' || Math.floor(clock / 250) % 2 === 0;
    const pulseCycle = (clock % 1000) / 1000;
    const pulseWave = (Math.sin(pulseCycle * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    const pulseLevel = pulseWave * pulseWave * (3 - 2 * pulseWave);
    const pulseBrightness = mode === 'pulse' ? (0.22 + 1.08 * pulseLevel).toFixed(3) : '1';
    return {
      blinkOn,
      blinkBrightness: blinkOn ? '1.18' : '1',
      pulseBrightness,
      pulseShadowSize: mode === 'pulse' ? `${(3 + 20 * pulseLevel).toFixed(1)}px` : '0px'
    };
  }

  function modeClass(type, value) {
    const mode = ledState(type, value).mode;
    if (mode === 'blink') return 'mode-blink';
    if (mode === 'pulse') return 'mode-pulse';
    if (mode === 'off') return 'mode-off';
    return 'mode-solid';
  }

  function readout(type, value) {
    const mapping = mappingFor(type, value);
    if (!mapping) return 'kein map';
    if (mapping?.target?.type === 'disabled') return 'aus';
    const target = targetReadout(mapping);
    if (type === 'fader') return `${target} ${faderLevel(value)}%`;
    const state = ledState(type, value);
    const led = ledReadout(type, mapping, state);
    return `${target} ${led}`;
  }

  function targetReadout(mapping) {
    const target = mapping?.target || {};
    if (target.type === 'magicq-executor-button') {
      const action = target.action === 'set-level' ? `${target.value ?? 100}%` : target.action || 'toggle';
      return `E${target.page || 1}/${target.executor || 1} ${action}`;
    }
    if (target.type === 'magicq-executor-fader') return `F${target.page || 1}/${target.executor || 1}`;
    if (target.type === 'magicq-executor-adjust') return `E${target.page || 1}/${target.executor || 1} ${target.amount ?? 10}`;
    if (target.type === 'magicq-playback-level') return `PB${target.playback || 1} ${target.value ?? 100}%`;
    if (target.type === 'magicq-playback-action') return `PB${target.playback || 1} ${target.action || 'go'}`;
    if (target.type === 'magicq-playback-flash') return `PB${target.playback || 1} flash`;
    if (target.type === 'magicq-playback-adjust') return `PB${target.playback || 1} ${target.amount ?? 10}`;
    if (target.type === 'magicq-playback-jump') return `PB${target.playback || 1} cue ${target.cue ?? 1}`;
    if (target.type === 'magicq-10scene') return `10S ${target.zone || 1}/${target.item || 1}`;
    if (target.type === 'magicq-dbo') return `DBO ${target.action || 'toggle'}`;
    if (target.type === 'magicq-swap') return `Swap ${target.mode || 'normal'}`;
    if (target.type === 'magicq-rpc') return 'RPC';
    if (target.type === 'special') return `Spez ${target.action || ''}`.trim();
    return target.type || 'map';
  }

  function ledReadout(type, mapping, state) {
    if (type === 'scene' || type === 'control' || type === 'shift') {
      const led = mapping?.led || {};
      return `${state.active ? 'A' : 'O'} ${led.offMode || 'off'}/${led.activeMode || 'solid'}`;
    }
    const led = mapping?.led || {};
    return `${led.offColor ?? 0}/${led.onColor ?? 21} ${state.active ? led.activeMode || 'solid' : led.offMode || 'off'}`;
  }

  function faderRaw(cc) {
    return status.state?.faders?.[cc]?.midiValue ?? live.ccs[cc]?.value ?? 0;
  }

  function faderLevel(cc) {
    return status.state?.faders?.[cc]?.level ?? (live.ccs[cc] ? Math.round((live.ccs[cc].value / 127) * 100) : 0);
  }

  function executorKey(mapping) {
    if (
      mapping?.target?.type !== 'magicq-executor-button' &&
      mapping?.target?.type !== 'magicq-executor-fader' &&
      mapping?.target?.type !== 'magicq-executor-adjust'
    ) {
      return '';
    }
    if (!mapping?.target?.page || !mapping?.target?.executor) return '';
    return `${mapping.target.page}/${mapping.target.executor}`;
  }

  function hardwareColor(type, colorCode) {
    if (type === 'scene') return '#00ff00';
    if (type === 'control') return '#ff0000';
    if (type === 'shift') return '#232c25';
    if (Number(colorCode) <= 0) return '#232c25';
    return apcPalette[Number(colorCode)] || '#232c25';
  }

  function textColor(colorCode) {
    return [3, 12, 13, 17, 53, 57, 85, 89, 93, 97, 101, 105, 125, 127].includes(Number(colorCode)) ? '#101412' : '#f8fafc';
  }

  function matrixToApcDisplay(notes) {
    const rows = [];
    for (let row = 7; row >= 0; row -= 1) rows.push(...notes.slice(row * 8, row * 8 + 8));
    return rows;
  }

  function selectionKey(type, value) {
    return `${layerForSource(type)}:${type}:${value}`;
  }

  function toggleSelection(type, value) {
    const key = selectionKey(type, value);
    selection = selection.some((item) => item.key === key)
      ? selection.filter((item) => item.key !== key)
      : [...selection, { key, layer: layerForSource(type), type, value }];
    bumpView();
  }

  function resetBulkState() {
    selection = [];
    quickMapEnabled = false;
    bulkTargetEnabled = false;
    bulkLedEnabled = false;
    selected = null;
    editor = null;
  }

  function finishBulkEdit() {
    resetBulkState();
    multiSelect = false;
    bumpView();
  }

  function cancelBulkEdit() {
    finishBulkEdit();
    notice = 'Mehrfachauswahl abgebrochen.';
  }

  function toggleMultiSelect() {
    if (multiSelect) {
      cancelBulkEdit();
      return;
    }
    resetBulkState();
    multiSelect = true;
    bumpView();
  }

  function isSelectedBulk(type, value) {
    return selection.some((item) => item.key === selectionKey(type, value));
  }

  function setEditorLed(key, value) {
    if (selected?.type === 'fader') return;
    editor = { ...editor, led: normalizeLedChange(editor.led || {}, key, value) };
    bumpView();
  }

  function setBulkLed(key, value) {
    bulkLed = normalizeLedChange(bulkLed, key, value);
  }

  function normalizeLedChange(led, key, value) {
    const next = { ...(led || {}), [key]: value };
    if (key === 'offColor') {
      if (Number(value) === 0) next.offMode = 'off';
      else if ((next.offMode || 'off') === 'off') next.offMode = 'solid';
    }
    if (key === 'onColor') {
      if (Number(value) === 0) next.activeMode = 'off';
      else if ((next.activeMode || 'off') === 'off') next.activeMode = 'solid';
    }
    return next;
  }

  function setBulkTarget(key, value) {
    bulkTarget = { ...bulkTarget, [key]: normalizeTargetValue(key, value) };
  }

  function setBulkTargetType(value) {
    bulkTarget = prepareTargetForType({ ...bulkTarget, type: value });
  }

  function setQuickMap(key, value) {
    quickMap = { ...quickMap, [key]: key === 'action' || key === 'targetType' ? value : Math.max(1, Number(value) || 1) };
  }

  function setTarget(key, value) {
    editor = { ...editor, target: { ...(editor.target || {}), [key]: normalizeTargetValue(key, value) } };
    bumpView();
  }

  function setTargetType(value) {
    const next = prepareTargetForType({ ...(editor.target || {}), type: value });
    if (next.type === 'disabled') {
      editor = { ...editor, target: next, led: { ...(editor.led || {}), offColor: 0, offMode: 'off', onColor: 0, activeMode: 'off' } };
      bumpView();
      return;
    }
    editor = { ...editor, target: next };
    bumpView();
  }

  function prepareTargetForType(target) {
    const next = { playback: 1, page: 1, executor: 1, value: 100, amount: 10, cue: 1, item: 1, zone: 1, command: '', ...(target || {}) };
    if (next.type === 'disabled') next.action = 'off';
    if (next.type === 'magicq-playback-action' && !playbackActions.includes(next.action)) next.action = 'go';
    if (next.type === 'magicq-playback-flash' && !flashActions.includes(next.action)) next.action = 'momentary';
    if (next.type === 'magicq-dbo' && !dboActions.includes(next.action)) next.action = 'toggle';
    if (next.type === 'special' && !specialActions.includes(next.action)) next.action = 'select-page';
    if (next.type === 'magicq-executor-button' && !executorActions.includes(next.action)) next.action = 'toggle';
    return next;
  }

  function targetOptionsFor(type) {
    const allowed = targetTypesBySource[type] || targetTypesBySource.pad;
    return targetTypeOptions.filter(([value]) => allowed.includes(value));
  }

  function bulkTargetOptions() {
    if (!selection.length) return [['disabled', 'Aus / deaktiviert']];
    const allowed = selection
      .map((item) => targetTypesBySource[item.type] || targetTypesBySource.pad)
      .reduce((left, right) => left.filter((value) => right.includes(value)));
    return targetTypeOptions.filter(([value]) => allowed.includes(value));
  }

  $: if (bulkTargetEnabled && !bulkTargetOptions().some(([value]) => value === bulkTarget.type)) {
    bulkTarget = prepareTargetForType({ type: bulkTargetOptions()[0]?.[0] || 'disabled' });
  }

  function targetTypeAllowed(sourceType, targetType) {
    return (targetTypesBySource[sourceType] || targetTypesBySource.pad).includes(targetType || 'disabled');
  }

  function hasLedControls(type) {
    return type === 'pad' || type === 'scene' || type === 'control' || type === 'shift';
  }

  function hasRgbLedControls(type) {
    return type === 'pad';
  }

  function ledTitle(type) {
    if (type === 'scene') return 'Scene LEDs sind beim APC fest gruen: nur aus, an oder blink.';
    if (type === 'control') return 'Control LEDs sind beim APC fest rot: nur aus, an oder blink.';
    if (type === 'shift') return 'Shift hat keine frei steuerbare RGB LED.';
    return '';
  }

  function normalizeTargetValue(key, value) {
    if (['page', 'executor', 'playback', 'value', 'amount', 'cue', 'item', 'zone'].includes(key)) {
      return Number(value);
    }
    return value;
  }

  function upsertLocalMapping(mapping) {
    const mappings = [...(config.mappings || [])];
    const sourceKey = mapping.source?.type === 'fader' ? 'cc' : 'note';
    const sourceShift = mapping.source?.type === 'fader' ? false : Boolean(mapping.source?.shift);
    const sourceIndex = mappings.findIndex(
      (item) =>
        item.source?.type === mapping.source?.type &&
        item.source?.[sourceKey] === mapping.source?.[sourceKey] &&
        (mapping.source?.type === 'fader' || Boolean(item.source?.shift) === sourceShift)
    );
    const idIndex = mappings.findIndex((item) => item.id === mapping.id);
    const idCollidesWithOtherSource =
      sourceIndex < 0 &&
      idIndex >= 0 &&
      (mappings[idIndex].source?.type !== mapping.source?.type ||
        mappings[idIndex].source?.[sourceKey] !== mapping.source?.[sourceKey] ||
        (mapping.source?.type !== 'fader' && Boolean(mappings[idIndex].source?.shift) !== sourceShift));
    const nextMapping = structuredClone(mapping);
    if (nextMapping.source?.type === 'fader') {
      nextMapping.id = `fader-${nextMapping.source?.[sourceKey]}`;
      nextMapping.source.shift = false;
    }
    if (idCollidesWithOtherSource) nextMapping.id = `${sourceShift ? 'shift-' : ''}${mapping.source?.type}-${mapping.source?.[sourceKey]}`;
    const index = sourceIndex >= 0 ? sourceIndex : idCollidesWithOtherSource ? -1 : idIndex;
    if (index >= 0) mappings[index] = nextMapping;
    else mappings.push(nextMapping);
    config = { ...config, mappings };
    bumpView();
  }

  async function saveMapping() {
    const response = await api('/api/mappings', { method: 'POST', body: editor });
    config = { ...config, mappings: await response.json() };
    notice = 'Mapping gespeichert.';
    selected = null;
    editor = null;
    bumpView();
  }

  function cancelMappingEdit() {
    selected = null;
    editor = null;
    previewState = 'live';
    notice = 'Mapping Bearbeitung abgebrochen.';
    bumpView();
  }

  async function applyBulkEdit() {
    if (!quickMapEnabled && !bulkTargetEnabled && !bulkLedEnabled) {
      notice = 'Bitte Quick Mapping, Zieltyp oder Farbe/LED anhaken.';
      return;
    }

    const changed = [];
    const mappings = [...(config.mappings || [])];
    const quickIndexByKey = new Map(quickMapItems.map((item, index) => [item.key, index]));

    for (const item of selection) {
      const mapping = withDefaults(mappingFor(item.type, item.value, item.layer) || createMapping(item.type, item.value, item.layer), item.type, item.value);
      let changedItem = false;

      if (bulkTargetEnabled) {
        mapping.target = mergeBulkTarget(mapping.target || {}, bulkTarget);
        changedItem = true;
        if (mapping.target.type === 'disabled') {
          mapping.led = { ...(mapping.led || {}), offColor: 0, offMode: 'off', onColor: 0, activeMode: 'off' };
        }
      }

      if (quickMapEnabled && quickIndexByKey.has(item.key)) {
        mapping.target = prepareTargetForType({ ...(mapping.target || {}), ...quickMapTargetFor(item, quickIndexByKey.get(item.key), quickMap) });
        changedItem = true;
      }

      if (bulkLedEnabled && item.type !== 'fader' && mapping.target.type !== 'disabled') {
        mapping.led = { ...(mapping.led || {}), ...bulkLed };
        changedItem = true;
      }
      if (!changedItem) continue;
      const index = mappings.findIndex((existing) => existing.id === mapping.id);
      if (index >= 0) mappings[index] = mapping;
      else mappings.push(mapping);
      changed.push(mapping);
    }

    if (!changed.length) {
      notice = 'Keine passenden Elemente fuer diese Mehrfachauswahl.';
      return;
    }

    config = { ...config, mappings };
    bumpView();
    const response = await api('/api/mappings/bulk', { method: 'POST', body: { mappings: changed } });
    const data = await response.json();
    config = { ...config, mappings: data.mappings };
    notice = `${changed.length} Mappings gespeichert.`;
    await api('/api/led/refresh', { method: 'POST' });
    finishBulkEdit();
  }

  function quickMapSelection(items = selection, settings = quickMap) {
    return items.filter((item) => item.type !== 'shift' && Boolean(quickMapTargetFor(item, 0, settings)));
  }

  function sourceLabel(item) {
    if (item.type === 'pad') return `Pad ${item.value}`;
    if (item.type === 'scene') return `S${scenes.indexOf(item.value) + 1}`;
    if (item.type === 'control') return `C${controls.indexOf(item.value) + 1}`;
    if (item.type === 'fader') return `F${faders.indexOf(item.value) + 1}`;
    return item.type;
  }

  function quickMapTargetFor(item, index, settings = quickMap) {
    const targetType = settings.targetType || 'auto-executor';
    const page = Math.max(1, Number(settings.page) || 1);
    const executor = Math.max(1, Number(settings.start) || 1) + index;
    if (targetType === 'disabled') return { type: 'disabled', action: 'off' };
    if (targetType === 'auto-executor') {
      return item.type === 'fader'
        ? { type: 'magicq-executor-fader', page, executor }
        : {
            type: 'magicq-executor-button',
            page,
            executor,
            action: settings.action || 'toggle',
            value: settings.action === 'set-level' ? Math.max(0, Math.min(100, Number(settings.value) || 0)) : 100
          };
    }
    if (!targetTypeAllowed(item.type, targetType)) return null;
    if (targetType === 'magicq-executor-fader') return { type: targetType, page, executor };
    if (targetType === 'magicq-executor-button') {
      return {
        type: targetType,
        page,
        executor,
        action: settings.action || 'toggle',
        value: settings.action === 'set-level' ? Math.max(0, Math.min(100, Number(settings.value) || 0)) : 100
      };
    }
    return null;
  }

  function quickMapDestinationLabel(item, index) {
    const target = quickMapTargetFor(item, index);
    if (!target) return 'nicht moeglich';
    if (target.type === 'disabled') return 'Aus';
    if (target.type === 'magicq-executor-fader') return `Fader ${target.page}/${target.executor}`;
    if (target.action === 'set-level') return `Button ${target.page}/${target.executor} ${target.value}%`;
    return `Button ${target.page}/${target.executor} ${target.action || 'toggle'}`;
  }

  function mergeBulkTarget(current, bulk) {
    const next = prepareTargetForType({ ...current, type: bulk.type });
    const keys = ['action', 'mode', 'page', 'executor', 'playback', 'value', 'amount', 'cue', 'item', 'zone', 'command'];
    for (const key of keys) {
      if (bulk[key] !== undefined && bulk[key] !== '') next[key] = bulk[key];
    }
    return prepareTargetForType(next);
  }

  async function previewLed(note, active) {
    const led = editor?.led || {};
    await api('/api/led/test', {
      method: 'POST',
      body: {
        note,
        color: active ? led.onColor : led.offColor,
        mode: active ? led.activeMode : led.offMode
      },
      quiet: true
    });
  }

  async function api(url, options = {}) {
    error = '';
    const init = { method: options.method || 'GET' };
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(await response.text());
      return response;
    } catch (err) {
      if (!options.quiet) error = `${url}: ${err.message}`;
      throw err;
    }
  }

  async function saveConnection() {
    const response = await api('/api/config', { method: 'POST', body: config });
    config = await response.json();
    bumpView();
  }

  async function reconnect() {
    status = await (await api('/api/reconnect', { method: 'POST' })).json();
    devices = await (await api('/api/midi/devices')).json();
    bumpView();
  }

  async function saveNetwork() {
    config.network.backup.enabled = true;
    config.network.backup.applyOnStart = true;
    config.network.backup.address = normalizeBackupAddress(config.network.backup.address);
    const response = await api('/api/network', { method: 'POST', body: config.network });
    const data = await response.json();
    status = { ...status, network: data };
    notice = 'Netzwerk gespeichert.';
    bumpView();
  }

  async function applyNetwork() {
    config.network.backup.enabled = true;
    config.network.backup.applyOnStart = true;
    config.network.backup.address = normalizeBackupAddress(config.network.backup.address);
    const response = await api('/api/network/apply', { method: 'POST', body: config.network });
    const data = await response.json();
    status = { ...status, network: data.network };
    notice = data.ok ? 'Netzwerk auf Raspberry angewendet.' : 'Backup-IP wurde versucht, Haupt-IP/DHCP hat Fehler gemeldet.';
    error = data.error || '';
    bumpView();
  }

  async function exportBackup() {
    const response = await api('/api/backup');
    const backup = await response.json();
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `akai-magicq-bridge-backup-${stamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const backup = JSON.parse(await file.text());
    const response = await api('/api/backup/restore', { method: 'POST', body: backup });
    const data = await response.json();
    config = data.config;
    status = { ...status, state: data.state };
    notice = 'Sicherung wiederhergestellt. Backup-IP blieb lokal erhalten.';
    bumpView();
  }

  function interfaceAddresses() {
    return (status.network?.interfaces || []).flatMap((item) =>
      (item.addresses || []).map((address) => ({
        name: item.name,
        ...address
      }))
    );
  }

  function normalizeBackupAddress(value) {
    const address = String(value || '').trim();
    return address || '192.168.50.10/24';
  }

  function setApcShiftBehavior(key, value) {
    config = {
      ...config,
      apc: {
        ...(config.apc || {}),
        shiftBehavior: {
          switchPage: true,
          guardInternalCombos: true,
          blockedShiftSources: ['scene', 'control', 'fader', 'cc', 'note'],
          recoverOnRelease: true,
          sendIntroductionOnConnect: true,
          sendIntroductionOnRecovery: true,
          recoverDelaysMs: [0, 80, 250, 800],
          ...(config.apc?.shiftBehavior || {}),
          [key]: value
        }
      }
    };
    bumpView();
  }

  async function saveMidiSelection() {
    const data = await (await api('/api/midi/select', { method: 'POST', body: config.midi })).json();
    config = data.config;
    status = { ...status, midi: data.status };
    bumpView();
  }

  async function deleteMapping() {
    if (!editor?.id) return;
    const offMapping = withDefaults(editor, selected?.type || editor.source?.type || 'pad', selected?.value ?? editor.source?.note ?? editor.source?.cc ?? 0);
    offMapping.target = { ...(offMapping.target || {}), type: 'disabled', action: 'off' };
    offMapping.led = { ...(offMapping.led || {}), offColor: 0, offMode: 'off', onColor: 0, activeMode: 'off' };
    const response = await api('/api/mappings', { method: 'POST', body: offMapping });
    config = { ...config, mappings: await response.json() };
    await api('/api/led/refresh', { method: 'POST' });
    notice = 'Mapping auf Aus gesetzt.';
    editor = null;
    selected = null;
    bumpView();
  }

  async function setLayer(layer) {
    activeLayer = layer;
    if (selected) selectElement(selected.type, selected.value);
    try {
      await api('/api/page', { method: 'POST', body: { currentPage: layer === 'shift' ? 2 : 1 }, quiet: true });
    } catch {
      // The UI layer still changes locally if the backend is reconnecting.
    }
    bumpView();
  }
</script>

<svelte:head>
  <title>APC MagicQ Bridge</title>
</svelte:head>

<main>
  <header class="topbar">
    <div>
      <h1>APC MagicQ Bridge</h1>
      <p>Live MIDI, OSC und LED Mapping</p>
    </div>
    <div class="status-row">
      <span class:ok={wsState === 'online'} class="pill">WS {wsState}</span>
      <span class:ok={status.midi?.inputConnected} class="pill">MIDI In {status.midi?.inputConnected ? 'ok' : 'off'}</span>
      <span class:ok={status.midi?.outputConnected} class="pill">MIDI Out {status.midi?.outputConnected ? 'ok' : 'off'}</span>
      <span class:ok={status.osc?.ready} class="pill">OSC {status.osc?.ready ? 'ready' : 'off'}</span>
    </div>
  </header>

  {#if config}
    <section class="connection">
      <div class="section-head">
        <h2>Verbindung</h2>
        <div class="actions">
          <button on:click={saveConnection}>Speichern</button>
          <button class="secondary" on:click={reconnect}>Neu verbinden</button>
        </div>
      </div>
      <div class="fields">
        <label><span>MagicQ IP</span><input bind:value={config.magicq.ip} /></label>
        <label><span>Send Port</span><input type="number" bind:value={config.magicq.sendPort} /></label>
        <label><span>Receive Port</span><input type="number" bind:value={config.magicq.receivePort} /></label>
        <label>
          <span>MIDI Input</span>
          <select bind:value={config.midi.input} on:change={saveMidiSelection}>
            <option value="">Auto</option>
            {#each devices.inputs || [] as input}<option value={input}>{input}</option>{/each}
          </select>
        </label>
        <label>
          <span>MIDI Output</span>
          <select bind:value={config.midi.output} on:change={saveMidiSelection}>
            <option value="">Auto</option>
            {#each devices.outputs || [] as output}<option value={output}>{output}</option>{/each}
          </select>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.apc?.shiftBehavior?.switchPage !== false}
            on:change={(event) => setApcShiftBehavior('switchPage', event.currentTarget.checked)}
          />
          <span>Shift schaltet Seite 2</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.apc?.shiftBehavior?.guardInternalCombos !== false}
            on:change={(event) => setApcShiftBehavior('guardInternalCombos', event.currentTarget.checked)}
          />
          <span>AKAI Shift-Kombis blocken</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.apc?.shiftBehavior?.sendIntroductionOnConnect !== false}
            on:change={(event) => setApcShiftBehavior('sendIntroductionOnConnect', event.currentTarget.checked)}
          />
          <span>APC Host-Modus beim Verbinden setzen</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={config.apc?.shiftBehavior?.sendIntroductionOnRecovery !== false}
            on:change={(event) => setApcShiftBehavior('sendIntroductionOnRecovery', event.currentTarget.checked)}
          />
          <span>APC Host-Modus nach Shift reparieren</span>
        </label>
      </div>
    </section>

    <section class="backup">
      <div class="section-head">
        <h2>Sicherung</h2>
        <div class="actions">
          <button class="secondary" on:click={exportBackup}>Sicherung exportieren</button>
          <label class="file-button secondary">
            <span>Sicherung importieren</span>
            <input type="file" accept="application/json,.json" on:change={importBackup} />
          </label>
        </div>
      </div>
      <p class="hint">Exportiert Mapping und Einstellungen. Die lokale Backup-IP wird nicht ueberschrieben.</p>
    </section>

    {#if status.network?.platform === 'win32'}
      <section class="network">
        <div class="section-head">
          <h2>Windows IP-Adressen</h2>
          <span class="pill ok">Windows</span>
        </div>
        <div class="ip-list">
          {#each interfaceAddresses() as address}
            <div>
              <strong>{address.name}</strong>
              <span>{address.family} {address.cidr || address.address}</span>
            </div>
          {:else}
            <p class="empty">Keine lokalen IP-Adressen gefunden.</p>
          {/each}
        </div>
      </section>
    {:else}
    <section class="network">
      <div class="section-head">
        <h2>Raspberry Netzwerk</h2>
        <div class="actions">
          <button on:click={saveNetwork}>Netzwerk speichern</button>
          <button class="secondary" on:click={applyNetwork}>Auf Raspberry anwenden</button>
        </div>
      </div>
      <div class="status-row network-status">
        <span class:ok={status.network?.supported} class="pill">Linux {status.network?.supported ? 'ok' : 'nur speichern'}</span>
        <span class:ok={!status.network?.requiresSudo} class="pill">Rechte {status.network?.requiresSudo ? 'sudo -n' : 'root'}</span>
        <span class:ok={status.network?.backup?.present} class="pill">Backup-IP {status.network?.backup?.present ? 'aktiv' : 'fehlt'}</span>
        {#if status.network?.main?.mode === 'static'}
          <span class:ok={status.network?.main?.present} class="pill">Haupt-IP {status.network?.main?.present ? 'aktiv' : 'fehlt'}</span>
        {/if}
        <span class="pill">Host {status.network?.hostname || '-'}</span>
      </div>
      <div class="fields network-fields">
        <label><span>Schnittstelle fuer beide IPs</span><input bind:value={config.network.interface} placeholder="eth0" /></label>
        <label><span>Backup IP/CIDR immer aktiv</span><input bind:value={config.network.backup.address} required placeholder="192.168.50.10/24" on:blur={() => (config.network.backup.address = normalizeBackupAddress(config.network.backup.address))} /></label>
        <label><span>NM Connection optional</span><input bind:value={config.network.main.connection} placeholder="leer = automatisch" /></label>
        <label>
          <span>Haupt-IP Modus</span>
          <select bind:value={config.network.main.mode}>
            <option value="dhcp">DHCP</option>
            <option value="static">Statisch</option>
          </select>
        </label>
        {#if config.network.main.mode === 'static'}
          <label><span>Statische IP/CIDR</span><input bind:value={config.network.main.address} placeholder="192.168.178.60/24" /></label>
          <label><span>Gateway</span><input bind:value={config.network.main.gateway} placeholder="192.168.178.1" /></label>
          <label><span>DNS</span><input bind:value={config.network.main.dns} placeholder="192.168.178.1,1.1.1.1" /></label>
        {/if}
      </div>
      {#if status.network?.commands?.length}
        <pre class="command-preview">{status.network.commands.map((command) => `${command.label}: ${command.bin} ${command.args.join(' ')}`).join('\n')}</pre>
      {/if}
      {#if error}
        <pre class="command-preview error-preview">{error}</pre>
      {/if}
      {#if status.network?.lastApply?.errors?.length}
        <pre class="command-preview error-preview">{status.network.lastApply.errors.join('\n')}</pre>
      {/if}
      {#if status.network?.lastBackupApply?.errors?.length}
        <pre class="command-preview error-preview">{status.network.lastBackupApply.errors.join('\n')}</pre>
      {/if}
    </section>
    {/if}

    <div class="workspace">
      <section class="apc">
        <div class="section-head">
          <h2>APC Layout</h2>
          <div class="actions">
            <div class="tabs">
              <button class:current={activeLayer === 'normal'} on:click={() => setLayer('normal')}>Seite 1</button>
              <button class:current={activeLayer === 'shift'} on:click={() => setLayer('shift')}>Shift Seite 2</button>
            </div>
            <button class:current={multiSelect} class="secondary" on:click={toggleMultiSelect}>Mehrfach</button>
          </div>
        </div>

        <div class="live-strip">
          <div><strong>Letztes MIDI</strong><span>{live.last ? (live.last.event === 'cc' ? `CC ${live.last.controller}: ${live.last.value}` : `Note ${live.last.note}: ${live.last.velocity}`) : 'nichts'}</span></div>
          <div><strong>Shift</strong><span>{status.midi?.shiftActive ? 'gedrueckt' : 'frei'}</span></div>
          <div><strong>Fader 1</strong><span>{faderRaw(48, viewRevision)} / {faderLevel(48, viewRevision)}%</span></div>
          <div><strong>OSC Feedback</strong><span>{status.osc?.connected ? 'empfangen' : 'wartet'}</span></div>
        </div>

        <div class="controller">
          <div class="matrix">
            {#each matrixDisplay as note}
              <button class:active={activeFor('pad', note, mappingFor('pad', note), viewRevision)} class:selected={selected?.type === 'pad' && selected.value === note} class:bulk={isSelectedBulk('pad', note)} class={modeClass('pad', note, viewRevision)} style={styleFor('pad', note, ledClock)} on:click={() => selectElement('pad', note)} title={`Pad ${note}`}>
                <span class="main">{note}</span><span class="readout">{readout('pad', note, viewRevision)}</span>
              </button>
            {/each}
          </div>
          <div class="scenes">
            {#each scenes as note, index}
              <button class:active={activeFor('scene', note, mappingFor('scene', note), viewRevision)} class:selected={selected?.type === 'scene' && selected.value === note} class:bulk={isSelectedBulk('scene', note)} class={modeClass('scene', note, viewRevision)} style={styleFor('scene', note, ledClock)} on:click={() => selectElement('scene', note)}>
                <span class="main">S{index + 1}</span><span class="readout">{readout('scene', note, viewRevision)}</span>
              </button>
            {/each}
          </div>
          <div class="controls">
            {#each controls as note, index}
              <button class:active={activeFor('control', note, mappingFor('control', note), viewRevision)} class:selected={selected?.type === 'control' && selected.value === note} class:bulk={isSelectedBulk('control', note)} class={modeClass('control', note, viewRevision)} style={styleFor('control', note, ledClock)} on:click={() => selectElement('control', note)}>
                <span class="main">C{index + 1}</span><span class="readout">{readout('control', note, viewRevision)}</span>
              </button>
            {/each}
            <button class:active={status.midi?.shiftActive} class:selected={selected?.type === 'shift'} class:bulk={isSelectedBulk('shift', shiftNote)} class={modeClass('shift', shiftNote, viewRevision)} style={styleFor('shift', shiftNote, ledClock)} on:click={() => selectElement('shift', shiftNote)}>
              <span class="main">Shift</span><span class="readout">{readout('shift', shiftNote, viewRevision)}</span>
            </button>
          </div>
          <div class="faders">
            {#each faders as cc, index}
              <button class:active={activeFor('fader', cc, mappingFor('fader', cc), viewRevision)} class:selected={selected?.type === 'fader' && selected.value === cc} class:bulk={isSelectedBulk('fader', cc)} class={modeClass('fader', cc, viewRevision)} style={styleFor('fader', cc, ledClock)} on:click={() => selectElement('fader', cc)}>
                <span class="fader-value">{faderRaw(cc, viewRevision)}</span><small>{faderLevel(cc, viewRevision)}%</small><span class="main">F{index + 1}</span><span class="readout">{readout('fader', cc, viewRevision)}</span>
              </button>
            {/each}
          </div>
        </div>
      </section>

      <section class="editor">
        <div class="section-head">
          <h2>{multiSelect ? 'Mehrfach bearbeiten' : 'Mapping Editor'}</h2>
          {#if editor && !multiSelect}<button class="danger" on:click={deleteMapping}>Auf Aus setzen</button>{/if}
        </div>
        {#if error}<p class="error">{error}</p>{/if}
        {#if notice}<p class="notice">{notice}</p>{/if}

        {#if multiSelect}
          <div class="bulk-head">
            <strong>{selection.length} ausgewaehlt</strong>
            <div class="bulk-actions">
              <button class="secondary" on:click={() => (selection = [])}>Leeren</button>
              <button class="danger" on:click={cancelBulkEdit}>Abbruch</button>
            </div>
          </div>
          <div class="bulk-options">
            <label class="checkbox-row">
              <input type="checkbox" bind:checked={quickMapEnabled} />
              <span>Quick Mapping</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" bind:checked={bulkTargetEnabled} />
              <span>Zieltyp mit aendern</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" bind:checked={bulkLedEnabled} />
              <span>Farbe/LED setzen</span>
            </label>
          </div>
          {#if quickMapEnabled}
            <div class="quick-map">
            <div class="quick-map-head">
              <div>
                <strong>Quick Mapping</strong>
                <span>Auswahlreihenfolge wird auf fortlaufende Executor gelegt.</span>
              </div>
            </div>
            <div class="fields compact">
              <label>
                <span>Zieltyp</span>
                <select value={quickMap.targetType} on:change={(event) => setQuickMap('targetType', event.currentTarget.value)}>
                  {#each quickMapTargetOptions as [value, label]}<option value={value}>{label}</option>{/each}
                </select>
              </label>
              <label><span>Page</span><input type="number" min="1" value={quickMap.page} on:input={(event) => setQuickMap('page', event.currentTarget.value)} /></label>
              <label><span>Start Nummer</span><input type="number" min="1" value={quickMap.start} on:input={(event) => setQuickMap('start', event.currentTarget.value)} /></label>
              {#if quickMap.targetType === 'auto-executor' || quickMap.targetType === 'magicq-executor-button'}
                <label>
                  <span>Modus</span>
                  <select value={quickMap.action} on:change={(event) => setQuickMap('action', event.currentTarget.value)}>
                    {#each executorActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
                {#if quickMap.action === 'set-level'}
                  <label><span>Level %</span><input type="number" min="0" max="100" value={quickMap.value} on:input={(event) => setQuickMap('value', event.currentTarget.value)} /></label>
                {/if}
              {/if}
            </div>
            {#if quickMapItems.length}
              <div class="quick-map-preview">
                {#each quickMapItems as item, index}
                  <span>{index + 1}. {sourceLabel(item)} -> {quickMapDestinationLabel(item, index)}</span>
                {/each}
              </div>
            {:else}
              <p class="hint">Pads oder Buttons in der gewuenschten Reihenfolge anklicken.</p>
            {/if}
            </div>
          {/if}
          {#if bulkTargetEnabled}
            <div class="fields compact">
              <label>
                <span>Zieltyp</span>
                <select value={bulkTarget.type} on:change={(event) => setBulkTargetType(event.currentTarget.value)}>
                  {#each bulkTargetOptions() as [value, label]}
                    <option value={value}>{label}</option>
                  {/each}
                </select>
              </label>
              {#if bulkTarget.type !== 'disabled' && bulkTarget.type?.startsWith('magicq-executor')}
                <label><span>Executor Page</span><input type="number" min="1" value={bulkTarget.page || 1} on:input={(event) => setBulkTarget('page', event.currentTarget.value)} /></label>
                <label><span>Executor Nummer</span><input type="number" min="1" value={bulkTarget.executor || 1} on:input={(event) => setBulkTarget('executor', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'magicq-executor-button'}
                <label>
                  <span>Aktion</span>
                  <select value={bulkTarget.action} on:change={(event) => setBulkTarget('action', event.currentTarget.value)}>
                    {#each executorActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
                {#if bulkTarget.action === 'set-level'}
                  <label><span>Level %</span><input type="number" min="0" max="100" value={bulkTarget.value || 100} on:input={(event) => setBulkTarget('value', event.currentTarget.value)} /></label>
                {/if}
              {/if}
              {#if bulkTarget.type === 'magicq-executor-adjust' || bulkTarget.type === 'magicq-playback-adjust'}
                <label><span>Schritt +/- %</span><input type="number" min="-100" max="100" value={bulkTarget.amount || 10} on:input={(event) => setBulkTarget('amount', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type?.startsWith('magicq-playback')}
                <label><span>Playback</span><input type="number" min="1" value={bulkTarget.playback || 1} on:input={(event) => setBulkTarget('playback', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'magicq-playback-level'}
                <label><span>Level %</span><input type="number" min="0" max="100" value={bulkTarget.value || 100} on:input={(event) => setBulkTarget('value', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'magicq-playback-action'}
                <label>
                  <span>Aktion</span>
                  <select value={bulkTarget.action} on:change={(event) => setBulkTarget('action', event.currentTarget.value)}>
                    {#each playbackActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
              {/if}
              {#if bulkTarget.type === 'magicq-playback-flash'}
                <label>
                  <span>Flash Modus</span>
                  <select value={bulkTarget.action} on:change={(event) => setBulkTarget('action', event.currentTarget.value)}>
                    {#each flashActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
              {/if}
              {#if bulkTarget.type === 'magicq-playback-jump'}
                <label><span>Cue</span><input type="number" min="0" step="0.01" value={bulkTarget.cue || 1} on:input={(event) => setBulkTarget('cue', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'magicq-10scene'}
                <label><span>Item</span><input type="number" min="1" value={bulkTarget.item || 1} on:input={(event) => setBulkTarget('item', event.currentTarget.value)} /></label>
                <label><span>Zone</span><input type="number" min="1" value={bulkTarget.zone || 1} on:input={(event) => setBulkTarget('zone', event.currentTarget.value)} /></label>
                <label><span>Wert</span><input type="number" min="0" max="1" step="0.01" value={bulkTarget.value || 1} on:input={(event) => setBulkTarget('value', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'magicq-dbo'}
                <label>
                  <span>DBO</span>
                  <select value={bulkTarget.action} on:change={(event) => setBulkTarget('action', event.currentTarget.value)}>
                    {#each dboActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
              {/if}
              {#if bulkTarget.type === 'magicq-swap'}
                <label>
                  <span>Swap Modus</span>
                  <select value={bulkTarget.mode || 'normal'} on:change={(event) => setBulkTarget('mode', event.currentTarget.value)}>
                    <option value="normal">normal</option><option value="swap">swap</option>
                  </select>
                </label>
              {/if}
              {#if bulkTarget.type === 'magicq-rpc'}
                <label><span>RPC Command</span><input value={bulkTarget.command || ''} on:input={(event) => setBulkTarget('command', event.currentTarget.value)} /></label>
              {/if}
              {#if bulkTarget.type === 'special'}
                <label>
                  <span>Spezialfunktion</span>
                  <select value={bulkTarget.action} on:change={(event) => setBulkTarget('action', event.currentTarget.value)}>
                    {#each specialActions as action}<option value={action}>{action}</option>{/each}
                  </select>
                </label>
                {#if bulkTarget.action === 'select-page'}
                  <label><span>Seite</span><input type="number" min="1" value={bulkTarget.page || 1} on:input={(event) => setBulkTarget('page', event.currentTarget.value)} /></label>
                {/if}
              {/if}
            </div>
          {/if}
          {#if bulkLedEnabled}
            <div class="quick-map">
              <div class="quick-map-head">
                <div>
                  <strong>Farbe/LED</strong>
                  <span>Wird nur fuer Elemente mit LED angewendet, Fader bleiben unveraendert.</span>
                </div>
              </div>
              {@render LedControls(bulkLed, setBulkLed, 'pad')}
            </div>
          {/if}
          {#if quickMapEnabled || bulkTargetEnabled || bulkLedEnabled}
            <button disabled={!bulkApplyEnabled} on:click={applyBulkEdit}>Mehrfachauswahl speichern</button>
          {:else}
            <p class="empty">Quick Mapping, Zieltyp oder Farbe/LED anhaken.</p>
          {/if}
        {:else if editor}
          <div class="fields compact">
            <label><span>ID</span><input bind:value={editor.id} /></label>
            <label>
              <span>Zieltyp</span>
              <select value={editor.target.type} on:change={(event) => setTargetType(event.currentTarget.value)}>
                {#each targetOptionsFor(selected?.type) as [value, label]}
                  <option value={value}>{label}</option>
                {/each}
              </select>
            </label>
            {#if editor.target.type !== 'disabled' && editor.target.type?.startsWith('magicq-executor')}
              <label><span>Executor Page</span><input type="number" min="1" value={editor.target.page} on:input={(event) => setTarget('page', event.currentTarget.value)} /></label>
              <label><span>Executor Nummer</span><input type="number" min="1" value={editor.target.executor} on:input={(event) => setTarget('executor', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-executor-button'}
              <label>
                <span>Aktion</span>
                <select value={editor.target.action} on:change={(event) => setTarget('action', event.currentTarget.value)}>
                  {#each executorActions as action}<option value={action}>{action}</option>{/each}
                </select>
              </label>
              {#if editor.target.action === 'set-level'}
                <label><span>Level %</span><input type="number" min="0" max="100" value={editor.target.value} on:input={(event) => setTarget('value', event.currentTarget.value)} /></label>
              {/if}
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-executor-adjust'}
              <label><span>Schritt +/- %</span><input type="number" min="-100" max="100" value={editor.target.amount} on:input={(event) => setTarget('amount', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type?.startsWith('magicq-playback')}
              <label><span>Playback</span><input type="number" min="1" value={editor.target.playback} on:input={(event) => setTarget('playback', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-playback-level'}
              <label><span>Level %</span><input type="number" min="0" max="100" value={editor.target.value} on:input={(event) => setTarget('value', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-playback-action'}
              <label>
                <span>Aktion</span>
                <select value={editor.target.action} on:change={(event) => setTarget('action', event.currentTarget.value)}>
                  {#each playbackActions as action}<option value={action}>{action}</option>{/each}
                </select>
              </label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-playback-flash'}
              <label>
                <span>Flash Modus</span>
                <select value={editor.target.action} on:change={(event) => setTarget('action', event.currentTarget.value)}>
                  {#each flashActions as action}<option value={action}>{action}</option>{/each}
                </select>
              </label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-playback-adjust'}
              <label><span>Schritt +/- %</span><input type="number" min="-100" max="100" value={editor.target.amount} on:input={(event) => setTarget('amount', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-playback-jump'}
              <label><span>Cue</span><input type="number" min="0" step="0.01" value={editor.target.cue} on:input={(event) => setTarget('cue', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-10scene'}
              <label><span>Item</span><input type="number" min="1" value={editor.target.item} on:input={(event) => setTarget('item', event.currentTarget.value)} /></label>
              <label><span>Zone</span><input type="number" min="1" value={editor.target.zone} on:input={(event) => setTarget('zone', event.currentTarget.value)} /></label>
              <label><span>Wert</span><input type="number" min="0" max="1" step="0.01" value={editor.target.value} on:input={(event) => setTarget('value', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-dbo'}
              <label>
                <span>DBO</span>
                <select value={editor.target.action} on:change={(event) => setTarget('action', event.currentTarget.value)}>
                  {#each dboActions as action}<option value={action}>{action}</option>{/each}
                </select>
              </label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-swap'}
              <label>
                <span>Swap Modus</span>
                <select value={editor.target.mode || 'normal'} on:change={(event) => setTarget('mode', event.currentTarget.value)}>
                  <option value="normal">normal</option><option value="swap">swap</option>
                </select>
              </label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'magicq-rpc'}
              <label><span>RPC Command</span><input value={editor.target.command} on:input={(event) => setTarget('command', event.currentTarget.value)} /></label>
            {/if}
            {#if editor.target.type !== 'disabled' && editor.target.type === 'special'}
              <label>
                <span>Spezialfunktion</span>
                <select value={editor.target.action} on:change={(event) => setTarget('action', event.currentTarget.value)}>
                  {#each specialActions as action}<option value={action}>{action}</option>{/each}
                </select>
              </label>
              {#if editor.target.action === 'select-page'}
                <label><span>Seite</span><input type="number" min="1" value={editor.target.page} on:input={(event) => setTarget('page', event.currentTarget.value)} /></label>
              {/if}
            {/if}
            {#if hasLedControls(selected?.type)}
              <label>
                <span>Layout Vorschau</span>
                <select bind:value={previewState} on:change={bumpView}><option value="live">live</option><option value="off">LED aus</option><option value="active">LED aktiv</option></select>
              </label>
            {/if}
          </div>
          {#if hasLedControls(selected?.type)}
            {@render LedControls(editor.led, setEditorLed, selected?.type)}
          {/if}
          <div class="actions">
            <button class="secondary" on:click={cancelMappingEdit}>Abbruch</button>
            <button on:click={saveMapping}>Mapping speichern</button>
          </div>
        {:else}
          <p class="empty">Element auswaehlen oder Mehrfachauswahl aktivieren.</p>
        {/if}
      </section>
    </div>

    <section class="monitor">
      <div class="monitor-grid">
        <EventList title="MIDI" items={recent.midi} />
        <EventList title="OSC Send" items={recent.oscSent} />
        <EventList title="OSC Receive" items={recent.oscReceived} />
        <EventList title="Fehler" items={recent.errors} />
      </div>
    </section>
  {:else}
    <section class="loading">Lade Bridge...</section>
  {/if}
</main>

{#snippet LedControls(led, onChange, sourceType)}
  <div class="led-controls">
    {#if ledTitle(sourceType)}<p class="hint">{ledTitle(sourceType)}</p>{/if}
    {#if hasRgbLedControls(sourceType)}
      <label><span>LED aus</span><ColorPicker value={led.offColor} options={colorOptions} onselect={(value) => onChange('offColor', value)} /></label>
    {/if}
    <label>
      <span>LED aus Modus</span>
      <select value={led.offMode} on:change={(event) => onChange('offMode', event.currentTarget.value)}>
        <option value="off">off</option><option value="solid">solid</option><option value="blink">blink</option>{#if hasRgbLedControls(sourceType)}<option value="pulse">pulse</option>{/if}
      </select>
    </label>
    {#if hasRgbLedControls(sourceType)}
      <label><span>LED aktiv</span><ColorPicker value={led.onColor} options={colorOptions} onselect={(value) => onChange('onColor', value)} /></label>
    {/if}
    <label>
      <span>LED aktiv Modus</span>
      <select value={led.activeMode} on:change={(event) => onChange('activeMode', event.currentTarget.value)}>
        <option value="off">off</option><option value="solid">solid</option><option value="blink">blink</option>{#if hasRgbLedControls(sourceType)}<option value="pulse">pulse</option>{/if}
      </select>
    </label>
  </div>
{/snippet}

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #101412; color: #f3f7f1; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(1540px, calc(100vw - 28px)); margin: 0 auto; padding: 18px 0 36px; }
  .topbar, section { border: 1px solid #2d372f; background: #171d19; border-radius: 8px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 18px; margin-bottom: 14px; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 23px; }
  h2 { font-size: 17px; }
  .topbar p, .empty { color: #9cac9d; }
  section { padding: 16px; margin-bottom: 14px; }
  .section-head, .actions, .status-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .section-head { margin-bottom: 12px; }
  .pill { border: 1px solid #5a3a3a; color: #ffb8a8; border-radius: 999px; padding: 5px 9px; font-size: 12px; font-weight: 800; }
  .pill.ok { border-color: #49825c; color: #9ff0b7; }
  .fields, .led-controls { display: grid; grid-template-columns: repeat(2, minmax(160px, 1fr)); gap: 12px; }
  .connection .fields { grid-template-columns: repeat(5, minmax(130px, 1fr)); }
  .network-status { justify-content: flex-start; margin-bottom: 12px; }
  .network-fields { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
  .command-preview { margin: 12px 0 0; padding: 12px; overflow: auto; border: 1px solid #263229; border-radius: 6px; background: #0d110f; color: #b8f36d; font-size: 12px; }
  .error-preview { border-color: #6d3a32; color: #ffb8a8; }
  .ip-list { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 10px; }
  .ip-list div { border: 1px solid #2d372f; border-radius: 8px; background: #111612; padding: 10px; }
  .ip-list strong, .ip-list span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ip-list span { color: #b8f36d; margin-top: 4px; font-size: 13px; font-weight: 800; }
  label { display: grid; gap: 6px; color: #aebdae; font-size: 12px; font-weight: 800; }
  input, select, button { min-height: 38px; border-radius: 6px; border: 1px solid #354037; background: #0d110f; color: #f5faf3; font: inherit; }
  input, select { width: 100%; padding: 8px 10px; }
  input[type="checkbox"] { width: 18px; min-height: 18px; padding: 0; }
  .file-button { min-height: 38px; display: inline-grid; place-items: center; padding: 8px 12px; border-radius: 6px; border: 1px solid #3b493c; background: #202820; color: #e4eedf; cursor: pointer; }
  .file-button input { display: none; }
  button { cursor: pointer; padding: 8px 12px; background: #b8f36d; border-color: #b8f36d; color: #15200d; font-weight: 900; }
  button.secondary, .tabs button { background: #202820; color: #e4eedf; border-color: #3b493c; }
  button.current, .tabs button.current { background: #55c7ff; border-color: #55c7ff; color: #06131a; }
  button.danger { background: #ff7a66; border-color: #ff7a66; color: #220905; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(340px, 0.8fr); gap: 14px; }
  .tabs { display: grid; grid-template-columns: repeat(2, minmax(95px, 1fr)); gap: 4px; padding: 4px; border: 1px solid #354037; border-radius: 8px; background: #0d110f; }
  .live-strip { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .live-strip div, .bulk-head { border: 1px solid #2d372f; border-radius: 8px; background: #111612; padding: 9px 10px; }
  .live-strip strong, .live-strip span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-strip strong { color: #9cac9d; font-size: 11px; margin-bottom: 4px; }
  .live-strip span { color: #f3f7f1; font-size: 13px; font-weight: 900; }
  .controller { display: grid; grid-template-columns: minmax(0, 1fr) minmax(48px, 70px); grid-template-areas: 'matrix scenes' 'controls controls' 'faders faders'; gap: 10px; }
  .matrix { grid-area: matrix; display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 7px; }
  .scenes { grid-area: scenes; display: grid; gap: 7px; }
  .controls { grid-area: controls; display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 7px; }
  .faders { grid-area: faders; display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 7px; }
  .matrix button, .scenes button, .controls button, .faders button { position: relative; display: grid; align-content: center; justify-items: center; gap: 3px; min-width: 0; aspect-ratio: 1; padding: 0; background: var(--control-color); color: var(--control-text); border-color: rgba(255,255,255,.24); box-shadow: inset 0 -10px 18px rgba(0,0,0,.22); text-shadow: 0 1px 3px rgba(0,0,0,.45); }
  .faders button { aspect-ratio: .55; align-content: space-between; padding: 9px 0; }
  .main { font-size: 13px; font-weight: 950; line-height: 1; }
  .readout { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; max-width: calc(100% - 6px); max-height: 2.4em; overflow: hidden; white-space: normal; word-break: break-word; border-radius: 4px; background: rgba(0,0,0,.55); color: #fff; padding: 2px 3px; font-size: 8.5px; font-weight: 900; line-height: 1.1; text-shadow: none; }
  .fader-value { display: grid; place-items: center; min-width: 28px; min-height: 28px; border-radius: 999px; background: #101412; color: #b8f36d; font-size: 12px; }
  .faders small { font-size: 10px; opacity: .86; }
  button.active { filter: brightness(1.25) saturate(1.2); box-shadow: 0 0 18px var(--effect-color), inset 0 -10px 18px rgba(0,0,0,.22); }
  button.selected { outline: 4px solid #fff; outline-offset: 2px; }
  button.bulk { outline: 3px solid #b8f36d; outline-offset: 2px; }
  button.mode-blink { background: var(--blink-color) !important; filter: brightness(var(--blink-brightness)) !important; }
  button.mode-pulse { background: var(--effect-color) !important; filter: brightness(var(--pulse-brightness)) saturate(1.18) !important; box-shadow: 0 0 var(--pulse-shadow-size) var(--effect-color), inset 0 -10px 18px rgba(0,0,0,.22) !important; }
  .mode-off { background: #232c25 !important; color: #aebdae !important; }
  .editor { display: grid; align-content: start; gap: 12px; }
  .bulk-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .bulk-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .bulk-options { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; }
  .quick-map { display: grid; gap: 12px; padding: 12px; border: 1px solid #2d372f; border-radius: 8px; background: #111612; }
  .quick-map-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .quick-map-head strong, .quick-map-head span { display: block; }
  .quick-map-head span { margin-top: 3px; color: #9cac9d; font-size: 12px; }
  .quick-map-preview { display: flex; flex-wrap: wrap; gap: 6px; }
  .quick-map-preview span { padding: 5px 7px; border: 1px solid #354037; border-radius: 6px; background: #0d110f; color: #d8ecd1; font-size: 12px; font-weight: 800; }
  .checkbox-row { display: flex; align-items: center; gap: 9px; grid-column: 1 / -1; min-height: 38px; }
  .hint { grid-column: 1 / -1; color: #9cac9d; font-size: 12px; }
  .error { color: #ffb8a8; }
  .notice { color: #9ff0b7; }
  .monitor-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 12px; }
  .loading { min-height: 220px; display: grid; place-items: center; color: #aebdae; }
  @media (max-width: 1120px) { .workspace, .connection .fields, .network-fields, .ip-list, .live-strip, .monitor-grid { grid-template-columns: 1fr; } }
  @media (max-width: 720px) { main { width: calc(100vw - 18px); } .topbar { align-items: flex-start; flex-direction: column; } .controller { grid-template-columns: 1fr; grid-template-areas: 'matrix' 'scenes' 'controls' 'faders'; } .matrix, .scenes, .controls, .faders, .bulk-options { grid-template-columns: repeat(4, minmax(0, 1fr)); } .bulk-options { grid-template-columns: 1fr; } }
</style>
