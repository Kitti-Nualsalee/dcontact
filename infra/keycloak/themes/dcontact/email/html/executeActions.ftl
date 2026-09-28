<#--
  #522: อีเมล execute-actions (คำเชิญ first admin: ยืนยันอีเมล → ตั้งรหัสผ่าน → ลงทะเบียน TOTP)
  ข้อมูลในอีเมลเท่ากับ template ของ base: ลิงก์, อายุลิงก์ และรายการ action — ไม่มีชื่อผู้ใช้หรืออีเมล
-->
<#import "template.ftl" as layout>
<#assign actions = []>
<#if requiredActions??>
    <#list requiredActions as action><#assign actions += [msg("requiredAction.${action}")]></#list>
</#if>
<@layout.emailLayout>
    <@layout.heading>${msg("dcInviteTitle")}</@layout.heading>
    <@layout.paragraph>${msg("dcInviteIntro")}</@layout.paragraph>
    <#if actions?has_content><@layout.steps items=actions/></#if>
    <@layout.button href=link>${msg("dcInviteAction")}</@layout.button>
    <@layout.note>${msg("dcInviteExpiry", linkExpirationFormatter(linkExpiration))}</@layout.note>
    <@layout.note>${msg("dcInviteIgnore")}</@layout.note>
    <@layout.note>${msg("dcInviteFallback")}<br><@layout.link href=link/></@layout.note>
</@layout.emailLayout>
