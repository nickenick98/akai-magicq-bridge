const os = require('os');
const { execFile } = require('child_process');

function getNetworkStatus(config) {
  const network = config.network || {};
  let iface = 'eth0';
  let error = '';
  try {
    iface = sanitizeInterface(network.interface || network.backup?.interface || network.main?.interface || 'eth0');
  } catch (err) {
    error = err.message;
  }
  const backupAddress = String(network.backup?.address || '').trim();
  const interfaces = listInterfaces();
  let commands = [];
  try {
    commands = buildNetworkCommands(network);
  } catch (err) {
    error = [error, err.message].filter(Boolean).join('; ');
  }

  return {
    platform: process.platform,
    hostname: os.hostname(),
    supported: process.platform === 'linux',
    requiresRoot: process.platform === 'linux' && process.getuid && process.getuid() !== 0,
    requiresSudo: process.platform === 'linux' && process.getuid && process.getuid() !== 0,
    config: network,
    interfaces,
    backup: {
      interface: iface,
      address: backupAddress,
      enabled: network.backup?.enabled !== false,
      applyOnStart: network.backup?.applyOnStart !== false,
      present: backupAddress ? interfaceHasAddress(interfaces, iface, backupAddress) : false
    },
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
  network.main.connection = network.main.connection || (await resolveOrCreateConnectionName(network.interface || 'eth0'));
  const commands = buildNetworkCommands(network);
  const errors = [];

  for (const command of commands) {
    try {
      await run(command.bin, command.args);
    } catch (error) {
      errors.push(`${command.label}: ${error.message}`);
    }
  }

  if (errors.length) {
    const status = getNetworkStatus({ ...config, network });
    status.lastApply = {
      ok: false,
      errors,
      connection: network.main.connection,
      backupApplied: commands.some((command) => command.label === 'Backup-IP setzen')
    };
    return status;
  }

  return {
    ...getNetworkStatus({ ...config, network }),
    lastApply: {
      ok: true,
      errors: [],
      connection: network.main.connection,
      backupApplied: commands.some((command) => command.label === 'Backup-IP setzen')
    }
  };
}

async function applyBackupIp(config) {
  if (process.platform !== 'linux') return getNetworkStatus(config);
  const backup = config.network?.backup || {};
  if (backup.enabled === false || backup.applyOnStart === false || !backup.address) {
    return getNetworkStatus(config);
  }

  const iface = sanitizeInterface(config.network?.interface || backup.interface || config.network?.main?.interface || 'eth0');
  const errors = [];

  for (const command of backupIpCommands(iface, backup.address)) {
    try {
      await run(command.bin, command.args);
    } catch (error) {
      errors.push(`${command.label}: ${error.message}`);
    }
  }

  let status = getNetworkStatus(config);
  if (!status.backup.present && errors.length === 0) {
    await wait(300);
    status = getNetworkStatus(config);
  }
  if (!status.backup.present && errors.length === 0) {
    errors.push(`Backup-IP ${backup.address} ist nach dem Setzen nicht auf ${iface} sichtbar.`);
  }

  status.lastBackupApply = {
    ok: errors.length === 0,
    errors,
    interface: iface,
    address: String(backup.address),
    present: status.backup.present,
    at: new Date().toISOString()
  };
  return status;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNetworkCommands(network = {}) {
  const backup = network.backup || {};
  const main = network.main || {};
  const iface = sanitizeInterface(network.interface || backup.interface || main.interface || 'eth0');
  const mainConnection = String(main.connection || iface).trim();
  const backupEnabled = backup.enabled !== false && backup.address;
  const addresses = formatMainAddresses(main, backupEnabled ? backup.address : '');
  const commands = [];

  if (backupEnabled) {
    commands.push(...backupIpCommands(iface, backup.address));
  }

  if (main.mode === 'static') {
    commands.push({
      label: 'Haupt-IP statisch setzen',
      bin: 'nmcli',
      args: [
        'connection',
        'modify',
        mainConnection,
        'connection.interface-name',
        iface,
        'connection.autoconnect',
        'yes',
        'ipv4.method',
        'manual',
        'ipv4.addresses',
        addresses,
        'ipv4.may-fail',
        'no',
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
      args: [
        'connection',
        'modify',
        mainConnection,
        'connection.interface-name',
        iface,
        'connection.autoconnect',
        'yes',
        'ipv4.method',
        'auto',
        'ipv4.addresses',
        addresses,
        'ipv4.may-fail',
        'yes',
        'ipv4.gateway',
        '',
        'ipv4.dns',
        ''
      ]
    });
  }

  commands.push({
    label: 'NetworkManager Verbindung neu laden',
    bin: 'nmcli',
    args: ['connection', 'up', mainConnection]
  });

  if (backupEnabled) {
    commands.push(...backupIpCommands(iface, backup.address));
  }

  return commands;
}

function backupIpCommands(iface, address) {
  return [
    {
      label: 'Interface fuer Backup-IP aktivieren',
      bin: 'ip',
      args: ['link', 'set', 'dev', iface, 'up']
    },
    {
      label: 'Backup-IP setzen',
      bin: 'ip',
      args: ['addr', 'replace', String(address), 'dev', iface]
    }
  ];
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

function formatMainAddresses(main = {}, backupAddress = '') {
  const addresses = [];
  if (main.mode === 'static' && main.address) addresses.push(String(main.address).trim());
  if (backupAddress) addresses.push(String(backupAddress).trim());
  return addresses.filter(Boolean).join(',');
}

function interfaceHasAddress(interfaces, iface, cidrOrAddress) {
  const expected = normalizeAddress(cidrOrAddress);
  const networkInterface = interfaces.find((item) => item.name === iface);
  if (!networkInterface || !expected) return false;
  return networkInterface.addresses.some((address) => {
    if (address.family !== 'IPv4') return false;
    return address.address === expected || normalizeAddress(address.cidr) === expected;
  });
}

function normalizeAddress(cidrOrAddress) {
  return String(cidrOrAddress || '').split('/')[0].trim();
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
    const preferDirect = needsSudo && isIpCommand(bin);
    const command = needsSudo && !preferDirect ? 'sudo' : bin;
    const commandArgs = needsSudo && !preferDirect ? ['-n', bin, ...args] : args;
    execFile(command, commandArgs, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        if (preferDirect) {
          runWithSudo(bin, args).then(resolve).catch(reject);
          return;
        }
        reject(new Error(`${command} ${commandArgs.join(' ')}: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runWithSudo(bin, args) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', bin, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`sudo -n ${bin} ${args.join(' ')}: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isIpCommand(bin) {
  return String(bin).split(/[\\/]/).pop() === 'ip';
}

async function resolveConnectionName(interfaceName) {
  const iface = sanitizeInterface(interfaceName || 'eth0');
  try {
    const result = await run('nmcli', ['-g', 'GENERAL.CONNECTION', 'device', 'show', iface]);
    const connection = String(result.stdout || '').trim();
    if (connection && connection !== '--') return connection;
  } catch {
    // Fall through to stored profiles or iface fallback.
  }

  try {
    const result = await run('nmcli', ['-t', '-f', 'NAME,DEVICE', 'connection', 'show']);
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const [name, device] = line.split(':');
      if (device === iface && name) return name;
    }
  } catch {
    // Fallback below still allows backup IP commands to run.
  }

  return iface;
}

async function resolveOrCreateConnectionName(interfaceName) {
  const iface = sanitizeInterface(interfaceName || 'eth0');
  const resolved = await resolveConnectionName(iface);
  if (resolved && resolved !== iface) return resolved;

  const managedName = `akai-bridge-${iface}`;
  if (await connectionExists(managedName)) return managedName;
  if (await connectionExists(iface)) return iface;

  try {
    await run('nmcli', ['connection', 'add', 'type', 'ethernet', 'ifname', iface, 'con-name', managedName]);
    return managedName;
  } catch {
    return iface;
  }
}

async function connectionExists(name) {
  try {
    await run('nmcli', ['connection', 'show', name]);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  applyBackupIp,
  applyNetworkConfig,
  buildNetworkCommands,
  getNetworkStatus
};
