<#--
  #522: execute-actions mail (first admin invitation: verify email → set password → register TOTP)
  the content equals the base template: link, link lifetime and the action list — no username or email
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
