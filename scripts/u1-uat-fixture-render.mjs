import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.9 (#506): render fixture pack ของ UAT first slice จาก template ที่ commit ไว้ → input `UatProvisionV1`
 * ที่ `uat-deploy.sh provision` / CLI `uat-provision` (U1.8 #502) รับได้ — ไม่มี dependency นอกจาก Node
 *
 * - template (`infra/uat/fixtures/<name>.template.json`) เป็นข้อมูลสังเคราะห์ล้วน; ค่าที่ผูกกับ deployment
 *   (tenant/team/maker/reviewer, environment, pack version, build SHA) เป็น placeholder `__UAT_*__`
 * - input คือสำเนาของ `infra/uat/uat-provision.example.json` ที่ operator กรอกจาก secret store แล้ว:
 *   `fixturePack` เป็น stub `{ template, environment, packVersion }` — id ของ tenant/team/บัญชีเอามาจาก
 *   input เดียวกัน (ไม่ต้องกรอกซ้ำ) และ `buildSha` มาจาก `--build-sha` = SHA ของ release ที่ deploy
 * - placeholder ที่ยังไม่กรอก (ที่ใดก็ตามใน input) = ปฏิเสธ ไม่ render
 * - output = input เดิมที่ `fixturePack` ถูกแทนด้วย manifest เต็ม (stdout หรือ `--output` แบบ mode 600)
 * - ข้อความสถานะ/ข้อผิดพลาดเป็น JSON บรรทัดเดียวทาง stderr: มีแค่รหัสและชื่อ field ไม่พิมพ์ค่าจาก input
 *   (input มีอีเมลจริงของผู้ทดสอบ)
 *
 * การตรวจรูปแบบ/negative scan/digest เต็มเป็นของ CLI `uat-provision` (`--check`) — ที่นี่ไม่ทำซ้ำ
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINE_TYPE = 'u1.uat.fixture-render';

/** template ที่ render ได้ — ชื่อ → path จาก root ของ repository */
export const UAT_FIXTURE_TEMPLATES = Object.freeze({
  'uat-first-slice.v1': 'infra/uat/fixtures/uat-first-slice.v1.template.json',
});

/** placeholder ของ template/example — รูปแบบนี้ห้ามเหลือใน input ที่จะ provision */
export const UAT_PLACEHOLDER = /__UAT_[A-Z0-9_]+__/;
/** SHA ของ commit เต็ม (git SHA-1 หรือ SHA-256) — ตัวย่อไม่รับ เพราะ digest ของ pack ผูกกับค่านี้ */
const BUILD_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class UatFixtureRenderError extends Error {
  constructor(code, safeParams = {}) {
    super(`uat fixture render: ${code}`);
    this.name = 'UatFixtureRenderError';
    this.code = code;
    /** ชื่อ field/template เท่านั้น — ห้ามใส่ค่าจาก input */
    this.safeParams = safeParams;
  }
}

/** path ของ string แรกที่ยังเป็น placeholder (เช่น `maker.email`) หรือ null */
export function findUatPlaceholder(value, path = '') {
  if (typeof value === 'string') return UAT_PLACEHOLDER.test(value) ? path || '(root)' : null;
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    const found = findUatPlaceholder(entry, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringAt(input, path) {
  const value = path
    .split('.')
    .reduce((node, key) => (isObject(node) ? node[key] : undefined), input);
  if (typeof value !== 'string' || value.length === 0) {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: path });
  }
  return value;
}

export function readUatFixtureTemplate(name, root = repositoryRoot) {
  if (!Object.hasOwn(UAT_FIXTURE_TEMPLATES, name)) {
    throw new UatFixtureRenderError('TEMPLATE_UNKNOWN', { field: 'fixturePack.template' });
  }
  try {
    return JSON.parse(readFileSync(resolve(root, UAT_FIXTURE_TEMPLATES[name]), 'utf8'));
  } catch {
    throw new UatFixtureRenderError('TEMPLATE_UNREADABLE', { template: name });
  }
}

/**
 * แทน placeholder ของ template ทีละค่าแบบทั้ง string (ไม่ต่อข้อความ) — placeholder ที่ template มีแต่ไม่อยู่ใน
 * `values` หรือ value ที่ template ไม่ได้ใช้ = template ผิด (fail closed)
 */
export function renderUatFixtureTemplate(template, values) {
  const used = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!UAT_PLACEHOLDER.test(node)) return node;
      if (!Object.hasOwn(values, node)) {
        throw new UatFixtureRenderError('TEMPLATE_PLACEHOLDER_UNKNOWN');
      }
      used.add(node);
      return values[node];
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const rendered = walk(template);
  if (Object.keys(values).some((token) => !used.has(token))) {
    throw new UatFixtureRenderError('TEMPLATE_PLACEHOLDER_MISSING');
  }
  return rendered;
}

/** input (สำเนาที่กรอกแล้วของ example) + build SHA → input `UatProvisionV1` ที่มี manifest เต็ม */
export function renderUatProvisionInput(input, { buildSha, root = repositoryRoot } = {}) {
  if (!isObject(input) || input.schema !== 'UatProvisionV1') {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: 'schema' });
  }
  const placeholder = findUatPlaceholder(input);
  if (placeholder) throw new UatFixtureRenderError('PLACEHOLDER_UNFILLED', { field: placeholder });
  if (typeof buildSha !== 'string' || !BUILD_SHA.test(buildSha)) {
    throw new UatFixtureRenderError('BUILD_SHA_INVALID', { field: '--build-sha' });
  }
  const stub = input.fixturePack;
  if (
    !isObject(stub) ||
    Object.keys(stub).sort().join(',') !== 'environment,packVersion,template'
  ) {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: 'fixturePack' });
  }
  const template = readUatFixtureTemplate(stringAt(input, 'fixturePack.template'), root);
  const fixturePack = renderUatFixtureTemplate(template, {
    __UAT_ENVIRONMENT__: stringAt(input, 'fixturePack.environment'),
    __UAT_FIXTURE_PACK_VERSION__: stringAt(input, 'fixturePack.packVersion'),
    __UAT_BUILD_SHA__: buildSha,
    __UAT_TENANT_ID__: stringAt(input, 'tenant.id'),
    __UAT_OWNER_TEAM_ID__: stringAt(input, 'ownerTeam.id'),
    __UAT_MAKER_SUBJECT_ID__: stringAt(input, 'maker.dcUserId'),
    __UAT_REVIEWER_SUBJECT_ID__: stringAt(input, 'reviewer.dcUserId'),
  });
  return { ...input, fixturePack };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = { '--input': 'input', '--build-sha': 'buildSha', '--output': 'output' }[flag];
    const value = argv[index + 1];
    if (!name || options[name] !== undefined || value === undefined) {
      throw new UatFixtureRenderError('USAGE');
    }
    options[name] = value;
    index += 1;
  }
  if (!options.input || !options.buildSha) throw new UatFixtureRenderError('USAGE');
  return options;
}

