<#ftl output_format="plainText">
<#--
  #522: ฉบับ plain text — ลิงก์อยู่บรรทัดของตัวเองเสมอ
  (invitationLinks ใน keycloak-test-support.ts อ่านลิงก์ action-token จาก Text ของอีเมล)
-->
${msg("dcInviteTitle")}

${msg("dcInviteIntro")}

<#if requiredActions??>
<#list requiredActions as action>
- ${msg("requiredAction.${action}")}
</#list>
</#if>

${msg("dcInviteAction")}:
${link}

${msg("dcInviteExpiry", linkExpirationFormatter(linkExpiration))}

${msg("dcInviteIgnore")}

--
${msg("dcEmailFooter")}
