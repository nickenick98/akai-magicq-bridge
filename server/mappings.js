function isNoteEvent(event) {
  return event.event === 'noteon' || event.event === 'noteoff';
}

function isPress(event) {
  if (event.event === 'noteoff') return false;
  return event.velocity === undefined || event.velocity > 0;
}

function normalizeSourceType(event, apc) {
  if (event.event === 'cc') {
    return apc.faderCcs.includes(event.controller) ? 'fader' : 'cc';
  }

  if (!isNoteEvent(event)) return 'unknown';
  if (apc.matrixNotes.includes(event.note)) return 'pad';
  if (apc.sceneNotes.includes(event.note)) return 'scene';
  if (apc.controlNotes.includes(event.note)) return 'control';
  if (event.note === apc.shiftNote) return 'shift';
  return 'note';
}

function eventMatchesSource(event, source, shiftActive, apc) {
  const sourceType = normalizeSourceType(event, apc);

  if (source.type === 'fader') {
    return event.event === 'cc' && event.controller === source.cc;
  }

  if (source.type !== 'shift' && Boolean(source.shift) !== Boolean(shiftActive)) {
    return false;
  }

  if (source.type === sourceType && isNoteEvent(event)) {
    return event.note === source.note;
  }

  return false;
}

function findMapping(event, config, shiftActive) {
  return (config.mappings || []).find((mapping) =>
    eventMatchesSource(event, mapping.source || {}, shiftActive, config.apc)
  );
}

function upsertMapping(config, mapping) {
  const normalizedMapping = normalizeMapping(mapping);
  if (isBlockedShiftSceneMapping(config, normalizedMapping)) {
    const sourceKey = mappingSourceKey(normalizedMapping);
    return {
      ...config,
      mappings: (config.mappings || []).filter((existing) => mappingSourceKey(existing) !== sourceKey)
    };
  }

  const mappings = [...(config.mappings || [])];
  const requestedId = normalizedMapping.id || mappingSourceId(normalizedMapping) || `${normalizedMapping.source?.type || 'mapping'}-${Date.now()}`;
  const sourceKey = mappingSourceKey(normalizedMapping);
  const sourceIndex = sourceKey ? mappings.findIndex((existing) => mappingSourceKey(existing) === sourceKey) : -1;
  const idIndex = mappings.findIndex((existing) => existing.id === requestedId);
  const idCollidesWithOtherSource =
    sourceIndex < 0 && idIndex >= 0 && mappingSourceKey(mappings[idIndex]) !== sourceKey;
  const id = idCollidesWithOtherSource ? mappingSourceId(normalizedMapping) || `${requestedId}-${Date.now()}` : requestedId;
  const nextMapping = { ...normalizedMapping, id };
  const index = sourceIndex >= 0 ? sourceIndex : idCollidesWithOtherSource ? -1 : idIndex;

  if (index >= 0) {
    mappings[index] = nextMapping;
  } else {
    mappings.push(nextMapping);
  }

  return { ...config, mappings };
}

function mappingSourceId(mapping) {
  const source = mapping.source || {};
  const value = source.type === 'fader' ? source.cc : source.note;
  if (!source.type || value === undefined) return null;
  if (source.type === 'fader') return `${source.type}-${value}`;
  return `${source.shift ? 'shift-' : ''}${source.type}-${value}`;
}

function mappingSourceKey(mapping) {
  const source = mapping.source || {};
  const value = source.type === 'fader' ? source.cc : source.note;
  if (!source.type || value === undefined) return '';
  if (source.type === 'fader') return `${source.type}:${value}`;
  return `${Boolean(source.shift)}:${source.type}:${value}`;
}

function normalizeMapping(mapping) {
  if (mapping?.source?.type === 'shift') {
    return {
      ...mapping,
      id: `shift-${mapping.source?.note}`,
      source: {
        ...(mapping.source || {}),
        shift: false
      },
      target: {
        type: mapping.target?.type === 'shift-toggle' ? 'shift-toggle' : 'shift-hold'
      },
      led: {
        offColor: 0,
        offMode: 'off',
        onColor: 0,
        activeMode: 'off'
      }
    };
  }
  if (mapping?.source?.type !== 'fader') return mapping;
  return {
    ...mapping,
    id: mappingSourceId(mapping),
    source: {
      ...(mapping.source || {}),
      shift: false
    }
  };
}

function isBlockedShiftSceneMapping(config, mapping) {
  return (
    config?.apc?.shiftBehavior?.sceneButtonsBlockedOnShift !== false &&
    mapping?.source?.type === 'scene' &&
    Boolean(mapping.source?.shift)
  );
}

function deleteMapping(config, id) {
  return {
    ...config,
    mappings: (config.mappings || []).filter((mapping) => mapping.id !== id)
  };
}

function scaleFader(value, range = {}) {
  const midiValue = clamp(Number(value), 0, 127);
  const min = Number.isFinite(Number(range.min)) ? Number(range.min) : 0;
  const max = Number.isFinite(Number(range.max)) ? Number(range.max) : 100;
  return Math.round(min + (midiValue / 127) * (max - min));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  deleteMapping,
  findMapping,
  isPress,
  normalizeSourceType,
  scaleFader,
  upsertMapping
};
