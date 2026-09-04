import { execFileSync } from 'node:child_process';

const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

export function compose(...arguments_) {
  return execFileSync('docker', [...composeArguments, ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
