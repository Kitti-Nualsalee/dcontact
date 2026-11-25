<#--
  AC6 (#599): forgot-password mail — the same layout as the invitation mail
  does not show the realm/user/email; the link and link lifetime are the same as the base template
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
