const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const env = {
  ...process.env,
  PKG_CACHE_PATH: path.join(root, '.pkg-cache')
};

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
run(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg'), [
  '.',
  '--targets',
  'node24-win-x64',
  '--output',
  path.join('dist', 'akai-magicq-bridge.exe')
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    console.error(result.error.message);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
