# M3: ผลทดลองความเข้ากันได้ของ API tooling

ตรวจวันที่ 2 พฤศจิกายน 2569 (Asia/Bangkok). ผลนี้เป็น tooling spike ใน `/tmp/dcontact-m3-tooling-spike` แยกจาก repository. เพิ่มเฉพาะเอกสารนี้ใน repo; ไม่เปลี่ยน package.json, lockfile, application source, GitHub issue หรือ environment ของทีม

## ข้อเสนอที่มีหลักฐานแล้ว

ใช้ **Zod 4.6.7 + @asteasolutions/zod-to-openapi 9.1.0 + AJV 8.20.0 แบบ Ajv2020 + openapi-typescript 7.13.0** เป็น candidate สำหรับ code-owned API contract. Minimal pipeline compile ด้วย TypeScript 5.5.4 และ Node 20.11.1 ผ่าน รวม generate OpenAPI 3.1.0, JSON Schema validation, generated request/response types และ reference HTTP mock/client บน loopback

เสนอ **OpenAPI 3.1.0 เป็น baseline ที่ spike ใช้จริง**. Generator ยอมรับ config `openapi:'3.1.2'`, round-trip label และตัวตรวจ schema ผ่านด้วย แต่ผลนั้นไม่พิสูจน์ว่า toolchain รองรับทุกข้อกำหนดของ 3.1.2. ห้ามเปลี่ยน label แล้วอ้าง conformance ครบหรือเรียก 3.1.0 ว่า 3.1.2. รุ่นล่าสุดของ specification ยังเป็น 3.2.1 ตาม [ผล research มาตรฐาน](m3-api-standards-research.md)

Candidate นี้ไม่ขึ้นกับ Nest decorator หรือ Swagger plugin จึงไม่บังคับ upgrade NestJS 10; **ยังไม่ได้ทดลองต่อเข้า Nest controller/pipe จริง**. ให้ Phase Contract กำหนด route metadata และ runtime validator จาก code-owned authority เดียวกัน พร้อม tests ว่า actual route ตรง OpenAPI ที่ generate ตาม ADR-015

## รุ่นที่ตรวจและแหล่งต้นฉบับ

Metadata ของ package อ่านจาก official npm registry และติดตั้งแบบ exact versions ใน temp project ด้วย `--ignore-scripts`; registry responses และ integrity อยู่ใน `registry.json`/`package-lock.json` ของ spike

