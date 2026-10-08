<#--
  AC6 (#599): อีเมลยืนยันอีเมล (VERIFY_EMAIL ที่ส่งซ้ำ/ผู้ใช้กดส่งเอง) — layout เดียวกับอีเมลเชิญ
  ไม่แสดงชื่อ realm/ผู้ใช้/อีเมล; ลิงก์และอายุลิงก์เท่ากับ template ของ base
-->
<#import "template.ftl" as layout>
<@layout.emailLayout>
    <@layout.heading>${msg("dcVerifyTitle")}</@layout.heading>
    <@layout.paragraph>${msg("dcVerifyIntro")}</@layout.paragraph>
    <@layout.button href=link>${msg("dcVerifyAction")}</@layout.button>
    <@layout.note>${msg("dcVerifyExpiry", linkExpirationFormatter(linkExpiration))}</@layout.note>
    <@layout.note>${msg("dcVerifyIgnore")}</@layout.note>
    <@layout.note>${msg("dcInviteFallback")}<br><@layout.link href=link/></@layout.note>
</@layout.emailLayout>
