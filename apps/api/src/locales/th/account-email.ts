/** Thai text of the account emails rendered by account-email-templates.ts */
export const accountEmailTh = {
  footer: 'อีเมลนี้ส่งจากระบบ D-Contact โดยอัตโนมัติ กรุณาอย่าตอบกลับ',
  fallback: 'หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์',
  'verify-new-email': {
    subject: 'ยืนยันอีเมลใหม่ของบัญชี D-Contact',
    title: 'ยืนยันอีเมลใหม่ของคุณ',
    intro: 'มีคำขอเปลี่ยนอีเมลของบัญชี D-Contact มาเป็นอีเมลนี้ กดปุ่มด้านล่างเพื่อยืนยัน',
    action: 'ยืนยันอีเมล',
    expiry: (minutes: number) => `ลิงก์นี้ใช้ได้ภายใน ${minutes} นาที และใช้ได้ครั้งเดียว`,
    ignore: 'หากคุณไม่ได้ขอเปลี่ยนอีเมล ไม่ต้องทำอะไร อีเมลของบัญชีจะไม่เปลี่ยน',
  },
  'email-changed-notice': {
    subject: 'อีเมลของบัญชี D-Contact ถูกเปลี่ยน',
    title: 'อีเมลของบัญชีคุณถูกเปลี่ยน',
    intro: (masked: string, at: string) =>
      `อีเมลของบัญชี D-Contact ถูกเปลี่ยนเป็น ${masked} เมื่อ ${at} อีเมลนี้จะไม่ได้รับการแจ้งเตือนของบัญชีอีกต่อไป`,
    action: 'เปิดบัญชีของฉัน',
    warning: 'หากคุณไม่ได้เปลี่ยนเอง ให้ติดต่อผู้ดูแลระบบขององค์กรทันที',
  },
  'password-changed-notice': {
    subject: 'รหัสผ่านของบัญชี D-Contact ถูกเปลี่ยน',
    title: 'รหัสผ่านของคุณถูกเปลี่ยน',
    intro: (at: string) => `รหัสผ่านของบัญชี D-Contact ถูกเปลี่ยนเมื่อ ${at}`,
    action: 'เปิดบัญชีของฉัน',
    warning: 'หากคุณไม่ได้เปลี่ยนเอง ให้ติดต่อผู้ดูแลระบบขององค์กรทันที',
  },
};
