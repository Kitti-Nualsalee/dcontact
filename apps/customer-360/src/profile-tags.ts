/**
 * Cus360 C1 (#791) S5 → C3 (#793): tag name normalization ย้ายไปอยู่ที่ @d-contact/contact-points
 * เพื่อให้ API/operator/UI ใช้กฎและรุ่น dependency ชุดเดียวกับ phone/email; ไฟล์นี้คง export เดิมไว้
 */
export {
  C360TagNameError,
  C360_TAG_NAME_MAX,
  C360_TAG_NORMALIZATION_VERSION,
  normalizeC360TagName,
} from '@d-contact/contact-points';