/**
 * `node scripts/u1-uat-fixture-render.mjs --input <file|-> --build-sha <sha> [--output <file>]`
 * คืน exit code; stdout = JSON ของ input ที่ render แล้ว (ถ้าไม่มี `--output`), stderr = สถานะหนึ่งบรรทัด
 */
export function runUatFixtureRenderCli(argv, io = {}) {
  const readInput = io.readInput ?? ((path) => readFileSync(path === '-' ? 0 : path, 'utf8'));
  const write = io.write ?? ((text) => process.stdout.write(text));
  const status = io.status ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const options = parseArguments(argv);
    let input;
    try {
      input = JSON.parse(readInput(options.input));
    } catch {
      throw new UatFixtureRenderError('INPUT_UNREADABLE', { field: '--input' });
    }
    const rendered = renderUatProvisionInput(input, { buildSha: options.buildSha, root: io.root });
    const text = `${JSON.stringify(rendered, null, 2)}\n`;
    if (options.output) {
      try {
        // มีอีเมลจริง: สร้างใหม่เท่านั้น (ไม่เขียนทับ) และอ่านได้เฉพาะเจ้าของ
        writeFileSync(options.output, text, { mode: 0o600, flag: 'wx' });
      } catch {
        throw new UatFixtureRenderError('OUTPUT_NOT_WRITTEN', { field: '--output' });
      }
    } else {
      write(text);
    }
    status(
      JSON.stringify({
        type: LINE_TYPE,
        status: 'PASS',
        template: input.fixturePack.template,
        steps: String(rendered.fixturePack.steps.length),
      }),
    );
    return 0;
  } catch (error) {
    const known = error instanceof UatFixtureRenderError;
    status(
      JSON.stringify({
        type: LINE_TYPE,
        status: 'FAIL',
        code: known ? error.code : 'UNEXPECTED',
        ...(known ? error.safeParams : {}),
      }),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runUatFixtureRenderCli(process.argv.slice(2));
}
