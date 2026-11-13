import { spawn } from 'node:child_process';

const commands = [
  ['runtime', ['--workspace', '@loom/runtime', 'run', 'dev']],
  ['ui', ['--workspace', '@loom/desktop', 'run', 'dev']],
];

const children = commands.map(([name, args]) => {
  const child = spawn('npm', args, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  return child;
});

const stop = () => children.forEach(child => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(children.map(child => new Promise(resolve => child.once('exit', resolve))));
stop();
