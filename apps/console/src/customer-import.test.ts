import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMPORT_MAX_BYTES,
  buildMapping,
  canResume,
  checkImportFile,
  filterPreviewRows,
  readCsvHeaders,
  suggestSelection,
} from './customer-import/model.js';

const bytes = (text: string) => new TextEncoder().encode(text);

test('อ่าน header แบบ strict UTF-8: BOM, quote, CRLF และปฏิเสธไฟล์ที่ไม่ใช่ CSV', () => {
  assert.deepEqual(readCsvHeaders(bytes('﻿name,"บริษัท, จำกัด",email\r\na,b,c')), [
    'name',
    'บริษัท, จำกัด',
    'email',
  ]);
  assert.deepEqual(readCsvHeaders(bytes('"a""b",c')), ['a"b', 'c']);
  assert.equal(readCsvHeaders(new Uint8Array([0xff, 0xfe, 0x41])), null);
  assert.equal(readCsvHeaders(bytes('a,a\n1,2')), null, 'header ซ้ำ');
  assert.equal(readCsvHeaders(bytes('a,,c')), null, 'header ว่าง');
  assert.equal(readCsvHeaders(bytes('"a')), null, 'quote ไม่ปิด');
  assert.equal(readCsvHeaders(bytes('a"b,c')), null);
  assert.equal(readCsvHeaders(bytes('a\0b,c')), null);
});

test('ตรวจไฟล์ก่อนส่ง: ว่าง ใหญ่เกิน หรืออ่านไม่ได้', () => {
  assert.equal(checkImportFile(0, ['a']), 'EMPTY');
  assert.equal(checkImportFile(IMPORT_MAX_BYTES + 1, ['a']), 'TOO_LARGE');
  assert.equal(checkImportFile(IMPORT_MAX_BYTES, ['a']), 'OK');
  assert.equal(checkImportFile(10, null), 'NOT_CSV');
});

test('เดาการจับคู่จากชื่อหัวคอลัมน์ไทย/อังกฤษ โดยไม่ใช้คอลัมน์ซ้ำ', () => {
  assert.deepEqual(suggestSelection(['ชื่อ', 'บริษัท', 'เบอร์โทร', 'E-mail', 'VIP', 'other']), {
    displayName: 'ชื่อ',
    company: 'บริษัท',
    phone: 'เบอร์โทร',
    email: 'E-mail',
    vip: 'VIP',
  });
  assert.deepEqual(suggestSelection(['x', 'y']), {});
});

test('สร้าง mapping เฉพาะเมื่อมีชื่อ และไม่เลือก header ซ้ำหรือที่ไม่มีในไฟล์', () => {
  const headers = ['name', 'phone', 'mail'];
  assert.equal(buildMapping({}, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'nope' }, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'name', phone: 'name' }, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'name' }, headers, 'ZZ'), null);
  assert.deepEqual(buildMapping({ displayName: 'name', phone: 'phone' }, headers, 'TH'), {
    version: 1,
    columns: { displayName: 'name', phone: 'phone' },
    defaultPhoneCountry: 'TH',
  });
  // ไม่ระบุประเทศ = ต้องเป็นเบอร์สากล ไม่ส่ง defaultPhoneCountry
  assert.deepEqual(buildMapping({ displayName: 'name' }, headers, ''), {
    version: 1,
    columns: { displayName: 'name' },
  });
});

test('กรองแถว preview และตัดสินว่าส่งต่อได้เมื่อมีแถวไม่ทราบผลหรือยังไม่เริ่ม', () => {
  const rows = [
    { rowNo: 1, cells: ['a'], valid: true, fieldErrors: [], warnings: [] },
    {
      rowNo: 2,
      cells: ['b'],
      valid: false,
      fieldErrors: [{ field: 'phone', code: 'X' }],
      warnings: [],
    },
    { rowNo: 3, cells: ['c'], valid: true, fieldErrors: [], warnings: ['READABLE_DUPLICATE'] },
  ];
  assert.deepEqual(filterPreviewRows(rows, 'ALL').length, 3);
  assert.deepEqual(
    filterPreviewRows(rows, 'INVALID').map((row) => row.rowNo),
    [2],
  );
  assert.deepEqual(
    filterPreviewRows(rows, 'WARNING').map((row) => row.rowNo),
    [3],
  );
  const done = { applied: 2, rejected: 1, notSelected: 1, pending: 0, unknown: 0, notAttempted: 0 };
  assert.equal(canResume(done), false);
  assert.equal(canResume({ ...done, unknown: 1 }), true);
  assert.equal(canResume({ ...done, notAttempted: 3 }), true);
  assert.equal(canResume({ ...done, pending: 1 }), true);
});
