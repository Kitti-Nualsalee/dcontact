import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// คำสั่งอ่านอย่างเดียวบน VM2 ตาม ADR-030 ไม่ส่ง credential หรือเผย Config.Env
const SCRIPT = String.raw`
import hashlib, json, pathlib, subprocess
record = json.loads(pathlib.Path('/opt/dcontact-uat/deployments/current.json').read_bytes())
services = {'api':'api', 'console':'proxy', 'keycloak':'keycloak', 'e1':'e1-sandbox', 'freeswitch':'freeswitch'}
configs, images, sources = {}, {}, {}
for key, service in services.items():
    value = json.loads(subprocess.check_output(['docker','inspect','dcontact-uat-'+service+'-1']))[0]
    if not value['State']['Running']:
        raise ValueError('SERVICE_NOT_RUNNING')
    images[key] = value['Config']['Image'].split('@')[-1]
    sources[key] = value['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
    configs[key] = {k:value[k] for k in ['Config','HostConfig','Mounts']}
images['ops'] = record['images']['ops'].split('@')[-1]
for key in ['api','console','keycloak']:
    if record['images'][key].split('@')[-1] != images[key]:
        raise ValueError('IMAGE_RECORD_MISMATCH')
sha = record['sourceSha']
if any(sources[k] != sha for k in ['api','console','e1']):
    raise ValueError('SOURCE_RECORD_MISMATCH')
# บันทึก config ของ containers ที่กำลังทำงานและ bytes ของ bind-mounted files จริง
# ไม่ hash directory ของ DB/media หรืออ่านเนื้อหา secret ออก stdout
mounts = {}
for config in configs.values():
    for mount in config['Mounts']:
        if mount.get('Type') == 'bind':
            path = pathlib.Path(mount['Source'])
            if path.is_file():
                mounts[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
            elif mount['Destination'] == '/e1-freeswitch' and path.is_dir():
                for file in sorted(path.rglob('*')):
                    if file.is_file():
                        mounts[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
config_bytes = json.dumps({'containers':configs, 'mountedFiles':mounts},sort_keys=True,separators=(',',':')).encode()
print(json.dumps({'kind':'CORE_SETTINGS_RUNTIME_SNAPSHOT','sourceSha':sha,'images':images,'configDigest':hashlib.sha256(config_bytes).hexdigest()},sort_keys=True))
`;

export function collectRuntimeSnapshot() {
  try {
    const value = execFileSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', 'osdadmin@192.168.102.112', 'python3 -'],
      { input: SCRIPT, encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { ...JSON.parse(value), observedAt: new Date().toISOString() };
  } catch {
    throw Error('RUNTIME_SNAPSHOT_UNAVAILABLE');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(collectRuntimeSnapshot(), null, 2)}\n`);
  } catch {
    process.stderr.write('RUNTIME_SNAPSHOT_UNAVAILABLE\n');
    process.exitCode = 1;
  }
}
