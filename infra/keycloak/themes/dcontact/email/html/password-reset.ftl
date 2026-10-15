<#--
  AC6 (#599): อีเมลลืมรหัสผ่าน — layout เดียวกับอีเมลเชิญ
  ไม่แสดงชื่อ realm/ผู้ใช้/อีเมล; ลิงก์และอายุลิงก์เท่ากับ template ของ base
-->
<#import "template.ftl" as layout>
<@layout.emailLayout>
    <@layout.heading>${msg("dcResetTitle")}</@layout.heading>
    <@layout.paragraph>${msg("dcResetIntro")}</@layout.paragraph>
    <@layout.button href=link>${msg("dcResetAction")}</@layout.button>
    <@layout.note>${msg("dcResetExpiry", linkExpirationFormatter(linkExpiration))}</@layout.note>
    <@layout.note>${msg("dcResetIgnore")}</@layout.note>
    <@layout.note>${msg("dcInviteFallback")}<br><@layout.link href=link/></@layout.note>
</@layout.emailLayout>