| เครื่องมือ | รุ่นที่ pin/ตรวจ | ผลที่เกี่ยวข้อง |
| --- | --- | --- |
| Node / npm | 20.11.1 / 10.2.4 | Runtime ที่ใช้ทดลองจริง; ไม่อ้างว่าตรง runtime ทุก environment ของ repo |
| TypeScript | 5.5.4 | `strict:true`, `skipLibCheck:false`, NodeNext compile ผ่าน |
| @asteasolutions/zod-to-openapi | 9.1.0 | peer `zod:^4.0.0`; ใช้ `OpenApiGeneratorV31` จริง. [registry](https://registry.npmjs.org/@asteasolutions%2fzod-to-openapi/9.1.0), [source/readme v9.1.0](https://github.com/asteasolutions/zod-to-openapi/tree/v9.1.0) |
| Zod | 4.6.7 | Native `z.toJSONSchema(...,{target:'draft-2020-12'})` และ runtime safeParse ผ่าน vectors ที่ระบุ. [registry](https://registry.npmjs.org/zod/4.6.7), [official JSON Schema docs](https://zod.dev/json-schema) |
| AJV | 8.20.0 | ใช้ named `Ajv2020` จาก `ajv/dist/2020.js`; ไม่ใช้ default draft07 instance. [registry](https://registry.npmjs.org/ajv/8.20.0), [official schema version docs](https://ajv.js.org/json-schema.html#draft-2020-12-breaking) |
| openapi-typescript | 7.13.0 | Generate types จาก 3.1.0 และ label3.1.2 ผ่าน; generated request types ตรวจ boolean/string mismatch ได้. [registry](https://registry.npmjs.org/openapi-typescript/7.13.0), [official docs](https://openapi-ts.dev/introduction) |
| Types ที่ต้องเพิ่มใน spike | @types/node20.14.0, json-schema-to-ts3.1.1, @types/js-yaml4.0.9 | Declaration dependencies เพิ่มเพื่อให้ strict compile ของ codegen dependency ผ่านโดยไม่เปิด skipLibCheck |
| oasdiff | 1.35.0 | Native official release; validate 3.1 ทั้งสอง label และ breaking-case tests ด้านล่างผ่าน. [release](https://github.com/oasdiff/oasdiff/releases/tag/v1.35.0), [official 3.1 support/caveats](https://github.com/oasdiff/oasdiff/blob/main/docs/OPENAPI-31.md) |
| @nestjs/swagger latest ที่ตรวจ | 12.0.5 | peer Nest core/common12 และ Node ^20.19 หรือ ≥22.12 จึงไม่ติดตั้งรุ่นล่าสุดนี้กับ baseline Nest10/Node20.11. [registry](https://registry.npmjs.org/@nestjs%2fswagger/12.0.5) |
| @stoplight/prism-cli latest ที่ตรวจ | 5.16.0 | engines Node≥24.18 จึงไม่เลือกมาเป็น mock runner บน runtime ที่ทดลอง. Minimal mock ใช้ node:http. [registry](https://registry.npmjs.org/@stoplight%2fprism-cli/5.16.0) |

`latest` เป็นข้อมูล ณวันที่ตรวจ ไม่ใช่สัญญาว่าต้องใช้ latest ใน implementation. รายการที่ไม่ได้ติดตั้งไม่ถือว่าทดสอบ compatibility แล้ว

## รูปแบบ minimal spike

Code-owned Zod strict object กำหนด create request มี displayName, company nullable/optional และ vip optional; response มี string revision/enum status. Registry ผูก request/response กับ POST `/api/v1/customer-360/contacts`; เอกสารนี้เป็น synthetic fixture ไม่ใช่การเปิด endpoint หรือเพิ่ม writer จริง

- `OpenApiGeneratorV31` generate document จาก registry และ Zod schemas; nullable company เป็น `type:['string','null']`
- `z.toJSONSchema` export draft2020-12 จาก schema เดียวกันให้ Ajv2020 ตรวจ request โดย `coerceTypes:false`, `removeAdditional:false`, `strict:true`
- `openapi-typescript` รับ document ผ่าน JSON/Buffer boundary เพื่อให้แต่ละ library ตรวจ type representation ของตัวเอง ไม่ cast OpenAPIObject ที่ declaration แตกต่างกันข้าม library
- Generated types ใช้ใน reference client ที่เรียก HTTP ผ่าน fetch; type-level negative case ใช้ `@ts-expect-error` กับ vip ที่ส่งเป็น string
- Mock server ใช้ `node:http` บน `127.0.0.1` ephemeral port ตรวจ request ด้วย AJV และคืน synthetic response/error envelopeเดิม; ปิด server หลัง assertions ทุกครั้ง

## คำสั่งและผลจริง

Temp project มี exact dependency versions ข้างต้น. คำสั่งที่รัน:

```sh
npm install --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org
./node_modules/.bin/tsc -p tsconfig.json
node dist/spike.js
node typed-http-client-test.mjs
./oasdiff validate openapi-3.1.0.json --allow-external-refs=false
./oasdiff validate openapi-3.1.2-label.json --allow-external-refs=false
./oasdiff breaking openapi-3.1.0.json breaking-nullable.json --allow-external-refs=false --fail-on ERR --format json
./oasdiff breaking openapi-3.1.0.json breaking-const.json --allow-external-refs=false --fail-on ERR --format json
./oasdiff breaking openapi-3.1.0.json nonbreaking-summary.json --allow-external-refs=false --fail-on ERR --format json
```

| ตรวจ | ผลและขอบเขต |
| --- | --- |
| Final TS5.5 compile | PASS exit0 รวม generated-type client และ negative compile assertion; strict/no skipLibCheck |
| Basic request parity | PASS7/7: minimal valid, nullable/boolean valid, missing required, wrong boolean type, unknown property, empty name, ASCIIเกินเพดาน |
| Draft2020 tuple | PASS3/3: prefixItems valid, typeผิด, จำนวนเกินถูกปฏิเสธ |
| Local HTTP mock | PASS3/3: create201, wrongboolean400, unknownfield400; response valid/error codeตรง fixture |
| Generated-types HTTP client | PASS1/1 บน compiled reference helper ที่เรียก loopback mock; generated types ไม่ได้เป็น runtime response validator โดยตัวมันเอง |
| OpenAPI full-document validation | PASS2/2 โดย oasdiff validate สำหรับ3.1.0 และ3.1.2 label |
| Breaking nullable request | PASS: exit1, rule `request-property-became-not-nullable` |
| Breaking const restriction | PASS: exit1, rule `request-property-const-added` |
| Documentation-only summary | PASS: exit0 และ empty findings |

Compile รอบแรกพบ missing transitive declarations และความต่าง type boundary ของ AJV/OpenAPI libraries; แก้ด้วย declared dependencies/named import/serialized document boundary ใน spikeแล้ว. Runtime assertion รอบแรกสมมติว่า Zod maxLengthนับUTF16; ผลจริงขัดสมมตินั้น จึงแก้ expectation ตามผลที่วัดและบันทึก semantic gap ด้านล่าง ไม่เปลี่ยน owner rule เพื่อให้ testผ่าน

ไม่มี assertion ถูก skip ใน minimal spike. OAuth/Keycloak, actual Nest controller, DB/RLS/command semantics, webhook/signature และ actual integration/VM UAT **ยังไม่ได้ทดสอบ** และไม่อยู่ในจำนวน PASS ด้านบน

## Semantic gap ที่ต้องปิดก่อนใช้เป็น runtime authority

ผลจริงของ `z.string().max(1)` กับ `😀`: Zod4.6.7 ยอมรับ และ JSON Schema/AJV ยอมรับ; JavaScript string lengthเท่ากับ2 UTF16 units. แต่ E1/R1 กำหนดความยาวเป็น UTF16 units จึงต้องปฏิเสธเมื่อเพดาน1. ดังนั้นการย้าย owner limits เป็น generic `.max()`/`maxLength` เปลี่ยน behavior แม้ ZodกับAJVเห็นตรงกัน

Phase Contract ต้อง reuse owner parser/normalizer/UTF16 checks; หากใช้ Zodเป็น wire schema ให้ custom constraints มาจาก authority เดียวและประกาศ limitation/extensionใน generated schema พร้อม parity vectors ที่รัน actual HTTP API/reference service. ห้ามถือว่า generated JSON Schema แทน Unicode full casefold, phone parser, email grammar, owner authorization หรือ revisions/fences ได้เอง

`oasdiff` ตรวจ schema changes ที่ประกาศในเอกสาร; ไม่รู้ความหมาย helper/custom refinement ของ application. CIจึงต้องมี owner-rule/version change gates และ conformance vectors เพิ่ม ไม่ใช่ diff OpenAPIเพียงอย่างเดียว. Official tool docs ยังมี caveats ของ dynamic references/reusable components pathItems; ขอบเขต M3ต้องหลีกเลี่ยงหรือเพิ่ม fixtureพิสูจน์ constructsที่ใช้ ไม่อ้าง supportทุกJSON Schema keywordจากสองbreakingcasesที่รัน

## หลักฐาน temp artifacts

Artifacts หลักอยู่ `/tmp/dcontact-m3-tooling-spike`: `package.json`, `package-lock.json`, `registry.json`, `spike.ts`, `tsconfig.json`, `generated-types.ts`, `typed-client.ts`, `typed-http-client-test.mjs`, generated OpenAPI JSON และ `results.json`/`oasdiff-results.json`. Temp artifacts อาจถูก cleanupโดยระบบ; implementationต้องย้าย reproducible harnessเข้าrepoผ่านPRของตัวเอง

- `package-lock.json` SHA256 `138e7e7b6bb202e8901d0b3983ec1c68b131139297cdf97387d4288f8f325c10`
- `spike.ts` SHA256 `11fbcc37511b5844b1087c7107944064787f0fc435a48630ca754ff6813f1d52`
- `results.json` SHA256 `0df384a40ba170e68bc66658bacf08ff3c3c4dc8b2f1f62ed6c115e41494d77a`
- `openapi-3.1.0.json` SHA256 `086b0d714c4d8148f86ef28031fda3016b4d990d0d735c3991cffc95d57e4e07`
- `oasdiff_1.35.0_darwin_all.tar.gz` SHA256 `964ad2c0331768c4515fc49779827094bc89a65b1d309dac28886d1c3faf305c` ตรง official release asset digestก่อนแตกเฉพาะ executableในtemp

## Next gate

เลือก candidate pipelineนี้เข้าสเปกได้โดยระบุ **OpenAPI3.1.0 และ exactversionsที่ทดลอง**. ก่อน ready-for-agent ต้องตรึง code/schema ownership และ UTF16/custom-rule representation, ใส่ reproducible CI fixturesของ constructsที่ใช้จริง และยืนยัน principal/grant/command boundaries ตาม [research มาตรฐาน](m3-api-standards-research.md). ก่อนruntimeacceptanceต้องต่อactualNest/OIDC/DB/HTTPและrefserviceจริงตามticket ไม่ถือ minimalspikeเป็น production compatibility หรือ VM PASS
