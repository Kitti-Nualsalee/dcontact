<#ftl output_format="plainText">
<#--
  #522: plain text version — the link is always on its own line
  (invitationLinks in keycloak-test-support.ts reads the action-token link from the Text of the mail)
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
