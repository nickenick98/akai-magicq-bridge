const os = require('os');
const { execFile } = require('child_process');

function getNetworkStatus(config) {
  const network = config.network || {};
  let commands = [];
  let error = '';
  try {
    commands = buildNetworkCommands(network);
  } catch (err) {
    error = err.message;
  }

  return {
    platform: process.platform,
    hostname: os.hostname(),
    supported: process.platform === 'linux',
    requiresRoot: process.platform === 'linux' && process.getuid && process.getuid() !== 0,
    requiresSudo: process.platform === 'linux' && process.getuid && process.getuid() !== 0,
    config: network,
    interfaces: listInterfaces(),
    commands,
    error
  };
}

async function applyNetworkConfig(config) {
  if (process.platform !== 'linux') {
    throw new Error('Netzwerk-Konfiguration kann nur auf Raspberry Pi OS/Linux angewendet werden.');
  }

  const network = JSON.parse(JSON.stringify(config.network || {}));
  network.main = network.main || {};
  network.main.connection = network.main.connection || (await resolveConnectionName(network.interface || 'eth0'));
  const commands = buildNetworkCommands(network);
  for (const command of commands) {
    await run(command.bin, command.args);
  }

  return getNetworkStatus(config);
}

async function applyBackupIp(config) {
  if (process.platform !== 'linux') return getNetworkStatus(config);
  const backup = config.network?.backup || {};
  if (backup.enabled === false || backup.applyOnStart === false || !backup.address) {
    return getNetworkStatus(config);
  }

  await run('ip', ['addr', 'replace', String(backup.address), 'dev', sanitizeInterface(config.network?.interface || 'eth0')]);
  return getNetworkStatus(config);
}

function buildNetworkCommands(network = {}) {
  const backup = network.backup || {};
  const main = network.main || {};
  const iface = sanitizeInterface(network.interface || backup.interface || main.interface || 'eth0');
  const mainConnection = String(main.connection || iface).trim();
  const commands = [];

  if (backup.enabled !== false && backup.address) {
    commands.push({
      label: 'Backup-IP setzen',
      bin: 'ip',
      args: ['addr', 'replace', String(backup.address), 'dev', iface]
    });
  }

  if (main.mode === 'static') {
    commands.push({
      label: 'Haupt-IP statisch setzen',
      bin: 'nmcli',
      args: [
        'connection',
        'modify',
        mainConnection,
        'ipv4.method',
        'manual',
        'ipv4.addresses',
        String(main.address || ''),
        'ipv4.gateway',
        String(main.gateway || ''),
        'ipv4.dns',
        String(main.dns || '')
      ]
    });
  } else {
    commands.push({
      label: 'Haupt-IP per DHCP setzen',
      bin: 'nmcli',
      args: ['connection', 'modify', mainConnection, 'ipv4.method', 'auto', 'ipv4.gateway', '', 'ipv4.dns', '']
    });
  }

  commands.push({
    label: 'NetworkManager Verbindung neu laden',
    bin: 'nmcli',
    args: ['connection', 'up', mainConnection]
  });

  return commands;
}

function listInterfaces() {
  return Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
    name,
    addresses: (addresses || [])
      .filter((address) => !address.internal)
      .map((address) => ({
        family: address.family,
        address: address.address,
        cidr: address.cidr,
        mac: address.mac
      }))
  }));
}

function sanitizeInterface(name) {
  const value = String(name || 'eth0').trim();
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error(`Ungueltiger Interface-Name: ${value}`);
  }
  return value;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const needsSudo = process.platform === 'linux' && process.getuid && process.getuid() !== 0;
    const command = needsSudo ? 'sudo' : bin;
    const commandArgs = needsSudo ? ['-n', bin, ...args] : args;
    execFile(command, commandArgs, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${commandArgs.join(' ')}: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function resolveConnectionName(interfaceName) {
  const iface = sanitizeInterface(interfaceName || 'eth0');
  const result = await run('nmcli', ['-g', 'GENERAL.CONNECTION', 'device', 'show', iface]);
  const connection = String(result.stdout || '').trim();
  if (!connection || connection === '--') {
    throw new Error(`Keine aktive NetworkManager-Verbindung fuer ${iface} gefunden.`);
  }
  return connection;
}

module.exports = {
  applyBackupIp,
  applyNetworkConfig,
  buildNetworkCommands,
  getNetworkStatus
};
