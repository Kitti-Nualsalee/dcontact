/**
 * Tailwind preset ของ D-Contact
 *
 * เหตุที่ต้องมี: mockup เดิมมีสีอยู่สองแหล่ง — hex ใน app.css (62 ค่า) กับคลาส
 * ของ Tailwind (`bg-teal-700` 126 ครั้ง, `text-slate-400` 310 ครั้ง) ซึ่งเป็นค่า
 * เดียวกันแต่แก้คนละที่ preset นี้ทำให้คลาสของ Tailwind ชี้กลับมาที่ token ตัวเดียวกัน
 * ทั้ง `bg-surface-raised` และ `background: var(--dc-surface-raised)` จึงเป็นของสิ่งเดียวกัน
 *
 * การใช้ใน tailwind.config ของแต่ละแอป:
 *   presets: [require('@d-contact/ui/tailwind-preset')]
 *
 * palette เดิมของ Tailwind ถูกตัดออกโดยตั้งใจ (`colors` ถูกแทนที่ ไม่ใช่ขยาย)
 * เพื่อให้เขียน `text-slate-400` ไม่ได้อีก — ค่านั้นคือคู่สีที่ตก WCAG AA
 */
const color = (name) => `var(--dc-${name})`;

module.exports = {
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',

      surface: {
        page: color('surface-page'),
        raised: color('surface-raised'),
        sunken: color('surface-sunken'),
        hover: color('surface-hover'),
        selected: color('surface-selected'),
        inverse: color('surface-inverse'),
        brand: color('surface-brand'),
      },
      border: {
        subtle: color('border-subtle'),
        DEFAULT: color('border-default'),
        strong: color('border-strong'),
        brand: color('border-brand'),
      },
      text: {
        primary: color('text-primary'),
        secondary: color('text-secondary'),
        muted: color('text-muted'),
        disabled: color('text-disabled'),
        brand: color('text-brand'),
        'brand-strong': color('text-brand-strong'),
        'on-brand': color('text-on-brand'),
        'on-inverse': color('text-on-inverse'),
        'on-inverse-muted': color('text-on-inverse-muted'),
      },
      brand: {
        50: color('brand-50'),
        100: color('brand-100'),
        200: color('brand-200'),
        600: color('brand-600'),
        700: color('brand-700'),
        800: color('brand-800'),
        900: color('brand-900'),
      },

      /* severity — หนึ่งตระกูลต่อบทบาท */
      success: { bg: color('success-bg'), fg: color('success-fg'), solid: color('success-solid') },
      attention: {
        bg: color('attention-bg'),
        'bg-subtle': color('attention-bg-subtle'),
        fg: color('attention-fg'),
        'fg-strong': color('attention-fg-strong'),
        solid: color('attention-solid'),
        border: color('attention-border'),
      },
      critical: {
        bg: color('critical-bg'),
        'bg-subtle': color('critical-bg-subtle'),
        fg: color('critical-fg'),
        'fg-strong': color('critical-fg-strong'),
        solid: color('critical-solid'),
        border: color('critical-border'),
      },
      info: {
        bg: color('info-bg'),
        'bg-subtle': color('info-bg-subtle'),
        fg: color('info-fg'),
        solid: color('info-solid'),
      },
      neutral: { bg: color('neutral-bg'), fg: color('neutral-fg'), solid: color('neutral-solid') },
      accent: { bg: color('accent-bg'), fg: color('accent-fg'), solid: color('accent-solid') },

      /* identity — ห้ามยุบ ดูเหตุผลใน tokens.css */
      channel: {
        'voice-bg': color('channel-voice-bg'),
        'voice-fg': color('channel-voice-fg'),
        'webchat-bg': color('channel-webchat-bg'),
        'webchat-fg': color('channel-webchat-fg'),
        'line-bg': color('channel-line-bg'),
        'line-fg': color('channel-line-fg'),
        'facebook-bg': color('channel-facebook-bg'),
        'facebook-fg': color('channel-facebook-fg'),
        'whatsapp-bg': color('channel-whatsapp-bg'),
        'whatsapp-fg': color('channel-whatsapp-fg'),
        'email-bg': color('channel-email-bg'),
        'email-fg': color('channel-email-fg'),
      },
      party: {
        agent: color('party-agent'),
        contact: color('party-contact'),
        'contact-soft': color('party-contact-soft'),
        system: color('party-system'),
      },
    },

    /* type scale 7 ขั้นหลัก บวก 2 ขั้นสำหรับตัวเลขขนาดใหญ่
       ค่าเป็น rem บน root 16px จึงออกมาใกล้เคียงที่อนุมัติไว้ตอน root 18px */
    fontSize: {
      '2xs': ['0.6875rem', { lineHeight: '1.35' }],
      xs: ['0.75rem', { lineHeight: '1.35' }],
      sm: ['0.8125rem', { lineHeight: '1.5' }],
      base: ['0.875rem', { lineHeight: '1.5' }],
      md: ['1rem', { lineHeight: '1.5' }],
      lg: ['1.125rem', { lineHeight: '1.35' }],
      xl: ['1.25rem', { lineHeight: '1.15' }],
      metric: ['1.625rem', { lineHeight: '1.15' }],
      wallboard: ['2.75rem', { lineHeight: '1.1' }],
    },

    fontFamily: {
      sans: ['Inter', 'Noto Sans Thai', 'system-ui', '-apple-system', 'sans-serif'],
    },

    borderRadius: {
      none: '0',
      xs: 'var(--dc-radius-xs)',
      sm: 'var(--dc-radius-sm)',
      DEFAULT: 'var(--dc-radius-md)',
      md: 'var(--dc-radius-md)',
      lg: 'var(--dc-radius-lg)',
      xl: 'var(--dc-radius-xl)',
      full: 'var(--dc-radius-pill)',
    },

    extend: {
      /* scale ระยะห่างของ D-Contact ใช้ prefix `dc-` (เช่น `p-dc-5` = 12px) แทนการแทนที่
         spacing ของ Tailwind ทั้งชุด เพราะเลขขั้นไม่ตรงกัน (`p-2` ของ Tailwind = 8px
         แต่ `--dc-space-2` = 4px) ถ้าใช้ชื่อเดียวกันจะอ่านโค้ดผิดได้ง่าย
         ความสูงมาตรฐานตั้งชื่อตามบทบาท เช่น `h-control-md`, `h-row-table` */
      spacing: {
        ...Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`dc-${i + 1}`, `var(--dc-space-${i + 1})`]),
        ),
        'control-md': 'var(--dc-control-md)',
        'control-sm': 'var(--dc-control-sm)',
        'row-subnav': 'var(--dc-row-subnav)',
        'row-table': 'var(--dc-row-table)',
        'bar-top': 'var(--dc-bar-top)',
      },
      boxShadow: {
        card: 'var(--dc-shadow-card)',
        panel: 'var(--dc-shadow-panel)',
        floating: 'var(--dc-shadow-floating)',
        'ring-warning': 'var(--dc-ring-warning)',
        focus: 'var(--dc-focus-ring)',
      },
      transitionTimingFunction: { dc: 'var(--dc-ease)' },
      transitionDuration: { fast: 'var(--dc-duration-fast)', base: 'var(--dc-duration-base)' },
    },
  },
};
