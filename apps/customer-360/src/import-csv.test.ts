import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C360ImportCsvError,
  C360_IMPORT_MAX_BYTES,
  parseC360ImportCsv,
  validateC360ImportMapping,
  normalizeC360ImportRow,
} from './import-csv.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const rejects = (value: Uint8Array, code: string) =>
  assert.throws(
    () => parseC360ImportCsv(value),
    (error: unknown) => {
      assert.ok(error instanceof C360ImportCsvError);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    },
  );

test('CSV อ่าน BOM, quoted comma/newline, escaped quote และนับ record โดยไม่เปลี่ยนค่า', () => {
  assert.deepEqual(parseC360ImportCsv(bytes('\ufeffname,email\r\n"ก,ข","a""b"\r\n"line\n2",x\n')), {
    headers: ['name', 'email'],
    rows: [
      ['ก,ข', 'a"b'],
      ['line\n2', 'x'],
    ],
  });
  assert.deepEqual(parseC360ImportCsv(bytes('a,b\n1,')), {
    headers: ['a', 'b'],
    rows: [['1', '']],
  });
});

test('CSV ปฏิเสธ UTF-8 ไม่ถูกต้อง, NUL, header ซ้ำ, แถวไม่ครบและ quote ผิด grammar', () => {
  for (const input of [
    new Uint8Array([0xc3, 0x28]),
    bytes('name\nsecret\0'),
    bytes('a,a\nx,y'),
    bytes('a,\nx,y'),
    bytes('a,b\nx'),
    bytes('a\n"unfinished'),
    bytes('a\n"quoted"tail'),
    bytes('a\nplain"quote'),
    bytes('a\rb'),
  ])
    rejects(input, 'CSV_INVALID');
});

test('CSV จำกัด bytes, columns, rows และ UTF-16 code units ก่อน core validation', () => {
  rejects(new Uint8Array(C360_IMPORT_MAX_BYTES + 1), 'IMPORT_LIMIT_EXCEEDED');
  rejects(bytes(Array.from({ length: 33 }, (_, i) => `h${i}`).join(',')), 'IMPORT_LIMIT_EXCEEDED');
  rejects(bytes(`${'x'.repeat(161)}\na`), 'IMPORT_LIMIT_EXCEEDED');
  rejects(bytes(`h\n${'😀'.repeat(1025)}`), 'IMPORT_LIMIT_EXCEEDED');
  rejects(bytes(`h\n${'x\n'.repeat(10_001)}`), 'IMPORT_LIMIT_EXCEEDED');
  assert.equal(parseC360ImportCsv(bytes(`h\n${'😀'.repeat(1024)}`)).rows[0]![0]!.length, 2048);
});

test('quoted control และ formula คงเป็นข้อความเพื่อให้ core validator ตรวจอีกชั้น', () => {
  const parsed = parseC360ImportCsv(bytes('name\n"=SUM(1,2)"\n"a\nb"'));
  assert.deepEqual(parsed.rows, [['=SUM(1,2)'], ['a\nb']]);
});

test('mapping ต้องอ้าง header จริง ใช้ key allowlist และประเทศจาก metadata C4', () => {
  const headers = ['ชื่อ', 'โทร', 'ประเทศ', 'วีไอพี'];
  const valid = {
    version: 1,
    columns: { displayName: 'ชื่อ', phone: 'โทร', phoneCountry: 'ประเทศ', vip: 'วีไอพี' },
    defaultPhoneCountry: 'US',
  };
  assert.deepEqual(validateC360ImportMapping(valid, headers), valid);
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, extra: 'secret' },
    { ...valid, columns: { ...valid.columns, tags: 'ชื่อ' } },
    { ...valid, columns: { displayName: 'missing' } },
    { ...valid, defaultPhoneCountry: 'ZZ' },
    { ...valid, defaultPhoneCountry: 'th' },
  ])
    assert.throws(() => validateC360ImportMapping(invalid, headers), {
      message: 'MAPPING_INVALID',
    });
});

test('แถวใช้ C4 normalizer และ explicit country จาก column ก่อน default โดยไม่สะท้อน cell เมื่อผิด', () => {
  const headers = ['name', 'phone', 'country', 'vip', 'email'];
  const mapping = validateC360ImportMapping(
    {
      version: 1,
      columns: {
        displayName: 'name',
        phone: 'phone',
        phoneCountry: 'country',
        vip: 'vip',
        email: 'email',
      },
      defaultPhoneCountry: 'US',
    },
    headers,
  );
  const valid = normalizeC360ImportRow(
    headers,
    ['  ชื่อ  ', '0812345678', 'TH', 'true', 'A@EXAMPLE.COM'],
    mapping,
  );
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.profile.displayName, 'ชื่อ');
    assert.equal(valid.profile.vip, true);
    assert.equal(valid.profile.points[0]?.normalizedValue, '+66812345678');
    assert.equal(valid.profile.points[1]?.normalizedValue, 'A@example.com');
  }
  const invalid = normalizeC360ImportRow(headers, ['secret\nname', '', '', 'false', ''], mapping);
  assert.equal(invalid.valid, false);
  assert.doesNotMatch(JSON.stringify(invalid), /secret/);
  assert.deepEqual(normalizeC360ImportRow(headers, ['ok', '', '', 'TRUE', ''], mapping), {
    valid: false,
    fieldErrors: [{ field: 'vip', code: 'FIELD_INVALID' }],
  });
  assert.deepEqual(normalizeC360ImportRow(headers, ['ok', '', 'ZZ', '', ''], mapping), {
    valid: false,
    fieldErrors: [{ field: 'phoneCountry', code: 'PHONE_COUNTRY_UNSUPPORTED' }],
  });
  const invalidEmail = normalizeC360ImportRow(headers, ['ok', '', '', '', 'not-an-email'], mapping);
  assert.equal(invalidEmail.valid, false);
  if (!invalidEmail.valid) assert.equal(invalidEmail.fieldErrors[0]?.field, 'email');
});
